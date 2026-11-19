'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RpmCombatRuntime } = require('../reconstruction/rpm-combat-runtime.cjs');
const { projectTarget, createCombatInput } = require('../reconstruction/keyboard-combat.cjs');
const { EXECUTABLE_SHA256, LAYOUT_ID } = require('../reconstruction/item-source.cjs');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function captureFixture() {
  const value = fixture();
  value.config.looting = { captureEnabled: true, captureAfterCombat: true, maxCaptureDist: 3,
    captureDelay: 300, captureEntries: [{ corpseId: 4029, ballId: 15650, fallbackBallId: 3156 }] };
  value.transport.captureHotkeys = { '15650': 'B' };
  value.transport.clientConfig = path.join(__dirname, 'fixtures/capture-client.otml');
  value.transport.captureBindingVerification = { source: 'live-confirmation',
    verifiedAt: new Date(1000).toISOString(), useWithActions: [6],
    configSha256: crypto.createHash('sha256').update(fs.readFileSync(value.transport.clientConfig)).digest('hex') };
  const scan = { schemaVersion: 1, pid: 42, generatedAt: value.telemetry.creaturesGeneratedAt,
    processStartedAt: 'session-one', moduleBase: '0x140000000', executableSha256: EXECUTABLE_SHA256,
    layoutId: LAYOUT_ID, complete: true, truncated: false, readErrors: [],
    player: structuredClone(value.telemetry.creaturePlayer),
    itemIdentityProfile: { executableSha256: EXECUTABLE_SHA256, layoutId: LAYOUT_ID },
    items: [{ id: 4029, stack: 2, pos: { x: 101, y: 100, z: 7 }, struct_va: '0x400', tile_va: '0x500' }] };
  value.runtime.itemSource = () => scan;
  return { ...value, scan, refreshItems: () => { scan.generatedAt = value.telemetry.creaturesGeneratedAt; } };
}

test('RPM pipeline waits for combat, dispatches configured ball by corpse ID, then resumes Walker', async () => {
  const value = captureFixture();
  await value.start('walker'); await value.start('target');
  assert.equal((await value.runtime.tick()).action, 'attack');
  assert.equal(value.runtime.state.capture.reason, 'capture-after-combat');
  value.telemetry.creatures = value.telemetry.creatures.filter(creature => creature.creatureType === 3);
  value.advance(); value.refreshItems();
  const index = value.runtime.engine.state.index;
  assert.equal((await value.runtime.tick()).status, 'capture');
  const request = value.events.at(-1).request;
  assert.equal(request.kind, 'useWith'); assert.equal(request.key, 'B');
  assert.equal(request.itemId, 15650); assert.equal(request.targetId, 4029);
  assert.equal(request.x, 432); assert.equal(request.itemGuard.item.struct_va, '0x400');
  assert.equal(value.runtime.engine.state.index, index);
  assert.equal(value.runtime.state.capture.effectVerified, false);
  value.advance(); value.refreshItems(); await value.runtime.tick();
  assert.equal(value.events.filter(event => event.request?.kind === 'useWith').length, 1);
  assert.equal(value.events.at(-1).input[1], 1);
});

test('RPM does not infer a corpse from disappearance, timeouts or failed item reads', async () => {
  for (const modify of [scan => { scan.items = []; }, scan => { scan.complete = false; },
    scan => { scan.pid = 99; }, scan => { scan.generatedAt = new Date(1).toISOString(); },
    scan => { scan.items[0].id = 77; }, scan => { scan.readErrors = ['RPM failed']; }]) {
    const value = captureFixture(); modify(value.scan);
    value.telemetry.creatures = value.telemetry.creatures.filter(creature => creature.creatureType === 3);
    await value.start('target'); await value.runtime.tick();
    assert.equal(value.events.filter(event => event.request).length, 0);
  }
});

test('RPM revalidates the latest item stream and blocks a moved corpse before input', async () => {
  const value = captureFixture(); let reads = 0;
  value.config.looting.captureAfterCombat = false;
  value.runtime.itemSource = () => {
    reads++;
    return reads === 1 ? value.scan : { ...value.scan, items: [] };
  };
  await value.start('walker'); await value.runtime.tick();
  assert.equal(value.events.filter(event => event.request).length, 0);
  assert.equal(value.runtime.state.capture.status, 'blocked');
});

test('RPM uncertain useWith pauses without retry or falsely reporting capture', async () => {
  const value = captureFixture(); let attempts = 0;
  value.config.looting.captureAfterCombat = false;
  value.runtime.combatInput = async () => { attempts++; throw Error('partial: two messages queued'); };
  await value.start('walker');
  assert.equal((await value.runtime.tick()).status, 'error');
  value.advance(); value.refreshItems(); assert.equal(await value.runtime.tick(), null);
  assert.equal(attempts, 1); assert.equal(value.runtime.state.paused, true);
  assert.equal(value.runtime.state.capture.effectVerified, false);
});

test('Walker-only after-combat capture requires independent fresh combat perception', async () => {
  const value = captureFixture(); await value.start('walker');
  await value.runtime.tick();
  assert.equal(value.events.filter(event => event.request?.kind === 'useWith').length, 0);
  assert.equal(value.runtime.state.capture.reason, 'capture-after-combat');
  value.advance(); value.refreshItems();
  value.telemetry.creaturesGeneratedAt = new Date(1).toISOString();
  await value.runtime.tick();
  assert.equal(value.events.filter(event => event.request?.kind === 'useWith').length, 0);
});

test('Adding Walker preserves combat GCD while its movement clock is independent', async () => {
  const value = fixture(); await value.start('target');
  await value.runtime.tick(); await value.start('walker');
  assert.equal((await value.runtime.tick()).status, 'walking');
  assert.equal(value.events.filter(event => event.request).length, 1);
  value.advance(250); await value.runtime.tick();
  assert.equal(value.events.filter(event => event.request).length, 2);
});

function fixture() {
  let clock = 10000;
  const events = [];
  const config = { target: { monsters: [{ name: 'Rat*', priority: 1, range: 7 }],
    combo: { enabled: true, useNativeSequence: false, sequenceText: 'm1 m2', stepDelay: 250 } },
  /* `stepIntervalMs: 0`: o fixture avanca o relogio em 300 ms, abaixo do piso
   * de 406 ms medido no cliente. O piso tem teste proprio em
   * `tests/engines.test.cjs`. */
  walker: { loop: false, stepIntervalMs: 0, waypoints: [{ action: 'walk', pos: { x: 103, y: 100, z: 7 } }] } };
  const telemetry = { nativeVerified: false, playerName: 'Ash', position: { x: 100, y: 100, z: 7 },
    creaturesStale: false, creaturesGeneratedAt: new Date(clock).toISOString(),
    creatureIdentityProfile: { executableSha256: '473df25c1edd23e7464ad3ba9b923a603051a8b4ae8004a95c06402f678294e6', typeOffset: '0x186' },
    creaturePlayer: { id: 0x10000001, name: 'Ash', pos: { x: 100, y: 100, z: 7 },
      creatureType: 0, ownershipVerified: true, struct_va: '0x200' },
    creatures: [{ id: 7, name: 'Rattata', pos: { x: 101, y: 100, z: 7 }, healthPercent: 100,
      canAttack: true, creatureType: 1, ownershipVerified: true, struct_va: '0x300' },
    { id: 1003, name: 'Eevee', pos: { x: 100, y: 101, z: 7 }, healthPercent: 100,
      canAttack: false, creatureType: 3, isOwnPokemon: true, ownershipVerified: true, struct_va: '0x100' }] };
  const transport = { bindings: { m1: 'F1', m2: 'F2', '!autocombo': 'C' }, cooldownsMs: {},
    viewport: { width: 800, height: 600, centerX: 400, centerY: 300, tileSize: 32,
      map: { left: 100, top: 100, right: 700, bottom: 500 } } };
  const runtime = new RpmCombatRuntime({ automatic: false, now: () => clock, playerName: 'Ash',
    getSession: () => ({ pid: 42, source: 'rpm', online: true, generatedAt: new Date(clock).toISOString(), telemetry }),
    loadTransport: () => transport,
    input: async (...args) => { events.push({ input: args }); },
    combatInput: async (pid, request) => {
      events.push({ pid, request });
      return { success: true, pid, hwnd: '0x42', eventsSent: 2, foreground: true };
    },
  });
  return { runtime, config, events, telemetry, transport, advance: (ms = 300, fresh = true) => {
    clock += ms; if (fresh) telemetry.creaturesGeneratedAt = new Date(clock).toISOString(); },
    start: module => runtime.setModules(module, true, 42, config),
  };
}

test('temporary player snapshot skew blocks input without permanently pausing Target and Walker', async () => {
  const value = fixture(); await value.start('walker'); await value.start('target');
  await value.runtime.tick(); value.advance();
  const count = value.events.length;
  const queue = structuredClone(value.runtime.queue);
  const waypoint = value.runtime.engine.state.index;
  value.telemetry.position.x++;
  assert.equal((await value.runtime.tick()).status, 'synchronizing');
  assert.equal(value.runtime.paused, false);
  assert.equal(value.events.length, count);
  assert.deepEqual(value.runtime.queue, queue);
  assert.equal(value.runtime.engine.state.index, waypoint);
  value.advance(); value.telemetry.creaturePlayer.pos.x++;
  assert.equal((await value.runtime.tick()).action, 'talk');
  assert.equal(value.events.findLast(event => event.request)?.request.key, 'F1');
  assert.equal(value.runtime.paused, false);
});

test('persistent player snapshot skew still pauses without dispatching', async () => {
  const value = fixture(); await value.start('target');
  const count = value.events.length;
  value.telemetry.position.x++;
  assert.equal((await value.runtime.tick()).status, 'synchronizing');
  value.advance(501);
  assert.equal((await value.runtime.tick()).status, 'error');
  assert.equal(value.runtime.paused, true);
  assert.equal(value.events.length, count);
});

test('snapshot skew immediately before dispatch preserves the unsent attack for reprojection', async () => {
  const value = fixture(); await value.start('target');
  const inspect = value.runtime.combat.inspect.bind(value.runtime.combat);
  value.runtime.combat.inspect = (...args) => {
    const candidates = inspect(...args);
    value.telemetry.position.x = 101;
    return candidates;
  };
  const count = value.events.length;
  assert.equal((await value.runtime.tick()).status, 'synchronizing');
  assert.equal(value.events.length, count);
  assert.equal(value.runtime.queue[0].name, 'attack');
  value.telemetry.creaturePlayer.pos.x = 101; value.advance();
  assert.equal((await value.runtime.tick()).action, 'attack');
  assert.equal(value.events.at(-1).request.x, 400);
});

test('RPM target uses real entity schema, queues attack then configured keys with GCD', async () => {
  const value = fixture(); await value.start('target');
  assert.equal(value.runtime.sessions[0].telemetry.nativeVerified, false);
  assert.equal((await value.runtime.tick()).action, 'attack');
  assert.equal(value.events.at(-1).request.x, 432);
  assert.equal(await value.runtime.tick(), null);
  value.advance(249); assert.equal(await value.runtime.tick(), null);
  value.advance(1); assert.equal((await value.runtime.tick()).action, 'talk');
  assert.equal(value.events.at(-1).request.key, 'F1');
  value.advance(); await value.runtime.tick();
  assert.equal(value.events.at(-1).request.key, 'F2');
  assert.equal(value.runtime.state.targetEffectVerified, false);
});

test('RPM sends the configured lure skill while Target luring is enabled', async () => {
  const value = fixture();
  value.config.target.luring = { enabled: true };
  value.config.target.lureSkill = { enabled: true, hpPercent: 50, move: 'm3' };
  value.transport.bindings.m3 = 'F3'; value.telemetry.healthPercent = 100;
  await value.start('target');
  await value.runtime.tick();
  value.advance();
  assert.equal((await value.runtime.tick()).action, 'talk');
  assert.equal(value.events.at(-1).request.key, 'F3');
});

test('RPM ignores the configured lure skill while Target luring is disabled', async () => {
  const value = fixture();
  value.config.target.lureSkill = { enabled: true, hpPercent: 50, move: 'm3' };
  value.transport.bindings.m3 = 'F3'; value.telemetry.healthPercent = 100;
  await value.start('target');
  await value.runtime.tick();
  value.advance();
  assert.equal((await value.runtime.tick()).action, 'talk');
  assert.equal(value.events.at(-1).request.key, 'F1');
});

test('Target activation and deactivation preserve the running Walker and its index', async () => {
  const value = fixture(); await value.start('walker');
  const engine = value.runtime.engine;
  await value.start('target');
  assert.equal(value.runtime.engine, engine);
  assert.deepEqual(value.runtime.modules, ['walker', 'target']);
  await value.runtime.setModules('target', false);
  assert.equal(value.runtime.engine, engine);
  assert.deepEqual(value.runtime.modules, ['walker']);
  assert.equal(value.runtime.paused, false);
  await value.runtime.tick(); assert.equal(value.events.at(-1).input[1], 1);
});

test('combat permits movement and dead targets discard queued skills without stopping Walker', async () => {
  const value = fixture(); await value.start('walker'); await value.start('target');
  await value.runtime.tick();
  assert.equal(value.events.filter(event => event.input?.[1] !== null && event.input).length, 1);
  value.telemetry.creatures[0].healthPercent = 0;
  value.advance(); await value.runtime.tick();
  assert.equal(value.events.at(-1).input[1], 1);
  assert.equal(value.events.some(event => event.request?.kind === 'key'), false);
});

test('priority selection, player exclusion and conflicting duplicate IDs are honored', async () => {
  const value = fixture();
  value.config.target.monsters = [{ name: 'Priority', priority: 0, range: 7 }, { name: '*', priority: 1, range: 7 }];
  value.telemetry.creatures.push({ ...value.telemetry.creatures[0], id: 8, name: 'Priority', pos: { x: 102, y: 100, z: 7 } },
    { ...value.telemetry.creatures[0], id: 0x10000001, name: 'Priority' },
    { ...value.telemetry.creatures[0], id: 9, name: 'Priority' },
    { ...value.telemetry.creatures[0], id: 9, name: 'Priority', healthPercent: 10 });
  await value.start('target'); await value.runtime.tick();
  assert.equal(value.runtime.state.selectedTargetId, 8);
  assert.ok(!value.runtime.sessions[0].telemetry.creatures.some(creature => creature.id === 9));
});

test('stale perception stops both modules before any extra input', async () => {
  const value = fixture(); await value.start('walker'); await value.start('target');
  value.telemetry.creaturesStale = true;
  const count = value.events.length;
  assert.equal((await value.runtime.tick()).status, 'error');
  assert.equal(value.runtime.paused, true);
  assert.equal(value.events.length, count);
});

test('individual configured cooldowns remain effective after reconfiguring Target', async () => {
  const value = fixture(); value.transport.cooldownsMs.f1 = 2000;
  await value.start('target'); await value.runtime.tick(); value.advance(); await value.runtime.tick();
  value.config.target.combo.sequenceText = 'm1';
  value.runtime.updateConfig(value.config); value.advance(); await value.runtime.tick();
  value.advance(); assert.equal(await value.runtime.tick(), null);
  value.advance(2000); await value.runtime.tick();
  assert.equal(value.events.filter(event => event.request?.key === 'F1').length, 2);
});

test('Target-only pause can resume and stop-all cancels its pending rotation', async () => {
  const value = fixture(); await value.start('target'); await value.runtime.tick();
  await value.runtime.togglePause(); assert.equal(value.runtime.paused, true);
  await value.runtime.togglePause(); assert.equal(value.runtime.paused, false);
  await value.runtime.setModules('all', false);
  value.advance(); assert.equal(await value.runtime.tick(), null);
  assert.deepEqual(value.runtime.modules, []);
});

test('projection rejects absent calibration, another floor and off-map targets', () => {
  const value = fixture(); const creature = value.telemetry.creatures[0];
  assert.throws(() => projectTarget(null, value.telemetry.position, creature));
  assert.throws(() => projectTarget(value.transport.viewport, { ...value.telemetry.position, z: 8 }, creature));
  assert.throws(() => projectTarget(value.transport.viewport, value.telemetry.position, { ...creature, pos: { x: 999, y: 100, z: 7 } }));
});

test('Target start revalidates creature freshness after acquiring focus', async () => {
  const value = fixture();
  value.runtime.input = async () => { value.telemetry.creaturesStale = true; };
  await assert.rejects(value.start('target'), /desatualizada/u);
  assert.equal(value.runtime.paused, true);
  assert.deepEqual(value.runtime.modules, []);
});

test('Target resume rejects telemetry that expires during focus acquisition', async () => {
  const value = fixture(); await value.start('target'); await value.runtime.togglePause();
  value.runtime.input = async () => { value.advance(1500); };
  const getSession = value.runtime.getSession;
  const session = getSession();
  value.runtime.getSession = () => session;
  await assert.rejects(value.runtime.togglePause(), /desatualizada/u);
  assert.equal(value.runtime.paused, true);
  assert.deepEqual(value.runtime.modules, ['target']);
});

test('Target resume rejects stale creatures before attempting focus', async () => {
  const value = fixture(); await value.start('target'); await value.runtime.togglePause();
  value.telemetry.creaturesStale = true;
  const count = value.events.length;
  await assert.rejects(value.runtime.togglePause(), /desatualizada/u);
  assert.equal(value.events.length, count);
  assert.equal(value.runtime.paused, true);
});

test('actuator rejection or incomplete events are never reported as combat success', async () => {
  for (const response of [{ success: false, error: 'access denied' }, { success: true, pid: 42, eventsSent: 1, foreground: true },
    { success: true, pid: 43, eventsSent: 2, foreground: true }]) {
    const input = createCombatInput({ execFile: (_exe, _args, _opts, callback) => callback(null, JSON.stringify(response)) });
    await assert.rejects(input(42, { kind: 'key', key: 'F1' }));
  }
});

test('native keyboard AutoCombo maps the client binding instead of hidden manual steps', async () => {
  const value = fixture(); value.config.target.combo.useNativeSequence = true;
  await value.start('target'); await value.runtime.tick(); value.advance();
  await value.runtime.tick();
  assert.equal(value.events.at(-1).request.key, 'C');
  assert.equal(value.events.some(event => event.request?.key === 'F1'), false);
});

test('dynamic type protects own Pokemon while allowing a wild namesake', async () => {
  const value = fixture();
  value.config.target.monsters = [{ name: '*', priority: 1, range: 7 }];
  value.telemetry.creatures[0].name = 'Charmander';
  value.telemetry.creatures[1].name = 'Charmander';
  value.telemetry.creatures.push(
    { ...value.telemetry.creatures[0], id: 9, name: 'Owned', is_owned: true, healthPercent: 1 });
  await value.start('target'); await value.runtime.tick();
  assert.equal(value.runtime.state.selectedTargetId, 7);
  assert.deepEqual(value.runtime.sessions[0].telemetry.creatures.map(creature => creature.id), [7]);
});

test('missing or stale ownership profile prevents combat before any command', async () => {
  for (const change of [value => { delete value.telemetry.creatureIdentityProfile; },
    value => value.advance(501, false)]) {
    const value = fixture(); change(value);
    await assert.rejects(value.start('target'));
    assert.equal(value.events.some(event => event.request), false);
  }
});

test('missing or ambiguous own Pokemon permits verified hostile Target and Walker', async () => {
  for (const ambiguous of [false, true]) {
    const value = fixture();
    const own = structuredClone(value.telemetry.creatures[1]);
    if (ambiguous) value.telemetry.creatures.push({ ...own, id: 1004 });
    else value.telemetry.creatures.pop();
    assert.equal(value.runtime.sessions[0].capabilities.targetKeyboard, true);
    assert.equal(value.runtime.sessions[0].telemetry.ownPokemon, null);
    await value.start('target'); await value.start('walker');
    await value.runtime.tick();
    assert.equal(value.runtime.paused, false);
    const requests = value.events.filter(event => event.request);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].request.targetGuard.allowMissingOwn, true);
    assert.equal(requests[0].request.targetGuard.target.creatureType, 1);
    assert.ok(value.events.some(event => event.input?.[1] === 1));
    value.telemetry.creatures = [value.telemetry.creatures[0], own];
    value.advance(); await value.runtime.tick();
    assert.equal(value.events.filter(event => event.request).length, 2);
    assert.equal(value.runtime.paused, false);
  }
});

test('ambiguous own Pokemon still excludes every known pet tile from hostile targets', async () => {
  const value = fixture();
  const own = structuredClone(value.telemetry.creatures[1]);
  value.telemetry.creatures.push({ ...own, id: 1004, pos: { ...value.telemetry.creatures[0].pos } });
  await value.start('target'); await value.runtime.tick();
  assert.equal(value.runtime.paused, false);
  assert.equal(value.events.filter(event => event.request).length, 0);
});

test('ownership change cancels queued skills and never attacks the new own entity', async () => {
  const value = fixture(); await value.start('target'); await value.runtime.tick();
  const sent = value.events.filter(event => event.request).length;
  value.advance(); value.telemetry.creatures[0].creatureType = 3;
  await value.runtime.tick();
  assert.equal(value.events.filter(event => event.request).length, sent);
  assert.deepEqual(value.runtime.queue, []);
  assert.equal(value.runtime.paused, false);
});

test('every attack and skill carries fresh player, own and target identity', async () => {
  const value = fixture(); await value.start('target'); await value.runtime.tick();
  value.advance(); await value.runtime.tick();
  for (const event of value.events.filter(event => event.request)) {
    assert.equal(event.request.targetGuard.target.id, 7);
    assert.equal(event.request.targetGuard.own.id, 1003);
    assert.equal(event.request.targetGuard.player.id, 0x10000001);
    assert.equal(event.request.targetGuard.pid, 42);
  }
});

test('moving target rejection waits for a new snapshot and reprojects without pausing Walker', async () => {
  const value = fixture(); await value.start('walker'); await value.start('target');
  const engine = value.runtime.engine;
  const acceptedInput = value.runtime.combatInput;
  value.runtime.combatInput = async () => { throw Object.assign(Error('moved'), { code: 'COMBAT_TARGET_MOVED' }); };
  assert.equal((await value.runtime.tick()).status, 'retrying');
  assert.equal(value.runtime.paused, false);
  assert.equal(value.runtime.engine, engine);
  assert.deepEqual(value.runtime.modules, ['walker', 'target']);
  value.runtime.combatInput = acceptedInput;
  assert.equal(await value.runtime.tick(), null);
  value.telemetry.creatures[0].pos = { x: 102, y: 100, z: 7 };
  value.advance();
  assert.equal((await value.runtime.tick()).action, 'attack');
  assert.equal(value.events.at(-1).request.x, 464);
  assert.equal(value.events.at(-1).request.targetGuard.target.id, 7);
  assert.equal(value.events.some(event => event.request?.key), false);
});

test('movement rejection during a skill preserves the pending hotkey without inserting a click', async () => {
  const value = fixture(); await value.start('target'); await value.runtime.tick(); value.advance();
  const acceptedInput = value.runtime.combatInput;
  value.runtime.combatInput = async () => { throw Object.assign(Error('moved'), { code: 'COMBAT_TARGET_MOVED' }); };
  assert.equal((await value.runtime.tick()).status, 'retrying');
  value.runtime.combatInput = acceptedInput;
  value.telemetry.creatures[0].pos = { x: 102, y: 100, z: 7 }; value.advance();
  assert.equal((await value.runtime.tick()).action, 'talk');
  assert.equal(value.events.at(-1).request.key, 'F1');
  assert.equal(value.events.filter(event => event.request?.kind === 'attack').length, 1);
});

test('target loss after a movement rejection cancels pending skills without stale clicks', async () => {
  for (const change of [creature => { creature.healthPercent = 0; },
    creature => { creature.pos.z = 8; }, creature => { creature.id = 8; creature.healthPercent = 0; }]) {
    const value = fixture(); await value.start('target');
    const acceptedInput = value.runtime.combatInput;
    value.runtime.combatInput = async () => { throw Object.assign(Error('moved'), { code: 'COMBAT_TARGET_MOVED' }); };
    await value.runtime.tick(); value.runtime.combatInput = acceptedInput;
    change(value.telemetry.creatures[0]); value.advance(); await value.runtime.tick();
    assert.equal(value.events.some(event => event.request), false);
    assert.deepEqual(value.runtime.queue, []);
  }
});

test('only PID-bound zero-event movement errors receive the recoverable transport code', async () => {
  for (const response of [
    { success: false, pid: 42, eventsSent: 0, errorCode: 'COMBAT_TARGET_MOVED', error: 'moved' },
    { success: false, pid: 43, eventsSent: 0, errorCode: 'COMBAT_TARGET_MOVED', error: 'moved' },
    { success: false, pid: 42, eventsSent: 1, errorCode: 'COMBAT_TARGET_MOVED', error: 'moved' },
  ]) {
    const input = createCombatInput({ execFile: (_exe, _args, _opts, callback) => callback(Error('exit 1'), JSON.stringify(response)) });
    await assert.rejects(input(42, { kind: 'attack' }), error => {
      assert.equal(error.code, response.pid === 42 && response.eventsSent === 0 ? 'COMBAT_TARGET_MOVED' : undefined);
      return true;
    });
  }
});

test('combat focus loss pauses both modules without discarding the Walker route', async () => {
  const value = fixture(); await value.start('walker'); await value.start('target');
  const engine = value.runtime.engine;
  value.runtime.combatInput = async () => { throw Object.assign(Error('focus lost'), { code: 'WALKER_FOCUS_LOST' }); };
  assert.equal((await value.runtime.tick()).status, 'paused');
  assert.equal(value.runtime.engine, engine);
  assert.deepEqual(value.runtime.modules, ['walker', 'target']);
  assert.equal(value.runtime.paused, true);
  assert.deepEqual(value.runtime.queue, []);
});

test('Walker steps continuously in idle combat without waiting for new creature timestamps', async () => {
  const value = fixture();
  // Only own Pokemon in sight (no hostiles)
  value.telemetry.creatures = [value.telemetry.creatures[1]];
  await value.start('walker');
  await value.start('target');
  assert.deepEqual(value.runtime.modules, ['walker', 'target']);

  // First step of Walker
  const tick1 = await value.runtime.tick();
  assert.equal(tick1?.status, 'walking');
  assert.equal(value.events.at(-1).input[1], 1); // Right arrow

  // Player position updates, 300ms pass, but creature scanner has NOT updated its timestamp (fresh = false)
  value.advance(300, false);
  value.telemetry.position = { x: 101, y: 100, z: 7 };
  value.telemetry.creaturePlayer.pos = { x: 101, y: 100, z: 7 };

  // Second step must advance without stalling on the unchanged creaturesGeneratedAt
  const tick2 = await value.runtime.tick();
  assert.equal(tick2?.status, 'walking');
  assert.equal(value.events.at(-1).input[1], 1);
});

test('Walker has an independent clock while combat is in flight', async () => {
  const value = fixture(); await value.start('walker'); await value.start('target');
  let complete;
  value.runtime.combatInput = () => new Promise(resolve => { complete = resolve; });
  const pending = value.runtime.tick();
  await new Promise(resolve => setImmediate(resolve));
  try {
    assert.equal(value.events.filter(event => event.input?.[1] === 1).length, 1);
    value.advance(); value.telemetry.position.x++; value.telemetry.creaturePlayer.pos.x++;
    await value.runtime.tick();
    assert.equal(value.events.filter(event => event.input?.[1] === 1).length, 2);
  } finally { complete({ success: true }); await pending; }
  assert.equal(value.runtime.paused, false);
});

test('fresh but unchanged creature snapshot does not consume or skip rotation steps', async () => {
  const value = fixture(); value.runtime.maxAgeMs = 1000;
  await value.start('target'); await value.runtime.tick();
  value.advance(250, false); await value.runtime.tick();
  value.advance(250, false); await value.runtime.tick();
  assert.deepEqual(value.events.filter(event => event.request?.key).map(event => event.request.key), ['F1', 'F2']);
  assert.equal(value.runtime.combat.state.comboIndex, 2);
});

test('continuous hotkey rotation sends each skill every 300ms without redundant attack clicks', async () => {
  const value = fixture(); value.config.target.skills = [{ key: 'F1' }, { key: 'F2' }, { key: 'F3' }];
  await value.start('target'); await value.runtime.tick();
  for (let tick = 0; tick < 6; tick++) { value.advance(); await value.runtime.tick(); }
  assert.deepEqual(value.events.filter(event => event.request?.key).map(event => event.request.key),
    ['f1', 'f2', 'f3', 'f1', 'f2', 'f3']);
  assert.equal(value.events.filter(event => event.request?.kind === 'attack').length, 1);
});

test('manual combo respects configured GCD measured from actual dispatch', async () => {
  const value = fixture(); value.config.target.globalCooldownMs = 350;
  await value.start('target'); await value.runtime.tick();
  value.advance(349); assert.equal(await value.runtime.tick(), null);
  value.advance(1); assert.equal((await value.runtime.tick()).action, 'talk');
  value.advance(349); assert.equal(await value.runtime.tick(), null);
  value.advance(1); await value.runtime.tick();
  assert.equal(value.events.at(-1).request.key, 'F2');
});

test('urgent healing preempts a queued skill and resumes that exact rotation step', async () => {
  const value = fixture();
  value.config.target.healSkill = { enabled: true, hpPercent: 50, move: 'm3' };
  value.transport.bindings.m3 = 'F3'; value.telemetry.healthPercent = 100;
  await value.start('target'); await value.runtime.tick();
  value.telemetry.healthPercent = 30; value.advance(250);
  assert.equal((await value.runtime.tick()).status, 'heal');
  assert.equal(value.events.at(-1).request.key, 'F3');
  assert.equal(value.runtime.queue[0].parameter, 'm1');
  value.telemetry.healthPercent = 90; value.advance(250); await value.runtime.tick();
  assert.equal(value.events.at(-1).request.key, 'F1');
  value.advance(250); await value.runtime.tick();
  assert.equal(value.events.at(-1).request.key, 'F2');
});

test('heal priority works with skills arrays and without a hostile target', async () => {
  const value = fixture();
  value.config.target.skills = [{ key: 'F1' }];
  value.config.target.healSkill = { enabled: true, hpPercent: 50, move: 'm3' };
  value.transport.bindings.m3 = 'F3'; value.telemetry.healthPercent = 30;
  value.telemetry.creatures = [value.telemetry.creatures[1]];
  await value.start('target');
  assert.equal((await value.runtime.tick()).status, 'heal');
  assert.equal(value.events.at(-1).request.key, 'F3');
  assert.equal(value.runtime.combat.state.comboIndex, 0);
});

test('Healer module has priority over an existing combat queue and preserves Walker', async () => {
  const value = fixture(); value.telemetry.healthPercent = 100;
  await value.start('walker'); await value.start('target'); await value.runtime.tick();
  const queue = structuredClone(value.runtime.queue);
  const walker = value.runtime.engine;
  value.config.hoenn = { potionHpPercent: 50, potionHotkey: 'F12', potionCooldownMs: 1500 };
  await value.start('healer');
  value.telemetry.creatures.find(entry => entry.isOwnPokemon).healthPercent = 20; value.advance();
  assert.equal((await value.runtime.tick()).status, 'heal');
  assert.equal(value.events.filter(event => event.request).at(-1).request.key, 'F12');
  assert.deepEqual(value.runtime.queue, queue);
  value.telemetry.creatures.find(entry => entry.isOwnPokemon).healthPercent = 80; value.advance(); await value.runtime.tick();
  assert.equal(value.events.at(-1).request.key, 'F1');
  assert.equal(value.runtime.engine, walker);
  await value.runtime.setModules('healer', false);
  assert.deepEqual(value.runtime.modules, ['walker', 'target']);
  assert.equal(value.runtime.paused, false);
});

test('Pokemon potion works without trainer HP and stays active when Walker stops', async () => {
  const value = fixture(); value.config.hoenn = { potionHpPercent: 50, potionHotkey: 'F12' };
  value.telemetry.creatures.find(entry => entry.isOwnPokemon).healthPercent = 20;
  await value.start('healer');
  assert.equal((await value.runtime.tick()).status, 'heal');
  await value.runtime.togglePause(); await value.runtime.togglePause();
  await value.start('walker'); await value.runtime.setModules('walker', false);
  assert.deepEqual(value.runtime.modules, ['healer']);
  value.advance(1500); assert.equal((await value.runtime.tick()).status, 'heal');
  await value.runtime.setModules('all', false);
  assert.equal(value.runtime.healer, null);
  assert.equal(await value.runtime.tick(), null);
});

test('Healer cannot turn missing HP into a potion or cast a different Pokemon move', async () => {
  const value = fixture(); value.telemetry.healthPercent = 20;
  value.config.hoenn = { potionHpPercent: 50, potionHotkey: 'F12' };
  value.config.healer = { healHpPercent: 50, healMoveSlot: 1, healPokemonName: 'Other' };
  value.telemetry.roster = [{ name: 'Other', slot: 1, uuid: 'other' }];
  value.telemetry.pokemonName = 'Eevee'; value.telemetry.activeSlot = 2;
  await value.start('healer');
  delete value.telemetry.healthPercent;
  await value.runtime.tick();
  assert.equal(value.events.some(event => event.request), false);
  value.config.hoenn = {}; value.runtime.updateConfig(value.config);
  value.telemetry.healthPercent = 20; value.advance(); await value.runtime.tick();
  assert.equal(value.events.some(event => event.request), false);
  assert.ok(value.runtime.state.healer.blocked.includes('keyboard-heal-requires-active-pokemon'));
});

test('pause drains both lanes and never dispatches the queued skill after cancellation', async () => {
  const value = fixture(); await value.start('walker'); await value.start('target');
  let releaseWalk; let releaseCombat;
  value.runtime.input = () => new Promise(resolve => { releaseWalk = resolve; });
  value.runtime.combatInput = () => new Promise(resolve => { releaseCombat = resolve; });
  const tick = value.runtime.tick(); await new Promise(resolve => setImmediate(resolve));
  let paused = false;
  const stopping = value.runtime.pause().then(() => { paused = true; });
  releaseCombat({ success: true }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(paused, false);
  assert.equal(await value.runtime.tick(), null);
  releaseWalk(); await tick; await stopping;
  assert.equal(value.runtime.paused, true);
});

test('finishing Walker route preserves ongoing combat and its timer state', async () => {
  const value = fixture(); value.config.walker.waypoints[0].pos.x = 100;
  await value.start('walker'); await value.start('target'); await value.runtime.tick();
  value.advance(); await value.runtime.tick();
  assert.deepEqual(value.runtime.modules, ['target']);
  assert.equal(value.runtime.paused, false);
  assert.equal(value.events.at(-1).request.key, 'F1');
});

test('Healer does not starve after-combat capture when no healing action is needed', async () => {
  const value = captureFixture(); value.telemetry.healthPercent = 100;
  value.config.hoenn = { potionHpPercent: 50, potionHotkey: 'F12' };
  value.telemetry.creatures = [value.telemetry.creatures[1]];
  await value.start('walker'); await value.start('target'); await value.start('healer');
  assert.equal((await value.runtime.tick()).status, 'capture');
  assert.equal(value.events.filter(event => event.request).at(-1).request.kind, 'useWith');
});

test('reprojection has a 300ms retry floor even when scans update faster', async () => {
  const value = fixture(); await value.start('target');
  let attempts = 0;
  value.runtime.combatInput = async () => { attempts++; throw Object.assign(Error('moved'), { code: 'COMBAT_TARGET_MOVED' }); };
  await value.runtime.tick();
  value.advance(100); await value.runtime.tick();
  value.advance(199); await value.runtime.tick();
  assert.equal(attempts, 1);
  value.advance(1); await value.runtime.tick();
  assert.equal(attempts, 2);
});

test('reconfiguration during a dispatch cannot mark a new target engine as already attacked', async () => {
  const value = fixture(); await value.start('target');
  const accepted = value.runtime.combatInput;
  let release;
  value.runtime.combatInput = () => new Promise(resolve => { release = resolve; });
  const tick = value.runtime.tick(); await new Promise(resolve => setImmediate(resolve));
  value.config.target.combo.sequenceText = 'm2'; value.runtime.updateConfig(value.config);
  release({ success: true }); await tick;
  value.runtime.combatInput = accepted; value.advance(); await value.runtime.tick();
  assert.equal(value.events.at(-1).request.kind, 'attack');
  value.advance(); await value.runtime.tick();
  assert.equal(value.events.at(-1).request.key, 'F2');
});

test('Healer retry cooldown starts at accepted dispatch, not at planning time', async () => {
  const value = fixture(); value.telemetry.healthPercent = 20;
  value.telemetry.creatures.find(entry => entry.isOwnPokemon).healthPercent = 20;
  value.config.hoenn = { potionHpPercent: 50, potionHotkey: 'F12', potionCooldownMs: 1500 };
  await value.start('healer');
  const accepted = value.runtime.combatInput;
  let release;
  value.runtime.combatInput = () => new Promise(resolve => { release = resolve; });
  const tick = value.runtime.tick();
  value.advance(2000); release({ success: true }); await tick;
  value.runtime.combatInput = accepted;
  value.advance(1499); assert.equal(await value.runtime.tick(), null);
  value.advance(1); assert.equal((await value.runtime.tick()).status, 'heal');
});

test('RPM triggers AutoRevive after combo and resumes Walker when remaining creatures <= finishRemainingCount', async () => {
  const value = fixture();
  value.config.target.combo.finishRemainingCount = 1;
  value.config.target.autoRevive = { enabled: true, hotkey: 'F9', interval: 500, waitForPokemon: false };
  await value.start('walker'); await value.start('target');

  // Step 1: attack
  assert.equal((await value.runtime.tick()).action, 'attack');
  // Advance & Step 2: m1
  value.advance(); assert.equal((await value.runtime.tick()).action, 'talk');
  // Advance & Step 3: m2 (combo finishes)
  value.advance(); assert.equal((await value.runtime.tick()).action, 'talk');

  // Next tick: combo-done triggers revive waiting-interval
  value.advance();
  const reviveWait = await value.runtime.tick();
  assert.equal(reviveWait.status, 'revive');
  assert.equal(reviveWait.action, 'waiting-interval');

  // Advance past interval (500ms): revive hotkey dispatched!
  value.advance(500);
  const reviveSent = await value.runtime.tick();
  assert.equal(reviveSent.status, 'revive');
  assert.equal(reviveSent.action, 'hotkey');
  assert.equal(value.events.filter(e => e.request).at(-1).request.key, 'F9');

  // Now revive finished, 1 creature remaining <= finishRemainingCount (1)
  // Walker resumes walking immediately in the same tick!
  value.advance();
  const resumed = await value.runtime.tick();
  assert.equal(resumed.status, 'walking');
  assert.equal(resumed.action, 'move');
});

test('RPM restarts combo when remaining creatures > finishRemainingCount', async () => {
  const value = fixture();
  value.config.target.combo.finishRemainingCount = 0;
  await value.start('target');

  // Attack, m1, m2
  await value.runtime.tick();
  value.advance(); await value.runtime.tick();
  value.advance(); await value.runtime.tick();

  // Combo finished, but 1 rat is still alive (> 0 remaining)
  value.advance();
  const restart = await value.runtime.tick();
  assert.equal(restart.status, 'combat');
  assert.equal(restart.action, 'restart-combo');

  // Next tick begins next combo cycle
  value.advance();
  const nextCombo = await value.runtime.tick();
  assert.equal(nextCombo.action, 'talk');
  assert.equal(value.events.at(-1).request.key, 'F1');
});

test('RPM triggers AutoRevive even when 0 creatures remain after combo and then resumes Walker', async () => {
  const value = fixture();
  value.config.target.combo.finishRemainingCount = 0;
  value.config.target.autoRevive = { enabled: true, hotkey: 'F9', interval: 500, waitForPokemon: false };
  await value.start('walker'); await value.start('target');

  // Step 1: attack
  assert.equal((await value.runtime.tick()).action, 'attack');
  // Step 2: m1
  value.advance(); assert.equal((await value.runtime.tick()).action, 'talk');
  // Step 3: m2 kills the rat, now creatures is empty
  value.advance();
  assert.equal((await value.runtime.tick()).action, 'talk');
  value.telemetry.creatures = value.telemetry.creatures.filter(c => c.creatureType === 3);

  // Next tick: even with 0 creatures left, combo-done triggers revive waiting-interval!
  value.advance();
  const reviveWait = await value.runtime.tick();
  assert.equal(reviveWait.status, 'revive');
  assert.equal(reviveWait.action, 'waiting-interval');

  // Advance past interval (500ms): revive hotkey dispatched!
  value.advance(500);
  const reviveSent = await value.runtime.tick();
  assert.equal(reviveSent.status, 'revive');
  assert.equal(reviveSent.action, 'hotkey');
  assert.equal(value.events.filter(e => e.request).at(-1).request.key, 'F9');

  // Now revive finished, 0 creatures remaining <= finishRemainingCount (0)
  // Walker resumes walking!
  value.advance();
  const resumed = await value.runtime.tick();
  assert.equal(resumed.status, 'walking');
  assert.equal(resumed.action, 'move');
});

test('RPM continues combat against remaining creatures when remaining < minCount', async () => {
  const value = fixture();
  value.config.target.monsters[0].minCount = 5;
  value.config.target.combo.finishRemainingCount = 0;
  value.config.target.autoRevive = { enabled: true, hotkey: 'F9', interval: 500, waitForPokemon: false };
  
  // Set up 5 rats to satisfy initial minCount
  const ownPokemon = value.telemetry.creatures.find(c => c.creatureType === 3);
  value.telemetry.creatures = [
    ownPokemon,
    { id: 10, name: 'Rat', pos: { x: 101, y: 100, z: 7 }, canAttack: true, healthPercent: 100, creatureType: 1, ownershipVerified: true, struct_va: '0x300' },
    { id: 11, name: 'Rat', pos: { x: 101, y: 101, z: 7 }, canAttack: true, healthPercent: 100, creatureType: 1, ownershipVerified: true, struct_va: '0x301' },
    { id: 12, name: 'Rat', pos: { x: 99, y: 101, z: 7 }, canAttack: true, healthPercent: 100, creatureType: 1, ownershipVerified: true, struct_va: '0x302' },
    { id: 13, name: 'Rat', pos: { x: 99, y: 100, z: 7 }, canAttack: true, healthPercent: 100, creatureType: 1, ownershipVerified: true, struct_va: '0x303' },
    { id: 14, name: 'Rat', pos: { x: 100, y: 99, z: 7 }, canAttack: true, healthPercent: 100, creatureType: 1, ownershipVerified: true, struct_va: '0x304' }
  ];

  await value.start('walker'); await value.start('target');

  // Step 1: attack
  assert.equal((await value.runtime.tick()).action, 'attack');
  // Step 2: m1
  value.advance(); assert.equal((await value.runtime.tick()).action, 'talk');
  // Step 3: m2 finishes combo; 4 rats die, only 1 rat remains (1 < 5 minCount)
  value.advance();
  assert.equal((await value.runtime.tick()).action, 'talk');
  value.telemetry.creatures = [
    ownPokemon,
    { id: 10, name: 'Rat', pos: { x: 101, y: 100, z: 7 }, canAttack: true, healthPercent: 50, creatureType: 1, ownershipVerified: true, struct_va: '0x300' }
  ];

  // Revive waiting-interval
  value.advance();
  const reviveWait = await value.runtime.tick();
  assert.equal(reviveWait.status, 'revive');

  // Revive hotkey
  value.advance(500);
  const reviveSent = await value.runtime.tick();
  assert.equal(reviveSent.status, 'revive');
  assert.equal(reviveSent.action, 'hotkey');

  // Revive finishes; remaining (1) > finishRemainingCount (0), so restarts combo
  value.advance();
  const restart = await value.runtime.tick();
  assert.equal(restart.status, 'combat');
  assert.equal(restart.action, 'restart-combo');

  // Even though 1 rat < minCount (5), combat stays ACTIVE and does NOT revert to luring!
  value.advance();
  const nextCombo = await value.runtime.tick();
  assert.equal(nextCombo.action, 'talk');
  assert.equal(value.events.at(-1).request.key, 'F1');
});

test('AutoRevive with waitForPokemon holds the revive state until the own Pokemon is back', async () => {
  const value = fixture();
  value.config.target.combo.finishRemainingCount = 1;
  value.config.target.autoRevive = { enabled: true, hotkey: 'F9', interval: 500, waitForPokemon: true };
  await value.start('walker'); await value.start('target');

  await value.runtime.tick();
  value.advance(); await value.runtime.tick();
  value.advance(); await value.runtime.tick();
  value.advance();
  assert.equal((await value.runtime.tick()).action, 'waiting-interval');
  value.advance(500);
  assert.equal((await value.runtime.tick()).action, 'hotkey');
  const sent = value.events.filter(event => event.request).length;

  /* Own Pokemon com HP 0: o revive ja' saiu, mas o runtime continua em espera
   * e nao volta a atacar nem a andar. */
  value.telemetry.creatures = value.telemetry.creatures.map(creature =>
    creature.creatureType === 3 ? { ...creature, healthPercent: 0 } : creature);
  value.advance();
  const waiting = await value.runtime.tick();
  assert.equal(waiting.status, 'revive');
  assert.equal(waiting.action, 'waiting-pokemon');
  assert.equal(value.events.filter(event => event.request).length, sent);
  value.advance();
  assert.equal((await value.runtime.tick()).action, 'waiting-pokemon');

  /* Pokemon volta com HP: o revive conclui e o Walker retoma no mesmo tick. */
  value.telemetry.creatures = value.telemetry.creatures.map(creature =>
    creature.creatureType === 3 ? { ...creature, healthPercent: 100 } : creature);
  value.advance();
  const resumed = await value.runtime.tick();
  assert.equal(resumed.status, 'walking');
  assert.equal(resumed.action, 'move');
});

test('AutoRevive waitForPokemon honours hoenn.pokeReadyTimeoutMs instead of a fixed 3.5 s', async () => {
  const value = fixture();
  value.config.target.combo.finishRemainingCount = 1;
  value.config.hoenn = { pokeReadyTimeoutMs: 5000 };
  value.config.target.autoRevive = { enabled: true, hotkey: 'F9', interval: 500, waitForPokemon: true };
  await value.start('walker'); await value.start('target');

  await value.runtime.tick();
  value.advance(); await value.runtime.tick();
  value.advance(); await value.runtime.tick();
  value.advance();
  assert.equal((await value.runtime.tick()).action, 'waiting-interval');
  value.advance(500);
  assert.equal((await value.runtime.tick()).action, 'hotkey');

  /* Own Pokemon com HP 0: so' o timeout pode concluir o revive daqui em diante. */
  value.telemetry.creatures = value.telemetry.creatures.map(creature =>
    creature.creatureType === 3 ? { ...creature, healthPercent: 0 } : creature);

  /* 3.500 ms: o literal fixo antigo ja' teria concluido o revive. */
  value.advance(3500);
  assert.equal((await value.runtime.tick()).action, 'waiting-pokemon');
  /* 4.000 ms: continua esperando, porque o timeout configurado e' maior. */
  value.advance(500);
  assert.equal((await value.runtime.tick()).action, 'waiting-pokemon');
  /* Passa o timeout configurado: o revive conclui e o Walker retoma no mesmo
   * tick. */
  value.advance(1001);
  const finished = await value.runtime.tick();
  assert.equal(finished.status, 'walking');
  assert.equal(finished.action, 'move');
});

test('unsupported or mismatched identity profile keeps Target blocked with its own code', async () => {
  for (const [change, pattern] of [
    [value => { value.telemetry.creatureIdentityProfile.executableSha256 = 'f'.repeat(64); },
      /perfil de compatibilidade confirmado/u],
    [value => { value.telemetry.creatureIdentityProfile.typeOffset = '0x999'; },
      /não corresponde à versão do cliente/u],
  ]) {
    const value = fixture();
    change(value);
    await assert.rejects(value.start('target'), pattern);
    assert.equal(value.runtime.sessions[0].capabilities.targetKeyboard, false);
    assert.equal(value.events.some(event => event.request), false);
    /* O codigo acompanha o motivo: nao e' um bloqueio generico que o operador
     * nao consegue diagnosticar. */
    assert.match(value.runtime.sessions[0].capabilities.targetKeyboardIssueCode,
      /^COMBAT_PROFILE_(UNSUPPORTED|MISMATCH)$/u);
  }
});

test('identity profile invalidated mid-run pauses Target and blocks every later tick', async () => {
  const value = fixture(); await value.start('walker'); await value.start('target');
  assert.equal((await value.runtime.tick()).action, 'attack');
  const sent = value.events.filter(event => event.request).length;
  const waypoint = value.runtime.engine.state.index;

  /* A leitura de criaturas passa a informar um build sem perfil confirmado. */
  value.telemetry.creatureIdentityProfile.executableSha256 = 'f'.repeat(64);
  value.advance();
  const blocked = await value.runtime.tick();
  assert.equal(blocked.status, 'error');
  assert.match(blocked.error, /perfil de compatibilidade confirmado/u);
  assert.equal(value.runtime.paused, true);
  /* Nada foi enviado com o perfil nao validado. */
  assert.equal(value.events.filter(event => event.request).length, sent);

  /* A retomada nao revalida o perfil: ela passa, mas o tick seguinte bloqueia
   * de novo — e o Walker, que nao tem percepcao valida, nao anda. */
  value.advance();
  await value.runtime.togglePause();
  value.advance();
  assert.equal((await value.runtime.tick()).status, 'error');
  assert.equal(value.runtime.paused, true);
  assert.equal(value.runtime.engine.state.index, waypoint);
  assert.equal(value.events.filter(event => event.request).length, sent);

  /* Perfil de volta: o Target volta a atacar. */
  value.telemetry.creatureIdentityProfile.executableSha256 =
    '473df25c1edd23e7464ad3ba9b923a603051a8b4ae8004a95c06402f678294e6';
  value.advance();
  await value.runtime.togglePause();
  value.advance();
  await value.runtime.tick();
  assert.equal(value.runtime.paused, false);
  assert.equal(value.events.filter(event => event.request).length, sent + 1);
});
