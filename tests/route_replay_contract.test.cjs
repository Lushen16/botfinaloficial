'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRouteStore, loadWalkerProfile } = require('../reconstruction/route-store.cjs');
const { createBlindReplay } = require('../reconstruction/automation.cjs');

const sample = (seq, sampledAtMs, x = 10) => ({ seq, sampledAtMs, pid: 1,
  player: { id: 42, name: 'Demo', hp: 100, pos: { x, y: 10, z: 7 } } });

test('six waypoint types survive a Lua round trip and resume requires a fresh player frame', context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-profile-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const id = 'wk_Replay.lua';
  const points = [['walk',''], ['safespot',''], ['box',''], ['stairs','up'], ['wait','1500'], ['say','Oi, "teste"!']]
    .map(([action, param], index) => ({ action, param, pos: { x: 20 + index, y: 10, z: index < 4 ? 7 : 6 }, stairCheckMonsters: action === 'stairs' }));
  createRouteStore(directory).save(id, { walker: { waypoints: points } });
  const loaded = loadWalkerProfile(createRouteStore(directory), id, {}).config.walker.waypoints;
  assert.deepEqual(loaded, points);

  const replay = createBlindReplay({ pid: 1, route: loaded.map(point => point.pos), frames: [
    sample(1, 0), sample(2, 1000), sample(2, 2000), { ...sample(3, 3000), player: null }, sample(3, 4000), sample(4, 5000, 11),
  ] });
  const next = () => assert.equal(replay.provider.next(), true);
  next(); replay.tick();
  assert.equal(replay.state.phase, 'dispatched');
  replay.pause(); next(); replay.tick(); replay.resume(); replay.tick();
  for (let index = 0; index < 3; index++) { next(); replay.tick(); }
  assert.equal(replay.calls.length, 1);
  next(); assert.equal(replay.calls.length, 1); replay.tick();
  assert.deepEqual(replay.calls.map(call => call.direction), [1, 1]);
});

test('60 decision ticks in 18 seconds dispatch only for the four fresh frames', () => {
  const frames = [0, 5000, 10000, 15000].map((ms, index) => sample(index + 1, ms, 10 + index));
  const replay = createBlindReplay({ pid: 1, route: [{ x: 20, y: 10, z: 7 }], frames });
  const dispatchedAt = [];
  let ticks = 0;
  for (let clock = 0; clock <= 18000; clock += 100) {
    const before = replay.calls.length;
    if (clock % 5000 === 0) {
      assert.equal(replay.provider.next(), true);
      assert.equal(replay.provider.latest().sampledAtMs, clock);
      assert.equal(replay.calls.length, before);
    }
    if (clock > 0 && clock % 300 === 0) {
      ticks++;
      replay.tick();
      if (replay.calls.length > before) dispatchedAt.push(clock);
    }
  }
  assert.equal(ticks, 60);
  assert.equal(replay.calls.length, 4);
  assert.deepEqual(dispatchedAt, [300, 5100, 10200, 15000]);
});

test('twenty frames without a decision tick dispatch nothing', () => {
  const frames = Array.from({ length: 20 }, (_, index) => sample(index + 1, index * 5000));
  const replay = createBlindReplay({ pid: 1, route: [{ x: 20, y: 10, z: 7 }], frames });
  for (const frame of frames) {
    assert.equal(replay.provider.next(), true);
    assert.equal(replay.provider.latest().seq, frame.seq);
    assert.equal(replay.calls.length, 0);
  }
  assert.equal(replay.state.phase, 'idle');
});
