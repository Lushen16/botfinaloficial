'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBlindReplay } = require('../reconstruction/automation.cjs');
const pos = (x,y) => ({ x,y,z:7 });
const frame = (position,seq) => ({ seq,pid:5,sampledAtMs:seq,player:{ pos:position,id:42,hp:100,name:'Demo' } });
test('sink receives cardinal directions in route order', () => {
  const route = [pos(10,9),pos(11,9),pos(11,10),pos(10,10)];
  const replay = createBlindReplay({ pid:5,route,frames:[pos(10,10),...route].map(frame) });
  while (replay.provider.next()) replay.tick();
  assert.deepEqual(replay.calls.map(call => call.direction),[0,1,2,3]);
  assert.equal(replay.state.index,4);
});
test('rejection does not advance route or confirm on retry', () => {
  const replay = createBlindReplay({ pid:5,route:[pos(10,9)],outcomes:[false,true],frames:[pos(10,10),pos(10,10)].map(frame) });
  while (replay.provider.next()) replay.tick();
  assert.equal(replay.state.index,0);
  assert.deepEqual(replay.calls.map(call => [call.direction,call.accepted]),[[0,false],[0,true]]);
  assert.deepEqual(replay.events.map(event => event.phase),['aborted','dispatched']);
});
