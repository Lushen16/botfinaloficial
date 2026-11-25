'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBlindReplay } = require('../reconstruction/automation.cjs');
const { STUCK_LIMIT } = require('../reconstruction/engines/walker-engine.cjs');
const sample = (seq, x = 10, id = 42) => ({ seq, pid: 8, sampledAtMs: 100, player: { id, name: 'Demo', hp: 100, pos: { x, y: 10, z: 7 } } });
function run(frames, ticks = 1) {
  const replay = createBlindReplay({ pid: 8, frames, route: [{ x: 18, y: 10, z: 7 }] });
  while (replay.provider.next()) for (let index = 0; index < ticks; index++) replay.tick();
  return replay;
}
test('operator pause drops buffered frames and resumes only on a fresh sequence', () => {
  const replay = createBlindReplay({ pid: 8, frames: [1,2,3,3,4].map(seq => sample(seq)), route: [{ x: 18, y: 10, z: 7 }] });
  replay.provider.next(); replay.tick();
  replay.provider.next(); replay.pause(); replay.pause();
  replay.provider.next(); replay.tick(); replay.resume(); replay.tick();
  replay.provider.next(); replay.tick();
  assert.deepEqual(replay.events.map(event => event.reason), ['accepted','operator-pause']);
  replay.provider.next(); replay.tick(); replay.tick();
  assert.deepEqual(replay.events.map(event => event.seq), [1,2,4]);
});
test('changing player while paused still invalidates the route', () => {
  const replay = createBlindReplay({ pid: 8, frames: [sample(1),sample(2,11,43),sample(3)], route: [{ x: 18, y: 10, z: 7 }] });
  replay.provider.next(); replay.tick(); replay.pause(); replay.provider.next(); replay.resume();
  replay.provider.next(); replay.tick();
  assert.equal(replay.events.at(-1).reason,'player-changed');
  assert.equal(replay.calls.length,1);
});
test('three fresh frames dispatch three steps', () => {
  const replay = run([sample(1), sample(2,11), sample(3,12)]);
  assert.deepEqual(replay.calls.map(call => call.direction), [1,1,1]);
  assert.deepEqual(replay.events.map(event => event.phase), ['dispatched','confirmed','dispatched','confirmed','dispatched']);
  assert.equal(replay.state.creaturesAvailable, false);
  assert.equal(replay.state.effectVerified, false);
});
test('twenty ticks do not replay a frame', () => assert.equal(run([sample(1),sample(2,11)],20).calls.length, 2));
test('null player neither dispatches nor confirms', () => {
  const replay = run([sample(1), { ...sample(2), player: null }, sample(2)]);
  assert.deepEqual(replay.events.map(event => event.phase), ['dispatched']);
});
test('identity change permanently aborts this route', () => {
  const replay = run([sample(1),sample(2,11,43),sample(3)]);
  assert.equal(replay.calls.length, 1);
  assert.equal(replay.events.at(-1).reason, 'player-changed');
});
test('duplicate and older sequences cannot dispatch', () => assert.equal(run([sample(3),sample(3,11),sample(2,12)]).calls.length,1));
test('stationary trace stops at the retry ceiling', () => {
  const replay = run(Array.from({ length: STUCK_LIMIT + 2 }, (_, index) => sample(index)));
  assert.equal(replay.calls.length,STUCK_LIMIT);
  assert.equal(replay.events.at(-1).reason,'stuck');
});
