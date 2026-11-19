'use strict';

const { ignoredNames, normalizeName, isIgnored, parseSequence, Cooldown } = require('./shared.cjs');
const TargetEngine = require('../../target-engine.cjs');

const { DEFAULT_GLOBAL_COOLDOWN_MS } = TargetEngine;
const ATTACK_RETRY_MS = 300;
const ATTACK_EFFECT_WINDOW_MS = 2000;
const TARGET_RETRY_DELAY_MS = 4000;
const SKILL_RETRY_MS = 300;
/* PokeStop: manda o Pokemon ficar parado na box para os monstros chegarem.
 *
 * MEDIDO no Shiba (`native/pka_tap_572.jsonl`, 351,8 MB):
 *   - ordem real: Best Tile -> Aguardando PokeStop -> Perfect lure -> AutoCombo
 *   - `PokeStop sem confirmacao apos quatro tentativas` x336.531
 *   - fase `Aguardando confirmacao de PokeStop` dura 1.375 ms de mediana
 *
 * Ele tenta 4x e SEGUE o fluxo mesmo sem confirmacao — nao trava a hunt por
 * causa do pokestop. `combo.usePokeStop === true` na config real. */
const POKESTOP_TEXT = '!pokestop';
const POKESTOP_ATTEMPTS = 4;
const POKESTOP_RETRY_MS = 400;

function nativeComboWaitMs(combo, hoenn) {
  const fallback = hoenn?.comboFallbackMs;
  return Math.max(Number(combo?.stepDelay) || 0,
    Number.isFinite(fallback) && fallback > 0 ? fallback : 3000);
}

function rosterUuid(telemetry, name) {
  const slot = Number(telemetry.activeSlot);
  const roster = Array.isArray(telemetry.roster) ? telemetry.roster : [];
  if (Number.isInteger(slot) && slot >= 1 && slot <= roster.length) {
    const entry = roster.find(item => item.slot === slot);
    if (entry && typeof entry.uuid === 'string' && entry.uuid) return entry.uuid;
  }
  if (name) {
    const wanted = normalizeName(name);
    const matches = roster.filter(item => normalizeName(item.name) === wanted);
    if (matches.length === 1 && typeof matches[0].uuid === 'string' && matches[0].uuid) return matches[0].uuid;
  }
  return undefined;
}

function isShiny(creature) {
  if (creature.shinyIcon === 1) return true;
  if (Number.isInteger(creature.lookType) && Number.isInteger(creature.shinyLookType) && creature.shinyLookType !== creature.normalLookType) {
    return creature.lookType === creature.shinyLookType;
  }
  return false;
}

function findMatchingRule(name, rules) {
  if (!name || !Array.isArray(rules) || !rules.length) return null;
  const cleanName = String(name).trim().toLowerCase();
  for (const rule of rules) {
    if (!rule || typeof rule !== "object") continue;
    const pattern = (rule.name || "*").trim().toLowerCase();
    if (pattern === "*" || pattern === cleanName) return rule;
    if (pattern.startsWith("*") && cleanName.endsWith(pattern.slice(1))) return rule;
    if (pattern.endsWith("*") && cleanName.startsWith(pattern.slice(0, -1))) return rule;
  }
  return null;
}

function chebyshev(a, b) {
  if (!a || !b || !Number.isFinite(a.x) || !Number.isFinite(a.y)
      || !Number.isFinite(b.x) || !Number.isFinite(b.y)) return Infinity;
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

// O Min Count e o alcance da regra contam a partir do Pokemon (summon) quando a
// posicao dele e conhecida; sem ela, cai para o treinador.
function referencePoint(telemetry, player) {
  const pet = telemetry?.ownPokemon?.pos;
  return pet && Number.isFinite(pet.x) && Number.isFinite(pet.y) ? pet : player;
}

function ruleRange(rule, fallback) {
  return Number.isFinite(rule?.range) && rule.range > 0 ? rule.range : fallback;
}

// Aceita tanto a forma do schema ({name, range, minCount}) quanto a forma
// abreviada usada pelo motor puro (['*']).
function matchingRules(monsters, fallbackRange) {
  const list = Array.isArray(monsters) && monsters.length ? monsters : ['*'];
  return list.map((entry, index) => {
    if (typeof entry === 'string') {
      return { name: entry, priority: index, range: fallbackRange, minCount: 1 };
    }
    if (!entry || typeof entry !== 'object') return null;
    return {
      name: typeof entry.name === 'string' && entry.name.trim() ? entry.name : '*',
      priority: Number.isFinite(entry.priority) ? entry.priority : index,
      range: ruleRange(entry, fallbackRange),
      minCount: Number.isInteger(entry.minCount) && entry.minCount > 0 ? entry.minCount : 1,
    };
  }).filter(Boolean);
}

function checkMinCountMet(pool, rules, minWilds = 0) {
  if (!pool.length) return false;
  if (!Array.isArray(rules) || !rules.length) return true;

  const hasExplicitMinCount = rules.some(r => Number.isInteger(r?.minCount) && r.minCount > 1);
  if (!hasExplicitMinCount) return minWilds <= 0;

  const countByRule = new Map();
  for (const creature of pool) {
    const rule = findMatchingRule(creature.name, rules);
    if (rule) {
      const current = countByRule.get(rule) || 0;
      countByRule.set(rule, current + 1);
    }
  }

  for (const [rule, count] of countByRule.entries()) {
    const required = Number.isInteger(rule.minCount) && rule.minCount > 0 ? rule.minCount : 1;
    if (count >= required) return true;
  }

  return false;
}

function createTargetEngine(config, options = {}) {
  const target = config?.target || {};
  const hoenn = config?.hoenn || {};
  const combo = target.combo || {};
  const comboEnabled = combo.enabled === true;
  const ignored = new Set([...ignoredNames(target.ignoredCreaturesText), ...ignoredNames(hoenn.ignoredCreaturesText)]);
  const minWilds = Number.isInteger(hoenn.minWildsToEngage) ? hoenn.minWildsToEngage : 0;
  const perfectLure = hoenn.perfectLure === true && hoenn.forceBox !== true;
  const perfectingLureEnabled = combo.perfectingLureEnabled === true || perfectLure;
  const state = {
    targetId: null, attackAt: new Cooldown(), attackDispatched: false, targetSince: null,
    attackObservation: null, deferredTargets: new Map(),
    comboIndex: 0, comboAt: new Cooldown(), comboCompletedAt: null,
    medicineAt: new Cooldown(), medicinePrepared: false, finishing: null,
    pokeStopTries: 0, pokeStopAt: new Cooldown(), comboPokemonName: null, lastSkillCommand: null, rotationKeys: new Set(),
    bestTileSince: null, bestTileDone: false, bestTileTries: 0, bestTileAt: new Cooldown(),
    healAt: new Cooldown(), lureAt: new Cooldown(), blocked: new Set(),
  };
  let tickNow = 0;
  let engine = new TargetEngine({}, { now: () => tickNow });

  function engineConfig() {
    const gcd = target.globalCooldownMs;
    const rows = Array.isArray(target.monsters) ? target.monsters.filter(row => row && typeof row === 'object') : [];
    return {
      ...target,
      maxDistance: target.maxDistance ?? (rows.length ? Math.max(...rows.map(row => Number.isFinite(row.range) ? row.range : 8)) : 8),
      priorityMode: target.priorityMode ?? (rows.length ? 'highestPriorityList' : 'nearest'),
      monsters: Array.isArray(target.monsters) && target.monsters.length === 0 ? ['*'] : target.monsters,
      globalCooldownMs: gcd === undefined ? DEFAULT_GLOBAL_COOLDOWN_MS
        : Number.isFinite(gcd) && gcd >= 0 ? Math.max(DEFAULT_GLOBAL_COOLDOWN_MS, gcd) : gcd,
      skills: Array.isArray(target.skills) ? target.skills.filter(skill => skill
        && typeof skill.key === 'string' && /^f(?:[1-9]|1[0-2])$/iu.test(skill.key.trim())) : [],
    };
  }

  function wilds(telemetry) {
    const ownId = telemetry?.ownPokemon?.id;
    return (Array.isArray(telemetry?.creatures) ? telemetry.creatures : [])
      .filter(creature => creature && creature.canAttack === true
        && Number.isInteger(creature.id) && creature.id > 0 && creature.id <= 0xffffffff
        && creature.creatureType !== 3 && creature.isOwnPokemon !== true
        && creature.creatureType !== 0 && creature.is_player !== true
        && (ownId === undefined || creature.id !== ownId))
      .filter(creature => !isIgnored(creature.name, ignored));
  }

  function candidates(telemetry, player, settings) {
    return engine.filterCandidates(player, wilds(telemetry), settings);
  }

  function finishCombo(telemetry) {
    const remaining = candidates(telemetry, telemetry.position, engineConfig());
    const finishCount = Number(combo.finishRemainingCount ?? 0);
    if (remaining.length <= finishCount && (combo.finishIgnoreShiny === true || !remaining.some(isShiny))) {
      clearTarget();
      state.finishing = new Set(remaining.map(creature => creature.id));
      return true;
    }
    restartCombo();
    return false;
  }

  function choose(player, pool, settings, ownPos) {
    const shiny = target.shinyPriorityEnabled === true ? pool.filter(isShiny) : [];
    const base = shiny.length ? shiny : pool;
    if (ownPos && base.some(c => !(c.pos && c.pos.x === ownPos.x && c.pos.y === ownPos.y && c.pos.z === ownPos.z))) {
      const nonOverlapping = base.filter(c => !(c.pos && c.pos.x === ownPos.x && c.pos.y === ownPos.y && c.pos.z === ownPos.z));
      return engine.selectTarget(player, nonOverlapping, settings);
    }
    return engine.selectTarget(player, base, settings);
  }

  function restartCombo() {
    state.medicinePrepared = false;
    state.comboIndex = 0;
    state.comboCompletedAt = null;
    state.comboPokemonName = null;
    state.lastSkillCommand = null;
    state.rotationKeys.clear();
    state.comboAt.reset();
    /* Novo ciclo de combo = novas tentativas de PokeStop. Sem zerar aqui, as 4
     * tentativas do primeiro alvo esgotariam para o resto da sessao. */
    state.pokeStopTries = 0;
    state.pokeStopAt.reset();
    /* Best Tile tambem e' por ciclo de combo: o teto de espera recomeca a cada
     * alvo novo, senao o primeiro alvo gastaria o prazo para a sessao inteira. */
    state.bestTileSince = null;
    state.bestTileDone = false;
    state.bestTileTries = 0;
    state.bestTileAt.reset();
  }

  function clearTarget() {
    engine.clearTarget();
    state.targetId = null;
    state.attackDispatched = false;
    state.attackObservation = null;
    state.deferredTargets.clear();
    state.finishing = null;
    restartCombo();
  }

  function observeAttack(telemetry, pool, now) {
    const observation = state.attackObservation;
    if (!observation) return;
    const creature = pool.find(candidate => candidate.id === observation.id);
    if (!creature || telemetry.playerId !== observation.playerId
        || observation.lastTick - telemetry.tick >= 1000) {
      state.attackObservation = null;
      return;
    }
    const hp = creature.healthPercent;
    if (telemetry.creaturesStale === true || !Number.isInteger(telemetry.tick)
        || telemetry.tick <= observation.lastTick
        || !Number.isFinite(hp) || hp < 0 || hp > 100) return;
    if (hp < observation.hp) {
      state.attackObservation = null;
      return;
    }
    observation.hp = hp;
    observation.lastTick = telemetry.tick;
    observation.samples += 1;
    if (observation.samples >= 2 && now - observation.deliveredAt >= ATTACK_EFFECT_WINDOW_MS) {
      state.deferredTargets.set(observation.id, now + TARGET_RETRY_DELAY_MS);
      state.attackObservation = null;
    }
  }

  function recordAttackDelivery(id, telemetry, deliveredAt) {
    const hp = telemetry.creatures?.find(creature => creature.id === id)?.healthPercent;
    if (id !== state.targetId || state.attackObservation?.id === id
        || telemetry.creaturesStale === true || !Number.isInteger(telemetry.tick)
        || !Number.isFinite(hp) || hp <= 0 || hp > 100) return;
    state.attackObservation = {
      id, hp, playerId: telemetry.playerId, lastTick: telemetry.tick, deliveredAt, samples: 0,
    };
  }

  /**
   * Sequencia de skills do combo.
   *
   * DOIS MODOS, e a distincao e' de CONTRATO (coberta por
   * tests/combat_fields.test.cjs):
   *
   *   useNativeSequence === true
   *     O JOGO executa o combo. O bot manda `combo '!autocombo'` e nao deve
   *     enumerar skills — enumerar seria executar a sequencia manual que a UI
   *     esconde no modo nativo. Se a telemetria trouxer `nativeSequence`, ele
   *     e' usado SO' para conferir/registrar, nunca como fonte de envio.
   *
   *     MEDIDO na captura do Shiba (`pka_tap_572.jsonl`, 256 MB): o
   *     fornecedor manda `combo '!autocombo'` e o interpretador do jogo
   *     (`exe+0x67fbf0`) resolve a sequencia a partir da config do runtime.
   *     `telemetry.nativeSequence` NUNCA apareceu (0 amostras) — o campo
   *     existe no contrato mas o fornecedor nao o publica.
   *
   *   useNativeSequence === false
   *     O BOT executa o combo, uma skill por vez. A fonte e' o roster do
   *     Pokemon ativo (cada Pokemon tem moves proprios: Diglett
   *     m5,m6,m3,m4,m1,m2; Squirtle m1..m7; Weedle so' m1,m2,m3) e, na
   *     falta dele, `combo.sequenceText`.
   *
   * Devolve `null` para sinalizar "modo nativo, nao enumerar".
   */
  function sequence(telemetry) {
    if (combo.useNativeSequence === true) {
      /* Se o jogo publicar `nativeSequence`, ele manda: e' a sequencia que o
       * runtime vai executar, e enumerar outra seria divergir dele.
       * MEDIDO: o fornecedor nao publica esse campo (0 amostras em 1171
       * frames de kind5 do pka_tap_572). Entao na pratica cai no `null`
       * abaixo e o bot manda `!autocombo`. */
      const nativo = (Array.isArray(telemetry.nativeSequence) ? telemetry.nativeSequence : [])
        .filter(value => typeof value === 'string' && /^m[1-9]\d*$/u.test(value));
      return nativo.length ? nativo : null;
    }
    const doRoster = movesDoPokemonAtivo(telemetry);
    if (doRoster.length) return doRoster;
    return parseSequence(combo.sequenceText);
  }

  /**
   * Move do slot ativo do roster. Devolve [] quando o roster nao cobre o
   * Pokemon atual — nunca chuta.
   *
   * O roster do Shiba traz `slot` 1..6 e `moves[].spellword`; o `activeSlot`
   * diz qual e' o atual. Casamos por slot quando ambos existem; senao, por
   * nome (o roster tambem traz `name`).
   */
  function movesDoPokemonAtivo(telemetry) {
    const roster = Array.isArray(telemetry?.roster) ? telemetry.roster : [];
    if (!roster.length) return [];
    const slot = Number.isInteger(telemetry.activeSlot) ? telemetry.activeSlot : null;
    const nome = normalizeName(telemetry.pokemonName);

    let entrada = null;
    if (slot !== null) entrada = roster.find(r => r && r.slot === slot) || null;
    if (!entrada && nome) entrada = roster.find(r => r && normalizeName(r.name) === nome) || null;
    if (!entrada || !Array.isArray(entrada.moves)) return [];

    return entrada.moves
      .map(m => (typeof m === 'string' ? m : m && m.spellword))
      .filter(v => typeof v === 'string' && /^m[1-9]\d*$/u.test(v));
  }

  function comboReady(now, fallbackDelay) {
    if (state.comboIndex === 0) return now - state.targetSince >= Math.max(0, Number(combo.lureDelay) || 0);
    return state.comboAt.ready(now, Math.max(0, Number(combo.stepDelay) || fallbackDelay));
  }

  // Planning this priority action must not advance or reset the attack rotation.
  function healingAction(telemetry, now) {
    const hPlayer = Number.isFinite(telemetry?.healthPercent) ? telemetry.healthPercent : Infinity;
    const hPet = Number.isFinite(telemetry?.ownPokemon?.healthPercent) ? telemetry.ownPokemon.healthPercent : Infinity;
    const health = Math.min(hPlayer, hPet);
    if (!Number.isFinite(now) || target.healSkill?.enabled !== true
        || !Number.isFinite(health) || health < 0 || health > 100
        || !Number.isFinite(Number(target.healSkill.hpPercent))
        || health > Number(target.healSkill.hpPercent)
        || !/^m[1-9]\d*$/u.test(String(target.healSkill.move))
        || !state.healAt.ready(now, SKILL_RETRY_MS)) return null;
    return { name: 'talk', parameter: target.healSkill.move };
  }

  function step(telemetry, sink, now, context = {}) {
    tickNow = now;
    if (!Number.isFinite(now)) {
      clearTarget();
      return { action: 'idle', emitted: [], reason: 'invalid-clock' };
    }
    const player = { ...telemetry.position, name: telemetry.playerName };
    const settings = engineConfig();
    const rules = matchingRules(settings.monsters, settings.maxDistance);
    const origin = referencePoint(telemetry, player);
    const all = wilds(telemetry);
    const inRange = all.filter(creature => {
      const rule = findMatchingRule(creature.name, rules);
      return Boolean(rule) && chebyshev(origin, creature.pos) <= rule.range;
    });
    // O alcance por regra ja foi aplicado acima; a selecao nao deve filtrar de novo.
    const pool = inRange.length
      ? engine.filterCandidates(player, inRange, { ...settings, maxDistance: Number.MAX_SAFE_INTEGER })
      : [];
    if (state.finishing) {
      if (pool.length && pool.every(creature => state.finishing.has(creature.id))) {
        return { action: 'idle', emitted: [], reason: 'finish-remaining' };
      }
      state.finishing = null;
    }
    // Perfect lure para a rota com os selvagens na tela; sem ele vale o alcance da regra.
    const detected = perfectLure ? all.length : pool.length;

    if (!pool.length && detected === 0) {
      if (target.autoRevive?.enabled === true && typeof target.autoRevive.hotkey === 'string'
          && target.autoRevive.hotkey.trim() && state.comboCompletedAt !== null) {
        return { action: 'combat', emitted: [], targetId: null, reason: 'combo-done' };
      }
      clearTarget();
      return { action: 'idle', emitted: [], reason: 'no-creature' };
    }

    const emergencyHpGate = Number(target.lowHpComboPercent ?? combo.lowHpComboPercent);
    const isHpEmergency = Number.isInteger(emergencyHpGate) && emergencyHpGate > 0 && Number.isFinite(telemetry.healthPercent) && telemetry.healthPercent <= emergencyHpGate;
    const shinyFound = pool.some(isShiny);
    const isShinyPriority = target.shinyPriorityEnabled === true && shinyFound;
    const minCountSatisfied = checkMinCountMet(pool, rules, minWilds);
    const lureReady = minWilds > 0 && detected >= minWilds;
    const inCombat = context.inCombat === true;

    if (!inCombat && !isHpEmergency && !isShinyPriority && !minCountSatisfied && !lureReady) {
      clearTarget();
      return { action: 'luring', emitted: [], detected, needed: minWilds || target.monsters?.find(r => r?.minCount > 1)?.minCount || 1 };
    }
    observeAttack(telemetry, pool, now);
    for (const [id, retryAt] of state.deferredTargets) {
      if (now >= retryAt) state.deferredTargets.delete(id);
    }
    const available = state.deferredTargets.size ? pool.filter(candidate => !state.deferredTargets.has(candidate.id)) : pool;
    const creature = choose(player, available.length ? available : pool, settings, telemetry?.ownPokemon?.pos);
    if (!creature) {
      clearTarget();
      if (detected > 0) {
        return { action: 'luring', emitted: [], detected, needed: minWilds || 1 };
      }
      return { action: 'idle', emitted: [], reason: 'no-creature' };
    }
    const position = telemetry.position;
    const health = telemetry.healthPercent;
    const activeUuid = rosterUuid(telemetry, telemetry.pokemonName);
    const emitted = [];
    const send = (name, parameter, extra) => { sink.command(name, parameter, extra); emitted.push([name, parameter]); };

    if (state.targetId !== creature.id) {
      state.attackObservation = null;
      state.targetId = creature.id;
      restartCombo();
      state.targetSince = now;
      state.attackAt.reset();
      state.attackDispatched = false;
    }

    if (context.externalHealing !== true) {
      const healing = healingAction(telemetry, now);
      if (healing) {
        send(healing.name, healing.parameter);
        state.healAt.use(now);
        return { action: 'heal', emitted, targetId: creature.id, skill: healing.parameter };
      }
    }

    const lowHpGate = Number(target.lowHpComboPercent ?? combo.lowHpComboPercent);
    const lowHpOnly = comboEnabled && Number.isInteger(lowHpGate) && lowHpGate > 0
      && !(Number.isFinite(health) && health <= lowHpGate);

    if (comboEnabled && !lowHpOnly && perfectingLureEnabled && state.comboIndex === 0) {
      const center = telemetry?.ownPokemon?.pos || telemetry?.position;
      const range = Number.isInteger(combo.perfectingLureRange) && combo.perfectingLureRange >= 1
        ? combo.perfectingLureRange : 1;

      const inBox = (pos) => {
        if (!pos || !center) return false;
        if (combo.perfectingSkillMaskEnabled === true && Array.isArray(combo.perfectingSkillMask) && combo.perfectingSkillMask.length > 0) {
          return combo.perfectingSkillMask.some(offset => pos.x - center.x === offset.dx && pos.y - center.y === offset.dy);
        }
        return Math.max(Math.abs(pos.x - center.x), Math.abs(pos.y - center.y)) <= range;
      };

      const monstersInBox = pool.filter(c => inBox(c.pos));
      const petHp = telemetry?.ownPokemon?.healthPercent ?? telemetry?.healthPercent ?? 100;
      const hoennSafety = Number(hoenn.perfectLureMinHp);
      const comboSafety = Number(combo.perfectingLureHpPercent);
      const safetyHp = Number.isFinite(hoennSafety) ? hoennSafety
        : Number.isFinite(comboSafety) ? comboSafety : 30;
      const timeoutMs = Number.isFinite(Number(hoenn.perfectLureTimeoutMs)) && Number(hoenn.perfectLureTimeoutMs) > 0
        ? Number(hoenn.perfectLureTimeoutMs) : 10000;

      const isHpEmergency = safetyHp > 0 && petHp <= safetyHp;
      // Em waypoint de box o original nao libera por timeout: espera a box fechar.
      const isTimeout = context.boxMode !== true && state.targetSince !== null && (now - state.targetSince >= timeoutMs);

      let boxConditionMet = false;
      if (minWilds > 0) {
        boxConditionMet = monstersInBox.length >= minWilds;
      } else {
        const matchingRule = findMatchingRule(creature.name, rules);
        const requiredCount = Math.max(1, Number(matchingRule?.minCount) || 1);
        boxConditionMet = monstersInBox.length >= requiredCount && inBox(creature.pos);
      }

      if (!isHpEmergency && !isTimeout && !boxConditionMet) {
        return { action: 'combat', emitted, targetId: creature.id, reason: 'waiting-perfect-lure' };
      }
    }

    const needsAttack = context.keyboardTransport !== true || !state.attackDispatched;
    if (needsAttack && state.attackAt.ready(now, context.keyboardTransport ? ATTACK_RETRY_MS : 1000)) {
      send('attack', creature.id);
      state.attackAt.use(now);
    }

    if (Array.isArray(target.skills)) {
      const action = context.hotkeysBlocked ? null : engine.getCombatAction(player, settings);
      if (action) {
        send('hotkey', action.key);
        state.rotationKeys.add(action.key.toLowerCase());
        if (settings.skills.length && settings.skills.every(skill => state.rotationKeys.has(skill.key.trim().toLowerCase()))) {
          state.comboCompletedAt = now;
          state.comboPokemonName = telemetry.pokemonName;
          state.lastSkillCommand = { name: 'hotkey', parameter: action.key };
        }
      }
      return { action: action ? 'skill' : emitted.length ? 'attack' : 'hold',
        emitted, targetId: creature.id };
    }

    if (context.luring === true && target.lureSkill?.enabled === true
        && Number.isFinite(health) && health >= Number(target.lureSkill.hpPercent ?? 0)
        && /^m[1-9]\d*$/u.test(String(target.lureSkill.move))
        && state.lureAt.ready(now, SKILL_RETRY_MS)) {
      send('talk', target.lureSkill.move, activeUuid ? { expectedUuid: activeUuid } : undefined);
      state.lureAt.use(now);
    }

    if (!comboEnabled) return { action: emitted.length ? 'attack' : 'hold', emitted, targetId: creature.id };
    if (lowHpOnly) return { action: 'attack', emitted, targetId: creature.id, reason: 'low-hp-gate' };

    const medicineKey = typeof combo.medicineHotkey === 'string' ? combo.medicineHotkey.trim() : '';
    const prepareMedicine = combo.useMedicineBeforeCombo === true && state.comboIndex === 0 && !state.medicinePrepared;
    const treatDebuff = combo.useMedicine === true && Array.isArray(telemetry.conditions)
      && telemetry.conditions.length > 0 && state.medicineAt.ready(now, 1500);
    const medicineDelay = Number.isFinite(combo.medicineDelayMs) && combo.medicineDelayMs >= 0
      ? combo.medicineDelayMs : 50;
    if (medicineKey && (prepareMedicine || treatDebuff)) {
      if (!context.hotkeysBlocked && state.medicineAt.ready(now, 1500)) {
        send('hotkey', medicineKey);
        state.medicineAt.use(now);
        state.medicinePrepared = true;
        return { action: 'combat', emitted, targetId: creature.id, reason: 'medicine-sent' };
      }
      if (prepareMedicine) {
        return { action: 'combat', emitted, targetId: creature.id, reason: 'medicine-wait' };
      }
    }
    if (medicineKey && !state.medicineAt.ready(now, medicineDelay)) {
      return { action: 'combat', emitted, targetId: creature.id, reason: 'medicine-wait' };
    }

    if (combo.useNativeSequence === true) {
      const nativeHotkey = (typeof combo.nativeHotkey === 'string' && combo.nativeHotkey.trim())
        || (typeof combo.hotkey === 'string' && combo.hotkey.trim());
      if (nativeHotkey) {
        if (context.hotkeysBlocked) return { action: 'combat', emitted, targetId: creature.id, native: true };
        if (state.comboIndex === 0) {
          if (comboReady(now, settings.globalCooldownMs)) {
            send('hotkey', nativeHotkey);
            state.comboIndex += 1;
            state.comboAt.use(now);
            state.comboCompletedAt = now;
            state.comboPokemonName = telemetry.pokemonName;
            state.lastSkillCommand = { name: 'hotkey', parameter: nativeHotkey };
            return { action: 'combo', emitted, targetId: creature.id, step: state.comboIndex, native: true };
          }
          return { action: 'combat', emitted, targetId: creature.id, native: true };
        }
        return { action: 'combat', emitted, targetId: creature.id,
          reason: state.comboAt.ready(now, nativeComboWaitMs(combo, hoenn)) ? 'combo-done' : 'await-combo-window', native: true };
      }
    }

    /* `sequence` devolve `null` no modo nativo (o jogo executa o combo, o bot
     * nao enumera). Tratar como vazio leva ao ramo de `!autocombo` abaixo. */
    const steps = sequence(telemetry) || [];

    /* ─── BEST TILE ANTES DO POKESTOP ───
     *
     * MEDIDO no Shiba (`native/pka_tap_572.jsonl`, 351,8 MB): a ordem real e'
     *
     *     Best Tile -> Aguardando confirmacao de PokeStop -> Perfect lure -> AutoCombo
     *
     * E o evento `Best Tile: limite de ajuste atingido; seguindo o fluxo de
     * seguranca do Lua` apareceu 20.706 vezes: ele espera o alvo entrar na
     * melhor tile e, se o ajuste nao fechar no prazo, SEGUE o fluxo de seguranca
     * em vez de travar a hunt.
     *
     * Prazos do `default_config.json`: `bestTileMaxWaitMs` 2500 (teto) e
     * `bestTileRetryMs` 700 (intervalo de reavaliacao). O teto de 4000 em
     * 0x933b2 e' a constante de .rdata do teto; 2500 e' o valor de config.
     *
     * A formula de score da melhor tile ainda e' pendente
     * (`spec/remaining-rules-v1.json`, `blockedBy`). O criterio aqui e' o que a
     * spec ja' da': o alvo esta' na melhor tile quando cai dentro de
     * `hoenn.bestTileRange` a partir do centro da box (o proprio Pokemon, com o
     * jogador como reserva).
     *
     * `state.bestTileDone` encerra a espera no ciclo: sem ele o alvo fora da
     * tile devolveria `best-tile-timeout` para sempre e o combo nunca sairia. */
    if (hoenn.bestTile === true && !state.bestTileDone && state.comboIndex === 0
        && !context.hotkeysBlocked) {
      const bestTileRange = Number.isInteger(hoenn.bestTileRange) && hoenn.bestTileRange >= 1
        ? hoenn.bestTileRange : 4;
      const bestTileMaxWait = Number.isFinite(Number(hoenn.bestTileMaxWaitMs)) && Number(hoenn.bestTileMaxWaitMs) > 0
        ? Number(hoenn.bestTileMaxWaitMs) : 2500;
      const bestTileRetry = Number.isFinite(Number(hoenn.bestTileRetryMs)) && Number(hoenn.bestTileRetryMs) > 0
        ? Number(hoenn.bestTileRetryMs) : 700;
      const boxCenter = telemetry?.ownPokemon?.pos || position;
      const onBestTile = Boolean(creature.pos && boxCenter)
        && chebyshev(boxCenter, creature.pos) <= bestTileRange;
      if (!onBestTile) {
        if (state.bestTileSince === null) state.bestTileSince = now;
        const waited = now - state.bestTileSince;
        if (waited >= bestTileMaxWait) {
          state.bestTileDone = true;
          return { action: 'combat', emitted, targetId: creature.id,
            reason: 'best-tile-timeout', waited };
        }
        if (state.bestTileAt.ready(now, bestTileRetry)) {
          state.bestTileTries += 1;
          state.bestTileAt.use(now);
        }
        return { action: 'combat', emitted, targetId: creature.id,
          reason: 'best-tile-wait', attempt: state.bestTileTries };
      }
    }

    /* ─── POKESTOP ANTES DO COMBO ───
     *
     * MEDIDO (`pka_tap_572.jsonl`, 351,8 MB): a ordem real do Shiba e'
     *
     *     Best Tile -> Aguardando confirmacao de PokeStop -> Perfect lure -> AutoCombo
     *
     *   transicoes: Best Tile -> PokeStop (128), PokeStop -> Perfect lure (119)
     *   duracao de "Aguardando confirmacao de PokeStop": mediana 1.375 ms
     *
     * E o evento `PokeStop sem confirmacao apos quatro tentativas` apareceu
     * 336.531 vezes: ele tenta 4x e SEGUE o fluxo mesmo sem confirmacao — nao
     * trava a hunt por causa do pokestop.
     *
     * POR QUE POKESTOP: manda o Pokemon ficar parado na box enquanto os
     * monstros chegam. Sem isso o Pokemon anda junto com o treinador e a lure
     * nao fecha.
     *
     * `combo.usePokeStop === true` na config real. Tentamos uma vez por ciclo
     * de combo (`state.pokeStopTries`), no maximo POKESTOP_ATTEMPTS. */
    if (combo.usePokeStop === true && state.comboIndex === 0
        && state.pokeStopTries < POKESTOP_ATTEMPTS && !context.hotkeysBlocked) {
      if (state.pokeStopAt.ready(now, POKESTOP_RETRY_MS)) {
        send('talk', POKESTOP_TEXT, activeUuid ? { expectedUuid: activeUuid } : undefined);
        state.pokeStopTries += 1;
        state.pokeStopAt.use(now);
        return { action: 'combo', emitted, targetId: creature.id,
          reason: 'pokestop', attempt: state.pokeStopTries };
      }
      return { action: 'combat', emitted, targetId: creature.id, reason: 'pokestop-wait' };
    }

    if (!steps.length) {
      if (combo.useNativeSequence === true && !context.hotkeysBlocked) {
        if (state.comboIndex === 0) {
          if (comboReady(now, settings.globalCooldownMs)) {
            send('combo', '!autocombo', activeUuid ? { expectedUuid: activeUuid } : undefined);
            state.comboIndex += 1;
            state.comboAt.use(now);
            state.comboCompletedAt = now;
            state.comboPokemonName = telemetry.pokemonName;
            state.lastSkillCommand = { name: 'combo', parameter: '!autocombo' };
            return { action: 'combo', emitted, targetId: creature.id, step: state.comboIndex, native: true };
          }
          return { action: 'combat', emitted, targetId: creature.id, native: true };
        }
        return { action: 'combat', emitted, targetId: creature.id,
          reason: state.comboAt.ready(now, nativeComboWaitMs(combo, hoenn)) ? 'combo-done' : 'await-combo-window', native: true };
      }
      return { action: 'attack', emitted, targetId: creature.id, reason: 'empty-combo' };
    }
    if (state.comboIndex >= steps.length) return { action: 'combat', emitted, targetId: creature.id, reason: 'combo-done' };
    if (!comboReady(now, settings.globalCooldownMs)) return { action: 'combat', emitted, targetId: creature.id };
    const move = steps[state.comboIndex];
    const guard = activeUuid ? { expectedUuid: activeUuid, attackTargetId: creature.id } : undefined;
    if (!guard && context.keyboardTransport !== true) {
      /* Pokemon ausente NO MEIO do combo: o Shiba espera a recuperacao e retoma
       * do MESMO indice, em vez de reiniciar a sequencia.
       *
       * MEDIDO (`native/pka_tap_572.jsonl`, 351,8 MB): `target: Pokemon ausente
       * durante o combo; aguardando recuperacao` x267.265 — e' espera, nao
       * reinicio.
       *
       * `comboIndex` fica intacto e `comboAt` nao e' tocado: a espera nao gasta
       * passo nem prazo, e a volta do uuid continua da skill atual. Nao entra em
       * `state.blocked` porque o set e' acumulativo e a ausencia aqui e'
       * transitoria; o motivo fica no `reason` do retorno. O ataque continua
       * saindo nos ticks de espera (ele vem antes deste ponto e nao usa uuid).
       *
       * Em `comboIndex === 0` nada muda: ali o uuid ausente e' contrato do
       * transporte de teclado e segue `missing-uuid`. */
      if (state.comboIndex > 0) {
        return { action: 'combat', emitted, targetId: creature.id, reason: 'await-pokemon-recovery' };
      }
      state.blocked.add('combo-without-uuid');
      return { action: 'combat', emitted, targetId: creature.id, reason: 'missing-uuid', blocked: [...state.blocked] };
    }
    send('talk', move, guard);
    state.comboIndex += 1;
    state.comboAt.use(now);
    if (state.comboIndex === steps.length) {
      state.comboCompletedAt = now;
      state.comboPokemonName = telemetry.pokemonName;
      state.lastSkillCommand = { name: 'talk', parameter: move };
    }
    return { action: 'combo', emitted, targetId: creature.id, step: state.comboIndex, total: steps.length };
  }

  return {
    step,
    healingAction,
    finishCombo,
    recordHealing(timestamp) { state.healAt.use(timestamp); },
    recordAttackDelivery,
    recordDispatch(name, parameter, timestamp) {
      if (name === 'hotkey') engine.recordDispatch(parameter, timestamp);
      if (name === 'attack') { state.attackAt.use(timestamp); state.attackDispatched = true; }
      if (name === 'talk' || name === 'combo' || name === 'hotkey') state.comboAt.use(timestamp);
      if (state.comboCompletedAt !== null && state.lastSkillCommand?.name === name
          && state.lastSkillCommand.parameter === parameter) state.comboCompletedAt = timestamp;
    },
    inspect(telemetry) {
      const player = { ...telemetry.position, name: telemetry.playerName };
      return candidates(telemetry, player, engineConfig());
    },
    clearTarget,
    restartCombo,
    reset() {
      engine = new TargetEngine({}, { now: () => tickNow });
      clearTarget();
      Object.assign(state, { targetId: null, attackDispatched: false, comboIndex: 0, comboAt: new Cooldown(),
        healAt: new Cooldown(), lureAt: new Cooldown(), attackAt: new Cooldown(), medicineAt: new Cooldown(),
        finishing: null, blocked: new Set() });
    },
    get state() { return { targetId: state.targetId, comboIndex: state.comboIndex, comboCompletedAt: state.comboCompletedAt, comboPokemonName: state.comboPokemonName, blocked: [...state.blocked] }; },
  };
}

module.exports = { createTargetEngine, nativeComboWaitMs, ATTACK_RETRY_MS, SKILL_RETRY_MS, isShiny };
