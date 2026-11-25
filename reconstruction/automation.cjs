'use strict';

const { ready, realPosition, runtimeMismatch, isPosition, distance, normalizeName, ignoredNames, isIgnored, activePokemon } = require('./engines/shared.cjs');
const { createWalkerEngine } = require('./engines/walker-engine.cjs');
const { createTargetEngine, nativeComboWaitMs } = require('./engines/target-engine.cjs');
const { createHealerEngine } = require('./engines/healer-engine.cjs');
const { createLureEngine, normalizeLuring } = require('./engines/lure-engine.cjs');
const { createConsumablesEngine } = require('./engines/consumables-engine.cjs');
const { encodeCommand } = require('./protocol.cjs');
const { mergeCreatureSnapshot } = require('../tools/creature_bridge.cjs');
const { createFrameAutomation } = require('./engines/frame-automation.cjs');

/* Tentativas de revive por combo (1 envio + 1 retry). */

function gateReason(snapshot) {
  const session = snapshot || {};
  if (session.paused || session.runtime?.paused) return 'paused';
  if (!session.online) return 'offline';
  if (session.stale) return 'stale';
  if (session.error) return 'error';
  if (session.authExpired) return 'auth-expired';
  const maxAgeMs = session.telemetry?.source === 'chain'
    ? Math.max(1000, Number(session.telemetry.intervalMs || 5000) * 2 + 1000)
    : 1000;
  if (Number(session.ageMs) > maxAgeMs) return 'stale-snapshot';
  const telemetry = session.telemetry;
  if (!telemetry) return 'no-telemetry';
  if (telemetry.nativeVerified !== true) return 'native-unverified';
  if (telemetry.pulseVersion !== 3) return 'pulse-version';
  /* Sentinela nao e' coordenada: (0,0,0) no menu/leitura falha e
   * (65535,65535,255) em transicao. Reaproveita o motivo `no-position`, que o
   * spec ja declara. */
  if (!realPosition(telemetry.position)) return 'no-position';
  if (runtimeMismatch(session)) return 'runtime-pid';
  /* Gate do runtime (adendo 6): `false` = personagem no menu, sem mapa ativo.
   * `Game::walk` executa e nao move ninguem; ataque recusa com gate[+0x2668]=0.
   * `undefined` = DLL antiga sem o campo: nao bloqueia. */
  if (session.runtimeReady === false || telemetry.runtimeReady === false) return 'runtime-not-ready';
  return null;
}

function createRecorder() {
  const events = [];
  return {
    events,
    command(name, parameter, extra) {
      events.push({ name, parameter, ...(extra === undefined ? {} : { extra }) });
    },
  };
}

function createProtocolSink(send, firstCommandId = 1) {
  if (typeof send !== 'function') throw Error('Envie uma funcao send(bytes) para o transporte.');
  let commandId = Number.isInteger(firstCommandId) && firstCommandId > 0 ? firstCommandId : 1;
  return {
    command(name, parameter, extra) {
      const bytes = encodeCommand(commandId, name, parameter, extra);
      commandId = (commandId + 1) >>> 0;
      if (commandId === 0) commandId = 1;
      send(bytes);
      return bytes;
    },
    get nextCommandId() { return commandId; },
  };
}

function createAutomation(config, options = {}) {
  const enabled = typeof options.isEnabled === 'function' ? options.isEnabled : () => true;
  const hunt = options.hunt;
  const healBelow = hunt?.healBelow ?? 80;
  const resumeAbove = hunt?.resumeAbove ?? healBelow;
  if (hunt && (!Number.isFinite(healBelow) || !Number.isFinite(resumeAbove)
      || healBelow < 0 || resumeAbove < healBelow || resumeAbove >= 100)) {
    throw Error('Hunt exige 0 <= healBelow <= resumeAbove < 100.');
  }
  if (hunt && (!Number.isFinite(config?.target?.maxDistance) || config.target.maxDistance < 0)) {
    throw Error('Hunt exige target.maxDistance finito e nao negativo.');
  }
  const engineSettings = hunt ? { ...config,
    target: { ...config.target, healSkill: { enabled: false }, lureSkill: { enabled: false } },
    hoenn: { ...config.hoenn, perfectLure: false, minWildsToEngage: 0 },
  } : config;
  const clock = typeof options.now === 'function' ? options.now : () => Date.now();
  const walker = createWalkerEngine(config, { stepPlanner: options.stepPlanner });
  const target = createTargetEngine(engineSettings);
  const healer = createHealerEngine(hunt ? { ...config,
    hoenn: { ...config.hoenn, potionHpPercent: Number(config.hoenn?.potionHpPercent) > 0 ? resumeAbove : 0 },
    healer: { ...config.healer, healHpPercent: Number(config.healer?.healHpPercent) > 0 ? resumeAbove : 0 },
  } : config, { switchBeforeHeal: Boolean(hunt) });
  const lure = createLureEngine(config, options);
  const consumables = createConsumablesEngine(config);
  const state = { ticks: 0, last: null, lastHotkeyAt: null, recovering: false, revive: null, reviveHandledAt: null };

  /* ─── CONTEXTO DE LURE PARA O TARGET ───
   *
   * BUG CORRIGIDO (auditoria G01, defeito B.4): aqui ia
   *     luring: config?.target?.luring?.enabled === true
   * mas `lure-engine` deriva o modo por PRECEDENCIA:
   *     randomEnabled → 'random' | frontEnabled → 'dynamic'
   *     enabled → 'distance'     | senao → 'off'
   * Com `frontEnabled: true` e `enabled: false` (a config real) o lure roda
   * em 'dynamic' e o Target recebia `luring: false` — entao `lureSkill`
   * (buff ao lurar) nunca era emitido pelo caminho nativo.
   *
   * SEMANTICA ESCOLHIDA: o contexto significa MODO DE LURE CONFIGURADO (o
   * modelo/fase que o motor vai executar), nao a fase do tick corrente.
   * Evidencia:
   *   1. `lureSkill` vem de `m()` no schema do fornecedor, que o rotula
   *      "Buff ao lurar" — o buff acompanha o MODO ativo, nao uma fase.
   *   2. `normalizeLuring()` (lure-engine.cjs:28) e' a fonte unica do modo e
   *      e' PURA: nao emite, nao consome cooldown, nao muda `state`.
   *   3. A ordem do tick impede ler a fase: `target.step` roda (linha ~213)
   *      ANTES de `lure.step` (~224). Passar a fase exigiria antecipar os
   *      efeitos do lure so' para descobrir o estado — proibido pela missao.
   *
   * Portanto: derivar o modo com a MESMA funcao que o lure usa, e considerar
   * "lurando" quando o modo nao e' 'off'. Isso preserva a precedencia
   * random > dynamic > distance sem duplicar a regra. */
  const lureMode = normalizeLuring(config).mode;
  const lureActive = lureMode !== 'off';

  function blocked(reason, error) {
    target.clearTarget();
    state.last = { status: 'blocked', reason, emitted: [], ...(hunt ? { pauseWalker: true } : {}),
      ...(error ? { error } : {}) };
    return state.last;
  }

  function reviveStep(telemetry, output, now) {
    const revive = config.target?.autoRevive;
    if (!enabled('target') || revive?.enabled !== true || typeof revive.hotkey !== 'string' || !revive.hotkey.trim()) {
      state.revive = null;
      return null;
    }
    const rotation = target.state;
    const completedAt = rotation.comboCompletedAt;
    /* Um revive por combo. `reviveHandledAt` guarda o combo ja' tratado; sem
     * isso o estado era limpo logo apos o envio, `comboCompletedAt` continuava
     * valendo e o revive rearmava a cada tick (spam de F). */
    if (!state.revive && completedAt !== null && completedAt !== state.reviveHandledAt) {
      const configured = Number.isFinite(revive.interval) && revive.interval >= 0 ? revive.interval : 1500;
      const combo = config.target?.combo;
      const native = combo?.useNativeSequence === true;
      /* No combo nativo o jogo executa a sequencia: `comboCompletedAt` e'
       * marcado no ENVIO do hotkey, nao no fim. Esperar so' o intervalo (200 ms
       * numa auditoria) mandava o Revive no meio do combo. `comboFallbackMs`
       * e' o piso medido para "combo sem resposta" no Shiba. */
      const interval = native
        ? Math.max(configured, nativeComboWaitMs(combo, config.hoenn))
        : configured;
      state.revive = { pokemonName: rotation.comboPokemonName, sentAt: null, sentTick: null,
        interval, completedAt, nextSendAt: now + interval };
    }
    if (!state.revive) return null;
    const pending = state.revive;
    const emitted = [];

    const finish = () => {
      state.revive = null;
      state.reviveHandledAt = completedAt;
      target.finishCombo(telemetry);
    };

    if (pending.sentAt === null) {
      /* O ultimo skill pode ser despachado DEPOIS do armamento; nesse caso o
       * prazo conta do novo despacho. */
      if (completedAt !== null && completedAt !== pending.completedAt) {
        pending.completedAt = completedAt;
        pending.nextSendAt = completedAt + pending.interval;
      }
      const hotkeysBlocked = (state.lastHotkeyAt !== null && now - state.lastHotkeyAt < 250)
        || options.hotkeysBlocked?.() === true;
      if (now < pending.nextSendAt || hotkeysBlocked) {
        return { status: 'revive', pauseWalker: true, emitted, reason: 'await-revive-interval' };
      }
      output.command('hotkey', revive.hotkey.trim());
      emitted.push(['hotkey', revive.hotkey.trim()]);
      pending.sentAt = now;
      pending.sentTick = telemetry.tick;
      return { status: 'revive', pauseWalker: true, emitted, reason: 'revive-sent' };
    }

    const configuredTimeout = config.hoenn?.pokeReadyTimeoutMs;
    const timeout = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 3000;
    const active = activePokemon(telemetry, pending.pokemonName);
    const own = telemetry.ownPokemon;
    const hp = own?.healthPercent ?? active?.healthPercent ?? telemetry.healthPercent;
    const observed = !Number.isInteger(pending.sentTick) || telemetry.tick > pending.sentTick;
    const ownMatches = !own?.name || normalizeName(own.name) === normalizeName(pending.pokemonName);
    const confirmed = observed && Boolean(active) && ownMatches && Number.isFinite(hp) && hp > 0 && hp <= 100;


    /* Sem waitForPokemon o Shiba segue logo apos o clique: basta um tick. */
    if (revive.waitForPokemon !== true) {
      finish();
      return null;
    }
    if (confirmed) {
      finish();
      return null;
    }

    /* Sem confirmacao: espera o timeout. Nao reenvia antes dele — era assim
     * que o revive virava rajada. */
    if (now - pending.sentAt < timeout) {
      return { status: 'revive', pauseWalker: true, emitted, reason: 'await-active-pokemon' };
    }
    finish();
    return { status: 'revive', pauseWalker: true, emitted, reason: 'revive-timeout', effectVerified: false };
  }

  function huntStep(telemetry, output, now, hotkeysBlocked, beforeActions) {
    const health = telemetry.healthPercent;
    if (!Number.isFinite(health) || health <= 0 || health > 100) return blocked('invalid-health');
    if (!isPosition(telemetry.position) || !Array.isArray(telemetry.creatures)) return blocked('invalid-perception');
    const ignored = new Set([...ignoredNames(config.target?.ignoredCreaturesText),
      ...ignoredNames(config.hoenn?.ignoredCreaturesText)]);
    for (const creature of telemetry.creatures) {
      if (!creature || !isPosition(creature.pos)) return blocked('invalid-creature');
      if (creature.is_player === true || normalizeName(creature.name) === normalizeName(telemetry.playerName)
          || isIgnored(creature.name, ignored) || creature.canAttack === false
          || creature.healthPercent === 0 || distance(telemetry.position, creature.pos) > config.target.maxDistance) continue;
      if (typeof creature.canAttack !== 'boolean' || !Number.isFinite(creature.healthPercent)
          || creature.healthPercent < 0 || creature.healthPercent > 100
          || !Number.isInteger(creature.id) || creature.id <= 0 || creature.id > 0xffffffff
          || typeof creature.name !== 'string' || !creature.name.trim()) return blocked('unknown-creature-fields');
    }
    const pendingRevive = reviveStep(telemetry, output, now);
    if (pendingRevive) return pendingRevive;
    const detected = target.inspect(telemetry).length;
    if (detected) {
      const capture = beforeActions?.(telemetry, true);
      if (capture) return capture;
      const fight = target.step(telemetry, output, now, { hotkeysBlocked });
      const revive = reviveStep(telemetry, output, now);
      if (revive) return { ...revive, detected, fight, emitted: [...fight.emitted, ...revive.emitted] };
      if (fight.reason === 'combo-done') target.finishCombo(telemetry);
      if (fight.reason === 'finish-remaining') {
        const walk = walker.step(telemetry, output, now);
        return { status: 'walking', pauseWalker: false, detected, walk, emitted: walk.emitted, reason: fight.reason };
      }
      return { status: 'combat', pauseWalker: true, detected, fight, emitted: fight.emitted, reason: fight.reason || null };
    }
    target.clearTarget();

    if (health <= healBelow) state.recovering = true;
    if (state.recovering && health > resumeAbove) state.recovering = false;
    const returnPending = typeof config.healer?.returnPokemonName === 'string'
      && config.healer.returnPokemonName.trim()
      && normalizeName(config.healer.returnPokemonName) !== normalizeName(telemetry.pokemonName);
    const heal = hotkeysBlocked || !(state.recovering || healer.state.healing || returnPending)
      ? { emitted: [], blocked: [] } : healer.step(telemetry, output, now);
    if (state.recovering || heal.emitted.length || heal.waiting || healer.state.healing || returnPending) {
      return { status: 'heal', pauseWalker: true, detected, emitted: heal.emitted,
        blocked: heal.blocked, reason: state.recovering ? 'await-health-recovery' : 'healer-cleanup' };
    }
    const capture = beforeActions?.(telemetry, false);
    if (capture) return capture;
    const walk = walker.step(telemetry, output, now);
    return { status: 'walking', pauseWalker: false, detected, walk, emitted: walk.emitted, reason: walk.reason || null };
  }

  function tick(snapshot, sink = createRecorder(), beforeActions) {
    const reason = gateReason(snapshot);
    if (reason) {
      return blocked(reason);
    }
    const now = clock(snapshot);
    if (!Number.isFinite(now)) {
      return blocked('invalid-clock');
    }
    try {
      /* `creaturesAvailable` booleano e' contrato explicito: o adapter e' a
       * fonte de verdade e nenhuma fonte suplementar pode ser consultada.
       * Sem esta guarda, `creatureSource` era chamado mesmo com o frame
       * dizendo "eu ja' sei", e o teste de contrato acusava. */
      const scan = typeof snapshot.telemetry.creaturesAvailable === 'boolean' ? undefined
        : typeof options.creatureSource === 'function'
          ? options.creatureSource(snapshot) : snapshot.creatureSnapshot;
      if (typeof snapshot.telemetry.creaturesAvailable !== 'boolean'
          && (scan !== undefined || typeof options.creatureSource === 'function')) {
        snapshot = mergeCreatureSnapshot(snapshot, scan, now, options.creatureMaxAgeMs ?? 1000);
      }
    } catch (error) {
      return blocked('creature-snapshot', error.message);
    }
    const telemetry = snapshot.telemetry;
    state.creaturesAvailable = telemetry.creaturesAvailable ?? null;
    const hotkeysBlocked = (state.lastHotkeyAt !== null && now - state.lastHotkeyAt < 250)
      || options.hotkeysBlocked?.() === true;
    const output = { command(name, parameter, extra) {
      const result = sink.command(name, parameter, extra);
      if (name === 'hotkey') state.lastHotkeyAt = now;
      return result;
    } };
    state.ticks += 1;
    /* Sem lista de criaturas o combate fica cego: nao da' para escolher alvo,
     * entao o walker assume e `detected` e' `null` (desconhecido), nunca 0 —
     * zero significaria "olhei e nao havia nenhuma". */
    if (telemetry.creaturesAvailable === false) {
      target.clearTarget();
      const walk = enabled('walker') ? walker.step({ ...telemetry, creatures: [], wildCount: null }, output, now)
        : { action: 'disabled', emitted: [] };
      state.last = { status: enabled('walker') ? 'walking' : 'idle', walk, emitted: walk.emitted,
        blocked: [], detected: null, creaturesAvailable: false, reason: 'creatures-unavailable' };
      return state.last;
    }
    /* Consumíveis antes de cura/combate: são agendados por tempo e um hotkey
     * por tick. Se um venceu, ele ocupa o tick. */
    const consumable = consumables.step(now, output);
    if (consumable.emitted.length) {
      state.last = { status: 'consumable', reason: null, emitted: consumable.emitted, blocked: [] };
      return state.last;
    }
    if (hunt) {
      state.last = huntStep(telemetry, output, now, hotkeysBlocked, beforeActions);
      return state.last;
    }
    const pendingRevive = reviveStep(telemetry, output, now);
    if (pendingRevive) {
      state.last = pendingRevive;
      return state.last;
    }
    const heal = hotkeysBlocked || !enabled('healer') ? { emitted: [], blocked: [] } : healer.step(telemetry, output, now);
    if (heal.emitted.length || heal.waiting || (enabled('healer') && healer.state.healing)) {
      state.last = { status: 'heal', reason: null, emitted: heal.emitted, blocked: heal.blocked };
      return state.last;
    }
    const capture = beforeActions?.(telemetry, target.inspect(telemetry).length > 0);
    if (capture) { state.last = capture; return capture; }
    if (!enabled('target')) target.clearTarget();
    const fight = !enabled('target') ? { action: 'idle', emitted: [] } : target.step(telemetry, output, now, {
      luring: lureActive, hotkeysBlocked,
    });
    const revive = reviveStep(telemetry, output, now);
    if (revive) {
      state.last = { ...revive, fight, emitted: [...fight.emitted, ...revive.emitted] };
      return state.last;
    }
    if (fight.reason === 'combo-done') target.finishCombo(telemetry);
    let walk = { action: 'skipped', emitted: [] };
    let lureResult = { allowMovement: true, state: 'off', emitted: [] };
    if (fight.action === 'idle' || fight.action === 'luring') {
      if (enabled('target')) lureResult = lure.step(telemetry, output, now);
      if (!enabled('walker')) walk = { action: 'disabled', emitted: [] };
      else if (lureResult.allowMovement) walk = walker.step(telemetry, output, now);
      else {
        walker.notifySkipped();
        walk = { action: 'held', emitted: [], reason: 'lure-hold' };
      }
    }
    state.last = {
      status: fight.action === 'idle' && !enabled('walker') ? 'idle'
        : fight.action === 'luring' ? (lureResult.allowMovement ? 'luring' : 'lure-hold') : fight.action === 'idle' ? (lureResult.allowMovement ? 'walking' : 'lure-hold') : 'combat',
      fight, walk, lure: { state: lureResult.state, allowMovement: lureResult.allowMovement, range: lureResult.range ?? null },
      emitted: [...heal.emitted, ...fight.emitted, ...(lureResult.emitted || []), ...(walk.emitted || [])],
      blocked: [...new Set([...(heal.blocked || []), ...(fight.blocked || [])])],
      reason: fight.action === 'idle' || fight.action === 'luring' ? walk.reason || fight.reason || null : fight.reason || null,
    };
    return state.last;
  }

  return {
    tick,
    recordAttackDelivery: target.recordAttackDelivery,
    recordDispatch(name, parameter, timestamp) {
      if (name === 'hotkey') {
        state.lastHotkeyAt = timestamp;
        if (state.revive && state.revive.sentAt !== null && parameter === config.target?.autoRevive?.hotkey?.trim()) {
          state.revive.sentAt = timestamp;
        }
      }
      target.recordDispatch(name, parameter, timestamp);
    },
    reset() {
      walker.reset(); target.reset(); healer.reset(); lure.reset(); consumables.reset();
      state.ticks = 0; state.last = null; state.lastHotkeyAt = null; state.recovering = false; state.revive = null; state.reviveHandledAt = null;
    },
    walker,
    get state() { return { ticks: state.ticks, creaturesAvailable: state.creaturesAvailable ?? null,
      walker: walker.state, target: target.state, healer: healer.state, lure: lure.state,
      consumables: consumables.state, revive: state.revive }; },
    get last() { return state.last; },
  };
}

/* Replay de uma sequencia de frames pelo frame-automation.
 *
 * Caminho paralelo ao `tick` de producao: aqui o walker e' descartavel e o
 * chamador nao despacha nada — serve para exercitar a decisao sem adapter.
 * Recriado apos a remocao acidental; `EngineRuntime.replay` e os testes de
 * contrato (frame_runtime_replay, blind_offline_contract) dependem dele.
 */
function replayFrameSequence(config, samples) {
  if (!Array.isArray(samples)) throw TypeError('Expected an array of timestamped snapshots');
  const automation = createFrameAutomation(config);
  const walker = createWalkerEngine(config);
  let boxWalker = null, box = null;
  return samples.map(({ snapshot, now }) => {
    const decision = automation.tick(snapshot, now);
    if (decision.phase === 'session-changed') walker.reset();
    if (decision.phase !== 'force-box' && decision.phase !== 'await-frame') { boxWalker = null; box = null; }
    if (!decision.allowMovement) {
      if (decision.phase !== 'await-frame') walker.notifySkipped();
    } else {
      const raw = snapshot.telemetry;
      let activeWalker = walker;
      if (decision.phase === 'force-box') {
        walker.notifySkipped();
        if (box !== decision.waypoint) {
          box = decision.waypoint;
          boxWalker = createWalkerEngine({ walker: { ...config.walker, loop: false, waypoints: [box] } });
        }
        activeWalker = boxWalker;
      }
      decision.walk = activeWalker.step({ ...raw, position: raw.player?.pos ?? raw.position,
        playerId: raw.player?.id, tick: raw.seq ?? raw.tick }, {
        command(name, parameter) { decision.orders.push({ name, parameter }); },
      }, now);
    }
    decision.orders = decision.orders.map(order => {
      if (order.name === 'attack') return { name: 'attack', parameter: { pos: order.parameter } };
      if (order.name !== 'capture') return order;
      return { name: 'capture', parameter: {
        x: order.parameter.pos.x, y: order.parameter.pos.y, ball: order.parameter.ballKey ?? order.parameter.ballSlot,
      } };
    });
    return decision;
  });
}

module.exports = { createAutomation, createRecorder, createProtocolSink, gateReason,
  createFrameAutomation, replayFrameSequence };
module.exports.createBlindReplay = require('./telemetry/walker-replay.cjs').createWalkerReplay;
