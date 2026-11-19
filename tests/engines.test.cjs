'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createAutomation, createRecorder, createProtocolSink, gateReason } = require('../reconstruction/automation.cjs');
const { createWalkerEngine } = require('../reconstruction/engines/walker-engine.cjs');
const { createTargetEngine } = require('../reconstruction/engines/target-engine.cjs');
const { createHealerEngine } = require('../reconstruction/engines/healer-engine.cjs');
const { DIRECTIONS } = require('../reconstruction/engines/shared.cjs');
const { mergeCreatureSnapshot, createCreatureSource } = require('../tools/creature_bridge.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const config = (patch = {}) => ({
  target: { combo: { enabled: false, sequenceText: '', stepDelay: 250 }, healSkill: {}, lureSkill: {}, ...patch.target },
  hoenn: { perfectLure: false, minWildsToEngage: 0, potionHpPercent: 0, useMedicine: false, ...patch.hoenn },
  healer: { healHpPercent: 0, ...patch.healer },
  /* `stepIntervalMs: 0`: a maioria destes testes avanca o relogio em 100 ms,
   * abaixo do piso de 406 ms medido no cliente real. O piso tem teste proprio
   * mais abaixo ("piso de cadencia..."), onde ele fica LIGADO de proposito. */
  walker: { loop: true, stepIntervalMs: 0, waypoints: [], ...patch.walker },
});

const roster = [{ slot: 1, uuid: 'uuid-1', name: 'Charizard' }];
const creature = (id, x, y, patch = {}) => ({ id, name: 'Wild', type: 1, healthPercent: 100, canAttack: true, pos: { x, y, z: 7 }, ...patch });

function snapshot(telemetry = {}, patch = {}) {
  return {
    pid: 10, online: true, stale: false, error: null, authExpired: false, ageMs: 30, paused: false,
    runtime: { modules: [], pid: null, paused: false },
    telemetry: {
      schema: 2, nativeVerified: true, pulseVersion: 3, tick: 1, playerId: 1, fightMode: 0, chaseMode: 0,
      clockMs: 0, position: { x: 100, y: 100, z: 7 }, activeSlot: 1, moves: [], nativeSequence: [],
      pokemonName: 'Charizard', comboPokemonName: 'Charizard', conditionEvents: true, conditionsKnown: true,
      conditions: [], roster, creatures: [], items: [], tiles: [], healthPercent: 100,
      ...telemetry,
    },
    ...patch,
  };
}

test('readiness gates block every engine before sending', () => {
  const automation = createAutomation(config(), { now: () => 1000 });
  for (const patch of [{ online: false }, { stale: true }, { error: 'x' }, { authExpired: true },
    { ageMs: 1001 }, { paused: true }, { runtime: { paused: true, modules: ['target'], pid: 10 } },
    { telemetry: { nativeVerified: false } }, { telemetry: { pulseVersion: 2 } },
    { runtime: { modules: ['target'], pid: 11 } },
    { telemetry: { position: { x: 0, y: 0, z: 0 } } },
    { telemetry: { position: { x: 65535, y: 65535, z: 255 } } }]) {
    const recorder = createRecorder();
    const result = automation.tick(snapshot({ creatures: [creature(1, 101, 100)] }, patch), recorder);
    assert.equal(result.status, 'blocked');
    assert.deepEqual(recorder.events, []);
  }
  assert.equal(gateReason(snapshot()), null);
  /* Sentinelas tem motivo declarado, nao `null`: o gate precisa recusar antes
   * de o walker ver a posicao falsa. */
  assert.equal(gateReason(snapshot({ position: { x: 0, y: 0, z: 0 } })), 'no-position');
  assert.equal(gateReason(snapshot({ position: { x: 65535, y: 65535, z: 255 } })), 'no-position');
  /* (0,0,x) parcial e' coordenada real (waypoint 0,0 e' valido). */
  assert.equal(gateReason(snapshot({ position: { x: 0, y: 1, z: 7 } })), null);
});

test('walker steps one tile per tick and reports the direction', () => {
  const engine = createWalkerEngine(config({ walker: { waypoints: [{ action: 'walk', pos: { x: 103, y: 100, z: 7 } }] } }));
  const recorder = createRecorder();
  const first = engine.step({ position: { x: 100, y: 100, z: 7 } }, recorder, 0);
  assert.deepEqual(first.emitted, [['walk', DIRECTIONS.east]]);
  const second = engine.step({ position: { x: 101, y: 100, z: 7 } }, recorder, 100);
  assert.deepEqual(second.emitted, [['walk', DIRECTIONS.east]]);
  const arrived = engine.step({ position: { x: 103, y: 100, z: 7 } }, recorder, 200);
  assert.equal(arrived.action, 'advance');
  assert.deepEqual(recorder.events.map(event => [event.name, event.parameter]), [['walk', 1], ['walk', 1]]);
});

test('walker accepts a diagonal tile after approaching a regular waypoint', () => {
  const engine = createWalkerEngine(config({ walker: { waypoints: [
    { action: 'walk', pos: { x: 103, y: 101, z: 7 } },
    { action: 'walk', pos: { x: 103, y: 100, z: 7 } },
  ] } }));
  const recorder = createRecorder();
  engine.step({ position: { x: 100, y: 100, z: 7 } }, recorder, 0);
  const adjacent = { position: { x: 102, y: 100, z: 7 } };
  const result = engine.step(adjacent, recorder, 100);
  assert.equal(result.reason, 'arrived-within-one-tile');
  assert.equal(result.index, 1);
  assert.deepEqual(result.emitted, []);
  assert.deepEqual(engine.step(adjacent, recorder, 200).emitted, [['walk', DIRECTIONS.east]]);
});

test('one-tile tolerance does not advance special waypoints or apply across floors', () => {
  for (const [action, z] of [['stairs', 7], ['box', 7], ['safespot', 7], ['walk', 8]]) {
    const engine = createWalkerEngine(config({ walker: { waypoints: [
      { action, pos: { x: 102, y: 100, z } },
    ] } }));
    const recorder = createRecorder();
    engine.step({ position: { x: 100, y: 100, z: 7 } }, recorder, 0);
    assert.deepEqual(engine.step({ position: { x: 101, y: 100, z: 7 } }, recorder, 100).emitted,
      [['walk', DIRECTIONS.east]]);
  }
});

test('walker says once per visit, holds waits, and loops the route', () => {
  const engine = createWalkerEngine(config({ walker: { waypoints: [
    { action: 'say', pos: { x: 100, y: 100, z: 7 }, param: 'rota ok' },
    { action: 'wait', pos: { x: 100, y: 100, z: 7 }, param: 500 },
  ] } }));
  const recorder = createRecorder();
  assert.deepEqual(engine.step({ position: { x: 100, y: 100, z: 7 } }, recorder, 0).emitted, [['talk', 'rota ok']]);
  assert.equal(engine.step({ position: { x: 100, y: 100, z: 7 } }, recorder, 100).reason, 'wait');
  assert.equal(engine.step({ position: { x: 100, y: 100, z: 7 } }, recorder, 700).action, 'advance');
  assert.deepEqual(engine.step({ position: { x: 100, y: 100, z: 7 } }, recorder, 800).emitted, [['talk', 'rota ok']]);
  assert.equal(engine.step({ position: { x: 100, y: 100, z: 7 } }, recorder, 900).reason, 'wait');
  assert.equal(recorder.events.filter(event => event.name === 'talk').length, 2);
});

test('walker waits for a floor change on stairs and fails over', () => {
  const route = { loop: false, waypoints: [{ action: 'stairs', pos: { x: 100, y: 100, z: 7 } }] };
  const changed = createWalkerEngine(config({ walker: route }));
  const recorder = createRecorder();
  assert.equal(changed.step({ position: { x: 100, y: 100, z: 7 } }, recorder, 0).reason, 'stairs');
  assert.equal(changed.step({ position: { x: 100, y: 100, z: 7 } }, recorder, 1000).reason, 'stairs');
  const done = changed.step({ position: { x: 100, y: 100, z: 8 } }, recorder, 1100);
  assert.equal(done.action, 'done');
  assert.equal(done.reason, 'stairs');
  const stale = createWalkerEngine(config({ walker: route }));
  assert.equal(stale.step({ position: { x: 100, y: 100, z: 7 } }, createRecorder(), 0).reason, 'stairs');
  const timedOut = stale.step({ position: { x: 100, y: 100, z: 7 } }, createRecorder(), 6000);
  assert.equal(timedOut.action, 'done');
  assert.equal(timedOut.reason, 'stairs-timeout');
});

test('walking out of sync targets the nearest waypoint', () => {
  const engine = createWalkerEngine(config({ walker: { startNearestWaypoint: true, waypoints: [
    { action: 'walk', pos: { x: 150, y: 150, z: 7 } },
    { action: 'walk', pos: { x: 101, y: 100, z: 7 } },
  ] } }));
  const recorder = createRecorder();
  const result = engine.step({ position: { x: 100, y: 100, z: 7 } }, recorder, 0);
  assert.equal(result.index, 1);
  assert.deepEqual(result.emitted, [['walk', DIRECTIONS.east]]);
});

test('target ignores non-attackable and blacklisted creatures and prioritises shiny', () => {
  const engine = createTargetEngine(config({ target: { shinyPriorityEnabled: true, ignoredCreaturesText: 'boss' } }));
  const recorder = createRecorder();
  const telemetry = {
    position: { x: 100, y: 100, z: 7 }, activeSlot: 1, roster, pokemonName: 'Charizard', healthPercent: 100,
    creatures: [
      creature(1, 101, 100, { canAttack: false }),
      creature(2, 100, 100, { name: 'Boss' }),
      creature(3, 105, 100),
      creature(4, 103, 100, { shinyIcon: 1 }),
    ],
  };
  const result = engine.step(telemetry, recorder, 0);
  assert.equal(result.targetId, 4);
  assert.deepEqual(recorder.events[0], { name: 'attack', parameter: 4 });
});

test('perfect lure holds fire below the minimum and attacks at the threshold', () => {
  const engine = createTargetEngine(config({ hoenn: { perfectLure: true, minWildsToEngage: 11 } }));
  const recorder = createRecorder();
  const pool = count => Array.from({ length: count }, (_, index) => creature(10 + index, 101 + (index % 3), 101));
  const base = { position: { x: 100, y: 100, z: 7 }, activeSlot: 1, roster, pokemonName: 'Charizard', healthPercent: 100 };
  assert.equal(engine.step({ ...base, creatures: pool(6) }, recorder, 0).action, 'luring');
  assert.deepEqual(recorder.events, []);
  const engaged = engine.step({ ...base, creatures: pool(11) }, recorder, 100);
  assert.equal(engaged.action, 'attack');
  assert.equal(recorder.events[0].name, 'attack');
});

test('combo follows the sequence with identity guard and step delay', () => {
  const engine = createTargetEngine(config({ target: { combo: { enabled: true, sequenceText: 'm1, m2', stepDelay: 250 } } }));
  const recorder = createRecorder();
  const telemetry = { position: { x: 100, y: 100, z: 7 }, activeSlot: 1, roster, pokemonName: 'Charizard', healthPercent: 90,
    creatures: [creature(7, 101, 100)] };
  engine.step(telemetry, recorder, 0);
  assert.deepEqual(recorder.events.map(event => event.name), ['attack', 'talk']);
  assert.deepEqual(recorder.events[1].extra, { expectedUuid: 'uuid-1', attackTargetId: 7 });
  engine.step(telemetry, recorder, 100);
  assert.equal(recorder.events.length, 2, 'step delay must hold the second skill');
  engine.step(telemetry, recorder, 300);
  assert.equal(recorder.events[2].parameter, 'm2');
  assert.equal(engine.step(telemetry, recorder, 4000).reason, 'combo-done');
});

test('combo emergency gate uses the schema target.lowHpComboPercent path', () => {
  const engine = createTargetEngine(config({ target: { lowHpComboPercent: 50,
    combo: { enabled: true, sequenceText: 'm1', stepDelay: 250 } } }));
  const recorder = createRecorder();
  const telemetry = { position: { x: 100, y: 100, z: 7 }, activeSlot: 1, roster, pokemonName: 'Charizard',
    creatures: [creature(7, 101, 100)] };
  assert.equal(engine.step({ ...telemetry, healthPercent: 90 }, recorder, 0).reason, 'low-hp-gate');
  assert.deepEqual(recorder.events.map(event => event.name), ['attack']);
  engine.step({ ...telemetry, healthPercent: 40 }, recorder, 250);
  assert.deepEqual(recorder.events.map(event => [event.name, event.parameter]), [['attack', 7], ['talk', 'm1']]);
});

test('combo waits lureDelay before the first skill', () => {
  const engine = createTargetEngine(config({ target: { combo: { enabled: true, sequenceText: 'm1',
    stepDelay: 250, lureDelay: 1000 } } }));
  const recorder = createRecorder();
  const telemetry = { position: { x: 100, y: 100, z: 7 }, activeSlot: 1, roster, pokemonName: 'Charizard',
    healthPercent: 90, creatures: [creature(7, 101, 100)] };
  assert.deepEqual(engine.step(telemetry, recorder, 0).emitted, [['attack', 7]]);
  assert.deepEqual(engine.step(telemetry, recorder, 999).emitted, []);
  assert.deepEqual(engine.step(telemetry, recorder, 1000).emitted.at(-1), ['talk', 'm1']);
});

test('combo without an identity guard reports the block instead of sending', () => {
  const engine = createTargetEngine(config({ target: { combo: { enabled: true, sequenceText: 'm1' } } }));
  const recorder = createRecorder();
  const result = engine.step({ position: { x: 100, y: 100, z: 7 }, activeSlot: 0, roster: [], pokemonName: 'Unknown',
    healthPercent: 100, creatures: [creature(7, 101, 100)] }, recorder, 0);
  assert.equal(result.reason, 'missing-uuid');
  assert.deepEqual(recorder.events.map(event => event.name), ['attack']);
});

test('native sequence replaces the configured spellwords', () => {
  const engine = createTargetEngine(config({ target: { combo: { enabled: true, useNativeSequence: true, sequenceText: 'm9' } } }));
  const recorder = createRecorder();
  engine.step({ position: { x: 100, y: 100, z: 7 }, activeSlot: 1, roster, pokemonName: 'Charizard', healthPercent: 100,
    nativeSequence: ['m3'], creatures: [creature(7, 101, 100)] }, recorder, 0);
  assert.deepEqual(recorder.events.map(event => [event.name, event.parameter]), [['attack', 7], ['talk', 'm3']]);
});

test('healer prefers the hotkey, honours cooldown, and only does one action per tick', () => {
  const engine = createHealerEngine({ healer: { healHpPercent: 55, healPokemonName: 'Charizard', healMoveSlot: 1, healResetSlot: 2 },
    hoenn: { potionHpPercent: 60, potionHotkey: 'F1', potionCooldownMs: 5000 } });
  const recorder = createRecorder();
  const telemetry = { healthPercent: 40, ownPokemon: { healthPercent: 40 }, conditions: [], roster, pokemonName: 'Charizard', activeSlot: 1 };
  assert.deepEqual(engine.step(telemetry, recorder, 0).emitted, [['hotkey', 'F1']]);
  assert.deepEqual(engine.step(telemetry, recorder, 400).emitted, [['talk', 'm1']]);
  assert.deepEqual(engine.step(telemetry, recorder, 1500).emitted, [['talk', 'm1']]);
  assert.deepEqual(engine.step({ ...telemetry, healthPercent: 90 }, recorder, 2600).emitted, [['talk', 'm2']]);
  assert.equal(engine.step({ ...telemetry, healthPercent: 90 }, recorder, 3800).emitted.length, 0);
});

test('healer uses medicine for conditions on its own cooldown', () => {
  const engine = createHealerEngine({ healer: { healHpPercent: 0 },
    hoenn: { potionHpPercent: 0, useMedicine: true, medicineHotkey: 'F2' } });
  const recorder = createRecorder();
  const telemetry = { healthPercent: 90, conditions: [{ type: '1', subId: 0 }], roster, pokemonName: 'Charizard', activeSlot: 1 };
  assert.deepEqual(engine.step(telemetry, recorder, 0).emitted, [['hotkey', 'F2']]);
  assert.deepEqual(engine.step(telemetry, recorder, 500).emitted, []);
  assert.deepEqual(engine.step(telemetry, recorder, 1600).emitted, [['hotkey', 'F2']]);
});

test('healer emits a numeric potion for the configured slot and blocks when no channel exists', () => {
  const engine = createHealerEngine({ healer: { healHpPercent: 0 }, hoenn: { potionHpPercent: 60, potionHotkey: '', potionActionBar: 3 } });
  const recorder = createRecorder();
  const telemetry = { healthPercent: 100, ownPokemon: { healthPercent: 50 }, roster };
  assert.deepEqual(engine.step(telemetry, recorder, 0).emitted, [['potion', 3]]);
  const missing = createHealerEngine({ healer: { healHpPercent: 0 }, hoenn: { potionHpPercent: 60, potionHotkey: '', potionActionBar: 0 } });
  const result = missing.step(telemetry, createRecorder(), 0);
  assert.deepEqual(result.emitted, []);
  assert.deepEqual(result.blocked, ['potion-channel-missing']);
});

test('healer requires a hotkey for medicine even with a configured slot', () => {
  const telemetry = { conditions: ['poison'], roster };
  const config = { useMedicine: true, medicineActionBar: 4 };
  const missing = createHealerEngine({ hoenn: config }).step(telemetry, createRecorder(), 0);
  assert.deepEqual(missing.emitted, []);
  assert.ok(missing.blocked.includes('medicine-channel-missing'));
  const configured = createHealerEngine({ hoenn: { ...config, medicineHotkey: 'F4' } });
  assert.deepEqual(configured.step(telemetry, createRecorder(), 0).emitted, [['hotkey', 'F4']]);
});

test('healer swaps back to the return pokemon after the heal cycle', () => {
  const engine = createHealerEngine({ healer: { healHpPercent: 55, healPokemonName: 'Charizard', healMoveSlot: 1, healResetSlot: 2, returnPokemonName: 'Blastoise' },
    hoenn: {} });
  const recorder = createRecorder();
  const party = [{ slot: 1, uuid: 'uuid-1', name: 'Charizard' }, { slot: 2, uuid: 'uuid-2', name: 'Blastoise' }];
  engine.step({ healthPercent: 40, roster: party, pokemonName: 'Blastoise', activeSlot: 2 }, recorder, 0);
  engine.step({ healthPercent: 90, roster: party, pokemonName: 'Charizard', activeSlot: 1 }, recorder, 1000);
  engine.step({ healthPercent: 90, roster: party, pokemonName: 'Charizard', activeSlot: 1 }, recorder, 2000);
  assert.deepEqual(recorder.events.map(event => [event.name, event.parameter]), [['talk', 'm1'], ['talk', 'm2'], ['switchPokemon', 'Blastoise']]);
});

test('automation heals before fighting and walks while luring', () => {
  const configValue = config({
    target: { combo: { enabled: true, sequenceText: 'm1' } },
    hoenn: { perfectLure: true, minWildsToEngage: 3, potionHpPercent: 50, potionHotkey: 'F1' },
    walker: { waypoints: [{ action: 'walk', pos: { x: 110, y: 100, z: 7 } }] },
  });
  let clock = 0;
  const automation = createAutomation(configValue, { now: () => clock });
  const recorder = createRecorder();
  const hurt = automation.tick(snapshot({ ownPokemon: { healthPercent: 40 }, creatures: [creature(1, 101, 100), creature(2, 102, 100), creature(3, 103, 100)] }), recorder);
  assert.equal(hurt.status, 'heal');
  clock = 1500;
  const luring = automation.tick(snapshot({ healthPercent: 90, creatures: [creature(1, 101, 100)] }), recorder);
  assert.equal(luring.status, 'luring');
  assert.equal(luring.walk.emitted[0][0], 'walk');
  clock = 3000;
  const fighting = automation.tick(snapshot({ healthPercent: 90, creatures: [creature(1, 101, 100), creature(2, 102, 100), creature(3, 103, 100)] }), recorder);
  assert.equal(fighting.status, 'combat');
});

test('automation resumes walking on the first tick after a distance lure hold', () => {
  let clock = 0;
  const automation = createAutomation(config({
    target: { luring: { enabled: true, maxDistance: 3 } },
    hoenn: { perfectLure: true, minWildsToEngage: 3 },
    walker: { stepIntervalMs: 406, waypoints: [{ action: 'walk', pos: { x: 110, y: 100, z: 7 } }] },
  }), { now: () => clock });

  assert.equal(automation.tick(snapshot()).walk.action, 'move');
  clock = 200;
  const held = automation.tick(snapshot({ tick: 2, creatures: [creature(7, 104, 100)] }));
  assert.equal(held.status, 'lure-hold');
  assert.equal(held.lure.state, 'holding');
  assert.deepEqual(held.walk.emitted, []);

  clock = 500;
  const resumed = automation.tick(snapshot({ tick: 3, creatures: [creature(7, 103, 100)] }));
  assert.equal(resumed.lure.state, 'in-range');
  assert.equal(resumed.walk.action, 'move', resumed.walk.reason);
  assert.equal(resumed.walk.index, 0);
  assert.deepEqual(resumed.walk.emitted, [['walk', DIRECTIONS.east]]);
});

/**
 * ─── CONTEXTO DE LURE PARA O TARGET (auditoria G01, defeito B.4) ───
 *
 * `automation.cjs` passava ao Target `luring: config.target.luring.enabled === true`.
 * Mas `lure-engine.normalizeLuring()` deriva o modo por PRECEDENCIA:
 *   randomEnabled → 'random', frontEnabled → 'dynamic',
 *   enabled → 'distance', senao → 'off'.
 *
 * Com a config real (`enabled:false`, `frontEnabled:true`) o lure roda em
 * 'dynamic' e o Target recebia `luring:false` → `lureSkill` (buff ao lurar)
 * nunca era emitido pelo caminho nativo.
 *
 * Estes testes exercitam o PONTO DE ENTRADA (`createAutomation().tick`), nao a
 * funcao de normalizacao isolada — para provar que o contexto chega ao Target.
 */
const lureSkillConfig = (luringPatch, skillPatch = {}) => config({
  target: {
    monsters: [{ name: 'Wild', range: 20, minCount: 1, priority: 1 }],
    combo: { enabled: false, sequenceText: '', stepDelay: 250 },
    lureSkill: { enabled: true, move: 'm9', hpPercent: 90, ...skillPatch },
    luring: { maxDistance: 8, ...luringPatch },
  },
});

/* Alvo proximo e vida cheia: nada bloqueia a emissao do lureSkill. */
const lureSnapshot = (patch = {}) => snapshot({ healthPercent: 100, creatures: [creature(7, 101, 100)], ...patch });

/* O buff sai como `talk <move>`; `attack` tambem sai, entao procuramos o talk. */
const lureSkillTalks = recorder => recorder.events.filter(e => e.name === 'talk' && e.parameter === 'm9');

test('lure context: all options off sends no lureSkill', () => {
  let clock = 0;
  const automation = createAutomation(lureSkillConfig({ enabled: false, frontEnabled: false, randomEnabled: false }),
    { now: () => clock });
  const recorder = createRecorder();
  automation.tick(lureSnapshot(), recorder);
  assert.equal(lureSkillTalks(recorder).length, 0, 'modo off nao deve buffer');
});

test('lure context: only enabled on (distance) sends lureSkill', () => {
  let clock = 0;
  const automation = createAutomation(lureSkillConfig({ enabled: true, frontEnabled: false, randomEnabled: false }),
    { now: () => clock });
  const recorder = createRecorder();
  automation.tick(lureSnapshot(), recorder);
  assert.equal(lureSkillTalks(recorder).length, 1, 'distance e modo ativo');
});

test('lure context: only frontEnabled on (dynamic) sends lureSkill', () => {
  /* ESTE E' O CASO DA CONFIG REAL: enabled=false + frontEnabled=true.
   * Antes da correcao o Target recebia luring=false e nada saia. */
  let clock = 0;
  const automation = createAutomation(lureSkillConfig({ enabled: false, frontEnabled: true, randomEnabled: false }),
    { now: () => clock });
  const recorder = createRecorder();
  automation.tick(lureSnapshot(), recorder);
  assert.equal(lureSkillTalks(recorder).length, 1, 'dynamic e modo ativo');
});

test('lure context: only randomEnabled on (random) sends lureSkill', () => {
  let clock = 0;
  const automation = createAutomation(lureSkillConfig({ enabled: false, frontEnabled: false, randomEnabled: true }),
    { now: () => clock });
  const recorder = createRecorder();
  automation.tick(lureSnapshot(), recorder);
  assert.equal(lureSkillTalks(recorder).length, 1, 'random e modo ativo');
});

test('lure context: any active option is enough, whatever the precedence', () => {
  /* Precedencia do lure-engine: random > dynamic > distance. O contexto so'
   * precisa responder "existe modo ativo?". Testamos as tres combinacoes. */
  for (const patch of [
    { enabled: true, frontEnabled: true, randomEnabled: true },
    { enabled: false, frontEnabled: true, randomEnabled: true },
    { enabled: true, frontEnabled: false, randomEnabled: true },
    { enabled: true, frontEnabled: true, randomEnabled: false },
  ]) {
    let clock = 0;
    const automation = createAutomation(lureSkillConfig(patch), { now: () => clock });
    const recorder = createRecorder();
    automation.tick(lureSnapshot(), recorder);
    assert.equal(lureSkillTalks(recorder).length, 1, 'combinacao ativa: ' + JSON.stringify(patch));
  }
});

test('lure context: lureSkill respects hp threshold and cooldown', () => {
  let clock = 0;
  const automation = createAutomation(lureSkillConfig({ frontEnabled: true }),
    { now: () => clock });

  /* HP abaixo do limite (90) nao emite. */
  let recorder = createRecorder();
  automation.tick(lureSnapshot({ healthPercent: 50 }), recorder);
  assert.equal(lureSkillTalks(recorder).length, 0, 'hp 50 < 90 nao emite');

  /* HP no limite emite. */
  recorder = createRecorder();
  automation.tick(lureSnapshot({ healthPercent: 95, tick: 2 }), recorder);
  assert.equal(lureSkillTalks(recorder).length, 1, 'hp 95 >= 90 emite');

  /* Cooldown SKILL_RETRY_MS (300): dentro da janela nao repete. */
  clock = 100;
  recorder = createRecorder();
  automation.tick(lureSnapshot({ healthPercent: 95, tick: 3 }), recorder);
  assert.equal(lureSkillTalks(recorder).length, 0, 'dentro do cooldown nao repete');

  /* Passado o cooldown, volta a emitir. */
  clock = 400;
  recorder = createRecorder();
  automation.tick(lureSnapshot({ healthPercent: 95, tick: 4 }), recorder);
  assert.equal(lureSkillTalks(recorder).length, 1, 'apos cooldown emite de novo');
});

test('lure context: disabled lureSkill never emits even with an active lure mode', () => {
  let clock = 0;
  const automation = createAutomation(
    lureSkillConfig({ frontEnabled: true }, { enabled: false }), { now: () => clock });
  const recorder = createRecorder();
  automation.tick(lureSnapshot(), recorder);
  assert.equal(lureSkillTalks(recorder).length, 0, 'lureSkill.enabled=false manda mais');
});

test('walker waits for a new position sample rather than repeating a walk command', () => {
  const engine = createWalkerEngine(config({ walker: { waypoints: [
    { action: 'walk', pos: { x: 104, y: 100, z: 7 } },
  ] } }));
  const recorder = createRecorder();
  const first = { tick: 10, position: { x: 100, y: 100, z: 7 } };
  assert.equal(engine.step(first, recorder, 0).action, 'move');
  for (let now = 100; now <= 700; now += 100) {
    assert.equal(engine.step(first, recorder, now).reason, 'await-position-sample');
  }
  assert.equal(engine.step({ tick: 11, position: { x: 101, y: 100, z: 7 } }, recorder, 800).action, 'move');
  assert.deepEqual(recorder.events.map(event => event.parameter), [DIRECTIONS.east, DIRECTIONS.east]);
  assert.equal(engine.state.index, 0);
});

test('automation resumes the same waypoint once the last enemy disappears after a combo', () => {
  let clock = 0;
  const automation = createAutomation(config({
    target: { combo: { enabled: true, sequenceText: 'm1' } },
    walker: { waypoints: [{ action: 'walk', pos: { x: 110, y: 100, z: 7 } }] },
  }), { now: () => clock });
  assert.equal(automation.tick(snapshot()).walk.action, 'move');
  clock = 1000;
  const fighting = automation.tick(snapshot({ tick: 2, position: { x: 101, y: 100, z: 7 },
    creatures: [creature(1, 102, 100)] }));
  assert.equal(fighting.status, 'combat');
  assert.ok(fighting.emitted.some(([name, parameter]) => name === 'talk' && parameter === 'm1'));
  assert.equal(fighting.walk.action, 'skipped');
  clock = 2000;
  const resumed = automation.tick(snapshot({ tick: 3, position: { x: 101, y: 100, z: 7 } }));
  assert.equal(resumed.status, 'walking');
  assert.equal(resumed.walk.action, 'move');
  assert.equal(resumed.walk.index, 0);
});

test('every emitted command is encodable by the reconstructed protocol', () => {
  const sent = [];
  const sink = createProtocolSink(bytes => sent.push(bytes));
  const engine = createTargetEngine(config({ target: { combo: { enabled: true, sequenceText: 'm1 m2' } } }));
  engine.step({ position: { x: 100, y: 100, z: 7 }, activeSlot: 1, roster, pokemonName: 'Charizard', healthPercent: 100,
    creatures: [creature(7, 101, 100)] }, sink, 0);
  engine.step({ position: { x: 100, y: 100, z: 7 }, activeSlot: 1, roster, pokemonName: 'Charizard', healthPercent: 100,
    creatures: [creature(7, 101, 100)] }, sink, 300);
  const walker = createWalkerEngine(config({ walker: { waypoints: [{ action: 'walk', pos: { x: 101, y: 100, z: 7 } }] } }));
  walker.step({ position: { x: 100, y: 100, z: 7 } }, sink, 400);
  const healer = createHealerEngine({ healer: { healHpPercent: 60, healPokemonName: 'Charizard', healMoveSlot: 1 }, hoenn: {} });
  healer.step({ healthPercent: 30, roster, pokemonName: 'Charizard', activeSlot: 1 }, sink, 500);
  assert.ok(sent.length >= 4);
  for (const bytes of sent) {
    assert.ok(Buffer.isBuffer(bytes));
    assert.equal(bytes.readUInt32LE(0) > 0, true);
    assert.ok(bytes.readUInt32LE(4) >= 1 && bytes.readUInt32LE(4) <= 25);
  }
});

const scannerSnapshot = (creatures, now = 0, patch = {}) => ({
  schema: 2, pid: 10, generatedAt: new Date(now).toISOString(),
  player: { name: 'Player', pos: { x: 100, y: 100, z: 7 } }, creatures, ...patch,
});

test('all F1 through F12 rotate once each and respect range and refreshed HP', () => {
  let now = 0;
  const automation = createAutomation(config({ target: { skills: Array.from({ length: 12 }, (_, index) => ({
    key: `F${index + 1}`, minDistance: 2, maxDistance: 2, onlyIfHpBelow: 50,
  })) } }), { now: () => now });
  assert.deepEqual(automation.tick(snapshot({ creatures: [creature(7, 101, 100)] })).emitted,
    [['attack', 7]]);
  const keys = [];
  for (let index = 0; index < 12; index += 1) {
    const result = automation.tick(snapshot({ creatures: [creature(7, 102, 100, { healthPercent: 10 })] }));
    keys.push(...result.emitted.filter(([name]) => name === 'hotkey').map(([, key]) => key));
    now += 250;
  }
  assert.deepEqual(keys, Array.from({ length: 12 }, (_, index) => `f${index + 1}`));
});

test('scanner snapshots feed the real tick, sticky lock and protocol hotkeys at 250ms', () => {
  let now = 0;
  let scan = scannerSnapshot([creature(7, 102, 100)]);
  const automation = createAutomation(config({ target: { skills: [
    { key: 'F1', cooldownMs: 1000 }, { key: 'F12', cooldownMs: 500 },
  ] } }), { now: () => now, creatureSource: () => scan });
  const bytes = [];
  const sink = createProtocolSink(packet => bytes.push(packet));
  const tick = () => automation.tick(snapshot(), sink);
  assert.deepEqual(tick().emitted, [['attack', 7], ['hotkey', 'f1']]);
  scan = scannerSnapshot([creature(8, 101, 100), creature(7, 103, 100, { healthPercent: 10 })]);
  now = 249;
  assert.deepEqual(tick().emitted, []);
  now = 250;
  assert.deepEqual(tick().emitted, [['hotkey', 'f12']]);
  assert.equal(automation.state.target.targetId, 7);
  now = 500;
  assert.deepEqual(tick().emitted, []);
  now = 750;
  assert.deepEqual(tick().emitted, [['hotkey', 'f12']]);
  now = 1000;
  scan = scannerSnapshot([creature(7, 103, 100, { healthPercent: 0 }), creature(8, 101, 100)], now);
  assert.deepEqual(tick().emitted, [['attack', 8], ['hotkey', 'f1']]);
  assert.deepEqual(bytes.filter(packet => packet.readUInt32LE(4) === 20)
    .map(packet => packet.subarray(24).toString()), ['f1', 'f12', 'f12', 'f1']);
});

test('scanner integration rejects stale, future, foreign, malformed and errored snapshots', () => {
  for (const patch of [{ pid: 11 }, { schema: 1 }, { generatedAt: 'bad' },
    { generatedAt: new Date(1).toISOString() }, { generatedAt: new Date(-1001).toISOString() },
    { creatures: null }, { error: 'scanner failed' },
    { player: { name: 'Player', pos: { x: 100, y: 100, z: 8 } } },
    { player: { name: 'Player', pos: null } },
    { player: { name: 'Other', pos: { x: 100, y: 100, z: 7 } } }]) {
    const automation = createAutomation(config(), { now: () => 0,
      creatureSource: () => scannerSnapshot([creature(7, 101, 100)], 0, patch) });
    const recorder = createRecorder();
    assert.equal(automation.tick(snapshot({ playerName: 'Player' }), recorder).status, 'blocked');
    assert.deepEqual(recorder.events, []);
  }
});

test('scanner failures and native gates never fall back to old creatures or bypass readiness', () => {
  let calls = 0;
  const automation = createAutomation(config(), { now: () => 0, creatureSource: () => {
    calls += 1;
    throw Error('incomplete file');
  } });
  assert.equal(automation.tick(snapshot({}, { online: false })).reason, 'offline');
  assert.equal(calls, 0);
  const recorder = createRecorder();
  assert.equal(automation.tick(snapshot({ creatures: [creature(7, 101, 100)] }), recorder).reason,
    'creature-snapshot');
  assert.deepEqual(recorder.events, []);
});

test('adapter filters players, dead, foreign floors, unknown fields and invalid hotkeys', () => {
  const automation = createAutomation(config({ target: { skills: [
    { key: 'F13' }, { key: 'm1' }, { key: 'F0' }, { key: 'F2' },
  ] } }), { now: () => 0 });
  const result = automation.tick(snapshot({ playerName: 'Player', creatures: [
    creature(1, 100, 100, { is_player: true }), creature(2, 100, 100, { name: 'PLAYER' }),
    creature(3, 100, 100, { healthPercent: 0 }), creature(4, 100, 100, { healthPercent: null }),
    creature(5, 100, 100, { pos: { x: 100, y: 100, z: 8 } }),
    creature(6, 100, 100, { canAttack: null }), creature(7, 101, 100),
  ] }));
  assert.deepEqual(result.emitted, [['attack', 7], ['hotkey', 'f2']]);
});

test('hotkey GCD survives target changes and blocked ticks, and reset is explicit', () => {
  let now = 0;
  const automation = createAutomation(config({ target: { globalCooldownMs: 0,
    skills: [{ key: 'F1', cooldownMs: 1000 }, { key: 'F2' }] } }), { now: () => now });
  const tick = (id, patch) => automation.tick(snapshot({ creatures: [creature(id, 101, 100)] }, patch));
  assert.equal(tick(7).emitted[1][1], 'f1');
  now = 100;
  assert.equal(tick(7, { paused: true }).status, 'blocked');
  assert.equal(automation.state.target.targetId, null);
  assert.deepEqual(tick(8).emitted, [['attack', 8]]);
  now = 250;
  assert.deepEqual(tick(8).emitted, [['hotkey', 'f2']]);
  automation.reset();
  assert.equal(automation.state.target.targetId, null);
  assert.deepEqual(tick(8).emitted, [['attack', 8], ['hotkey', 'f1']]);
});

test('healer and combat share the global hotkey cooldown', () => {
  let now = 0;
  const automation = createAutomation(config({ target: { skills: [{ key: 'F2' }] },
    hoenn: { potionHpPercent: 50, potionHotkey: 'F1', potionCooldownMs: 1000 } }),
  { now: () => now });
  assert.deepEqual(automation.tick(snapshot({ ownPokemon: { healthPercent: 40 } })).emitted, [['hotkey', 'F1']]);
  now = 100;
  assert.deepEqual(automation.tick(snapshot({ creatures: [creature(7, 101, 100)] })).emitted,
    [['attack', 7]]);
  now = 250;
  assert.deepEqual(automation.tick(snapshot({ creatures: [creature(7, 101, 100)] })).emitted,
    [['hotkey', 'f2']]);
});

test('bridge merges copies without forging native verification, and reloads file on each tick', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'creature-bridge-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'creatures.json');
  const original = scannerSnapshot([creature(7, 101, 100)]);
  const session = snapshot();
  assert.equal(mergeCreatureSnapshot(session, original, 1000).telemetry.creatures.length, 1);
  assert.throws(() => mergeCreatureSnapshot(session, original, 1001));
  assert.throws(() => mergeCreatureSnapshot(session, original, 0, -1));
  const merged = mergeCreatureSnapshot(session, original, 0);
  merged.telemetry.creatures[0].pos.x = 999;
  assert.equal(original.creatures[0].pos.x, 101);
  assert.deepEqual(session.telemetry.creatures, []);
  assert.equal(mergeCreatureSnapshot(snapshot({ nativeVerified: false }), original, 0)
    .telemetry.nativeVerified, false);
  fs.writeFileSync(file, JSON.stringify(original));
  let now = 0;
  const automation = createAutomation(config(), { now: () => now,
    creatureSource: createCreatureSource(file, { now: () => now }) });
  assert.equal(automation.tick(session).fight.targetId, 7);
  fs.writeFileSync(file, JSON.stringify(scannerSnapshot([creature(8, 102, 100)])));
  assert.equal(automation.tick(session).fight.targetId, 8);
  fs.writeFileSync(file, '{');
  assert.equal(automation.tick(session).fight.targetId, 8);
  now = 1001;
  assert.equal(automation.tick(session).status, 'blocked');
  assert.equal(automation.state.target.targetId, null);
});

test('native autocombo triggers hotkey when configured', () => {
  const engine = createTargetEngine(config({ target: { combo: { enabled: true, useNativeSequence: true, nativeHotkey: 'F5', stepDelay: 500 } } }));
  const recorder = createRecorder();
  const result = engine.step({ position: { x: 100, y: 100, z: 7 }, activeSlot: 1, roster, pokemonName: 'Charizard', healthPercent: 100,
    creatures: [creature(7, 101, 100)] }, recorder, 0);
  assert.equal(result.action, 'combo');
  assert.equal(result.native, true);
  assert.deepEqual(recorder.events.map(event => [event.name, event.parameter]), [['attack', 7], ['hotkey', 'F5']]);
});

test('combo Medicine handles debuff without consuming the AutoCombo hotkey', () => {
  const engine = createTargetEngine(config({ target: {
    combo: { enabled: true, useNativeSequence: true, nativeHotkey: 'C',
      useMedicine: true, medicineHotkey: 'E', medicineDelayMs: 100 },
  } }));
  const telemetry = { position: { x: 100, y: 100, z: 7 }, conditions: ['poison'],
    creatures: [creature(7, 101, 100)] };
  const recorder = createRecorder();
  assert.equal(engine.step(telemetry, recorder, 0).reason, 'medicine-sent');
  assert.equal(engine.step(telemetry, recorder, 99).reason, 'medicine-wait');
  engine.step({ ...telemetry, conditions: [] }, recorder, 100);
  assert.deepEqual(recorder.events.filter(event => event.name === 'hotkey').map(event => event.parameter), ['E', 'C']);
});

test('native autocombo falls back to !autocombo when sequence is empty and no hotkey', () => {
  const engine = createTargetEngine(config({ target: { combo: { enabled: true, useNativeSequence: true, stepDelay: 500 } } }));
  const recorder = createRecorder();
  const result = engine.step({ position: { x: 100, y: 100, z: 7 }, activeSlot: 1, roster, pokemonName: 'Charizard', healthPercent: 100,
    creatures: [creature(7, 101, 100)] }, recorder, 0);
  assert.equal(result.action, 'combo');
  assert.equal(result.native, true);
  assert.deepEqual(recorder.events.map(event => [event.name, event.parameter]), [['attack', 7], ['combo', '!autocombo']]);
});

test('healer safety blocks healing and switch when pokemon has debuff/conditions', () => {
  const engine = createHealerEngine({ healer: { healHpPercent: 70, healPokemonName: 'Blastoise', healMoveSlot: 1 },
    hoenn: { useMedicine: false } }, { switchBeforeHeal: true });
  const recorder = createRecorder();
  const telemetry = { healthPercent: 40, conditions: [{ type: 'poison' }], roster: [{ name: 'Blastoise', uuid: 'b-uuid' }, { name: 'Charizard', uuid: 'c-uuid' }],
    pokemonName: 'Charizard', activeSlot: 1 };
  const result = engine.step(telemetry, recorder, 0);
  assert.equal(result.action, 'idle');
  assert.ok(result.blocked.includes('combat-pokemon-debuffed'));
  assert.equal(recorder.events.length, 0);
});

test('healer safety blocks healMove while pokemon is switching', () => {
  const engine = createHealerEngine({ healer: { healHpPercent: 70, healPokemonName: 'Blastoise', healMoveSlot: 1 },
    hoenn: {} }, { switchBeforeHeal: true });
  const recorder = createRecorder();
  const telemetry = { healthPercent: 40, conditions: [], roster: [{ name: 'Blastoise', uuid: 'b-uuid' }, { name: 'Charizard', uuid: 'c-uuid' }],
    pokemonName: 'Charizard', activeSlot: 1 };
  // First tick triggers switchPokemon
  const first = engine.step(telemetry, recorder, 0);
  assert.equal(first.action, 'heal');
  assert.deepEqual(recorder.events.map(e => [e.name, e.parameter]), [['switchPokemon', 'Blastoise']]);

  // Second tick before switch confirmed (still Charizard) must not send talk m1
  const recorder2 = createRecorder();
  const second = engine.step(telemetry, recorder2, 100);
  assert.equal(second.action, 'heal');
  assert.equal(recorder2.events.length, 0);

  // Third tick when switch confirmed (now Blastoise) sends talk m1 safely
  const recorder3 = createRecorder();
  const third = engine.step({ ...telemetry, pokemonName: 'Blastoise' }, recorder3, 200);
  assert.equal(third.action, 'heal');
  assert.deepEqual(recorder3.events.map(e => [e.name, e.parameter]), [['talk', 'm1']]);
});

test('combo perfect lure holds combo when monster is outside 3x3 of own pokemon', () => {
  const engine = createTargetEngine(config({ target: { combo: { enabled: true, sequenceText: 'm1', perfectingLureEnabled: true, perfectingLureRange: 1, perfectingLureHpPercent: 30 } } }));
  const recorder = createRecorder();
  const pet = { id: 99, pos: { x: 100, y: 100, z: 7 }, healthPercent: 100 };
  const monsterFar = { id: 7, name: 'Magnemite', pos: { x: 105, y: 100, z: 7 }, canAttack: true, creatureType: 1, healthPercent: 100 };
  const telemetry = { position: { x: 100, y: 100, z: 7 }, ownPokemon: pet, activeSlot: 1, roster, pokemonName: 'Diglett', healthPercent: 100, creatures: [monsterFar] };

  // Waiting for the box must not attack: attacking here would kill the clump.
  const res1 = engine.step(telemetry, recorder, 0);
  assert.equal(res1.reason, 'waiting-perfect-lure');
  assert.deepEqual(recorder.events, []);

  // Second step still outside 3x3
  const res2 = engine.step(telemetry, recorder, 100);
  assert.equal(res2.reason, 'waiting-perfect-lure');
  assert.deepEqual(recorder.events, []);

  // When monster enters 3x3 (e.g. at 101, 100)
  const monsterNear = { ...monsterFar, pos: { x: 101, y: 100, z: 7 } };
  const res3 = engine.step({ ...telemetry, creatures: [monsterNear] }, recorder, 200);
  assert.equal(res3.action, 'combo');
  assert.deepEqual(recorder.events.map(e => e.name), ['attack', 'talk']);
  assert.equal(recorder.events.at(-1).parameter, 'm1');
});

test('minCount counts per rule range around the Pokemon, not the widest range', () => {
  const engine = createTargetEngine(config({ target: { monsters: [
    { name: 'Boss*', range: 2, priority: 1, minCount: 2 },
    { name: '*', range: 20, priority: 2, minCount: 9 },
  ] } }));
  const recorder = createRecorder();
  const pet = { id: 99, pos: { x: 100, y: 100, z: 7 }, healthPercent: 100 };
  const boss = (id, x) => creature(id, x, 100, { name: 'Boss1' });
  const wild = (id, x) => creature(id, x, 100, { name: 'Rattata' });
  const telemetry = { position: { x: 100, y: 100, z: 7 }, ownPokemon: pet, activeSlot: 1, roster,
    pokemonName: 'Charizard', healthPercent: 100,
    creatures: [boss(1, 103), boss(2, 103), ...Array.from({ length: 8 }, (_, i) => wild(10 + i, 105))] };

  // Bosses are 3 tiles from the pet (outside their range 2); the 8 wilds are
  // inside range 20 but below the 9 required. Counting with max(range) from
  // the widest rule would have engaged the two bosses.
  const result = engine.step(telemetry, recorder, 0);
  assert.equal(result.action, 'luring');
  assert.deepEqual(recorder.events, []);
});

test('healthy Pokemon still opens the perfect lure gate under hoenn.perfectLureMinHp', () => {
  const engine = createTargetEngine(config({
    target: { combo: { enabled: true, sequenceText: 'm1', stepDelay: 250,
      perfectingLureEnabled: true, perfectingLureRange: 1, perfectingLureHpPercent: 10 } },
    hoenn: { perfectLure: true, minWildsToEngage: 1, perfectLureMinHp: 60 },
  }));
  const recorder = createRecorder();
  const pet = { id: 99, pos: { x: 100, y: 100, z: 7 }, healthPercent: 50 };
  const telemetry = { position: { x: 100, y: 100, z: 7 }, ownPokemon: pet, activeSlot: 1, roster,
    pokemonName: 'Charizard', healthPercent: 100, creatures: [creature(7, 105, 100)] };
  const result = engine.step(telemetry, recorder, 0);
  assert.equal(result.action, 'combo');
  assert.deepEqual(recorder.events.map(e => e.name), ['attack', 'talk']);
});

test('perfect lure timeout waits in box waypoints and opens outside them', () => {
  const engine = createTargetEngine(config({
    target: { combo: { enabled: true, sequenceText: 'm1', stepDelay: 250,
      perfectingLureEnabled: true, perfectingLureRange: 1 } },
    hoenn: { perfectLure: true, minWildsToEngage: 1, perfectLureMinHp: 0, perfectLureTimeoutMs: 1000 },
  }));
  const recorder = createRecorder();
  const pet = { id: 99, pos: { x: 100, y: 100, z: 7 }, healthPercent: 100 };
  const telemetry = { position: { x: 100, y: 100, z: 7 }, ownPokemon: pet, activeSlot: 1, roster,
    pokemonName: 'Charizard', healthPercent: 100, creatures: [creature(7, 105, 100)] };
  assert.equal(engine.step(telemetry, recorder, 1000).reason, 'waiting-perfect-lure');
  assert.equal(engine.step(telemetry, recorder, 2500, { boxMode: true }).reason, 'waiting-perfect-lure');
  assert.deepEqual(recorder.events, []);
  assert.equal(engine.step(telemetry, recorder, 2500, { boxMode: false }).action, 'combo');
  assert.deepEqual(recorder.events.map(e => e.name), ['attack', 'talk']);
});
