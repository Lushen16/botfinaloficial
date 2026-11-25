'use strict';

const { createTargetEngine } = require('./target-engine.cjs');
const { createHealerEngine } = require('./healer-engine.cjs');
const { createFrameCapture } = require('./capture-engine.cjs');
const { createAlertsEngine } = require('./alerts-engine.cjs');
const { realPosition, distance, sameTile } = require('./shared.cjs');

function perception(raw) {
  const available = raw?.creaturesAvailable === true && Array.isArray(raw.creatures);
  const creatures = available ? raw.creatures.filter(Boolean).map(creature => {
    const family = creature.id >>> 28;
    const isOwnPokemon = family === 8 || creature.ownPokemon === true || creature.isOwnPokemon === true;
    const isPlayer = family === 1 || creature.id === raw.player?.id || creature.type === 0;
    const healthPercent = creature.healthPercent === undefined ? creature.hp : creature.healthPercent;
    return { ...creature, creatureType: creature.type, healthPercent, healthUnknown: healthPercent === null,
      isOwnPokemon, is_player: isPlayer, canAttack: creature.type === 1 && !isPlayer && !isOwnPokemon && creature.canAttack !== false };
  }) : [];
  const own = raw?.ownPokemon ?? creatures.find(creature => creature.isOwnPokemon);
  return { ...raw, creatures, creaturesAvailable: available, playerId: raw?.player?.id,
    playerName: raw?.player?.name, position: raw?.player?.pos ?? raw?.position,
    ownPokemon: own && { ...own, healthPercent: own.healthPercent === undefined ? own.hp : own.healthPercent },
    pokemonName: own?.name ?? raw?.pokemonName };
}

function createFrameAutomation(config = {}) {
  const target = createTargetEngine(config);
  const healer = createHealerEngine({ ...config, hoenn: { ...config.hoenn, potionHpPercent: 0 } }, { switchBeforeHeal: true });
  const capture = createFrameCapture(config);
  const alerts = createAlertsEngine(config);
  const hoenn = config.hoenn ?? {}, settings = config.target ?? {};
  let identity, lastSeq, lastNow = -Infinity, fighting, emptySince, revive, potionAt, finished;
  let availability, missingFrames = 0, missingSeq = null;
  function resetFight() {
    target.reset(); fighting = false; emptySince = null; revive = null; finished = new Set();
  }
  function reset() {
    resetFight(); healer.reset(); capture.reset(); potionAt = -Infinity;
    identity = null; lastSeq = null; availability = null;
  }
  reset();
  function tick(snapshot, now) {
    if (!Number.isFinite(now) || now < lastNow) throw RangeError('Expected a monotonic clock');
    lastNow = now;
    const raw = snapshot?.telemetry;
    const frame = perception(raw);
    const orders = [];
    const seq = raw?.seq ?? raw?.tick;
    const missing = !raw?.player;
    const session = missing ? null : JSON.stringify([snapshot.pid, frame.playerId, raw.mapId, frame.position?.z]);
    let monitor = { actions: [], states: alerts.states };
    if (missing) {
      if (!Number.isInteger(seq) || (seq > (missingSeq ?? -Infinity) && seq > (lastSeq ?? -Infinity))) {
        missingFrames++; missingSeq = seq ?? null;
      }
      if (missingFrames >= 3) {
        monitor = alerts.step({ online: false, confirmedOutage: true }, { creaturesAvailable: false }, now);
      }
    } else if (!Number.isInteger(seq) || lastSeq === null || seq > lastSeq || identity !== session) {
      missingFrames = 0; missingSeq = null;
      monitor = alerts.step(snapshot, frame, now);
    }
    const result = (phase, pauseWalker, extra = {}) => ({ phase, pauseWalker, allowMovement: !pauseWalker, orders, monitor,
      creaturesAvailable: frame.creaturesAvailable, targetId: target.state.targetId,
      effectVerified: target.state.effectVerified, ...extra });
    if (missing && !snapshot?.paused && Number.isInteger(seq) && lastSeq !== null && seq <= lastSeq) {
      return result('await-frame', true);
    }
    if (!raw?.player || !Number.isInteger(frame.playerId) || !realPosition(frame.position)
        || snapshot.paused || snapshot.runtimeReady === false || snapshot.online === false || snapshot.stale || snapshot.authExpired || snapshot.error) {
      const previousSeq = lastSeq, previousIdentity = identity;
      reset(); identity = previousIdentity;
      lastSeq = Math.max(previousSeq ?? -Infinity, seq ?? -Infinity);
      return result('interrupted', true);
    }
    if (identity !== null && identity !== session) {
      reset(); identity = session; lastSeq = raw.seq ?? raw.tick; return result('session-changed', true);
    }
    identity = session;
    if (Number.isInteger(seq) && lastSeq !== null && seq <= lastSeq) return result('await-frame', true);
    lastSeq = seq ?? null;
    frame.tick = seq;
    if (availability === true && !frame.creaturesAvailable) {
      resetFight(); healer.reset(); capture.reset(); potionAt = -Infinity;
      availability = false;
      return result('blind', true, { wildCount: null });
    }
    availability = frame.creaturesAvailable;
    if (frame.healthPercent === 0) { resetFight(); return result('player-down', true); }
    const output = { command(name, parameter, extra) {
      if (name === 'attack') {
        const pos = extra.pos;
        orders.push({ name, parameter: { x: pos.x, y: pos.y } });
      } else orders.push({ name: name === 'combo' ? 'talk' : name === 'hotkey' ? 'potion' : name, parameter });
    } };
    if (revive) {
      const rule = settings.autoRevive;
      if (now < revive.due) return result('revive-delay', true);
      if (revive.sent === null) {
        output.command('potion', rule.hotkey); revive.sent = now;
        return result('revive', true);
      }
      if (rule.waitForPokemon && !(frame.ownPokemon?.healthPercent > 0 && frame.ownPokemon?.name === revive.name)
          && now - revive.sent < (hoenn.pokeReadyTimeoutMs ?? 3000)) return result('await-pokemon', true);
      const confirmed = frame.ownPokemon?.healthPercent > 0 && frame.ownPokemon?.name === revive.name;
      revive = null; target.finishCombo(frame);
      return result('revive-finished', true, { pokemonObserved: Boolean(confirmed) });
    }
    const hp = frame.healthPercent;
    const lowHp = Number.isFinite(hp) && hp > 0 && hp <= 100 && hp < hoenn.potionHpPercent;
    if (lowHp && hoenn.potionHotkey && now - potionAt >= (hoenn.potionCooldownMs ?? 1500)) {
      potionAt = now; output.command('potion', hoenn.potionHotkey);
      return result('emergency-potion', true);
    }
    const candidates = target.inspect(frame);
    const wildCount = frame.creaturesAvailable ? candidates.length : null;
    if (!config.healer?.onlyOutsideCombat || (wildCount === 0 && !fighting)) {
      const healing = healer.step(frame, output, now);
      if (orders.length || healing.waiting) return result('healing', true);
    }
    if (!frame.creaturesAvailable) return result('blind', false, { wildCount });
    if ((fighting || emptySince !== null) && !wildCount) {
      target.clearTarget();
      emptySince ??= now;
      if (now - emptySince < (settings.endCombatDelayMs ?? 0)) return result('await-combat-end', true);
      resetFight();
    } else if (wildCount) emptySince = null;
    const remaining = settings.combo?.finishRemainingCount ?? 0;
    if (fighting && wildCount && remaining > 0 && wildCount <= remaining) {
      resetFight(); finished = new Set(candidates.map(creature => creature.id));
    }
    const engage = wildCount > 0 && !candidates.every(creature => finished.has(creature.id));
    if (!engage) {
      const loot = capture.step(frame, now, false);
      if (loot) {
        if (loot.order) orders.push(loot.order);
        return result(loot.phase, loot.pauseWalker, { wildCount });
      }
      if (!wildCount) finished.clear();
      return result('walker', false, { wildCount });
    }
    finished.clear();
    if (!fighting && hoenn.forceBox && wildCount >= Math.max(1, hoenn.minWildsToEngage ?? 1)) {
      const box = config.walker?.waypoints?.find(point => point.action === 'box' && distance(frame.position, point.pos) < Infinity);
      if (box && !sameTile(frame.position, box.pos)) return result('force-box', false, { waypoint: box, wildCount });
    }
    const fight = target.step(frame, output, now, { frameCommands: true, inCombat: fighting,
      boxMode: hoenn.forceBox === true && config.walker?.waypoints?.some(point => point.action === 'box' && sameTile(frame.position, point.pos)) });
    if (orders.some(order => order.name === 'attack')) target.recordAttackDelivery(target.state.targetId, frame, now, true);
    fighting = fight.action !== 'idle' && fight.action !== 'luring';
    if (target.state.comboCompletedAt === now && settings.autoRevive?.enabled && settings.autoRevive.hotkey) {
      revive = { due: now + Math.max(0, settings.autoRevive.interval ?? 1500), name: frame.pokemonName, sent: null };
    } else if (fight.reason === 'combo-done') target.finishCombo(frame);
    return result(fight.reason ?? fight.action, fighting, { wildCount });
  }
  return { tick, reset() { reset(); alerts.reset(); lastNow = -Infinity; missingSeq = null; missingFrames = 0; },
    get state() { return { fighting, target: target.state, revive: revive && { ...revive }, alerts: alerts.states }; } };
}

module.exports = { createFrameAutomation };
