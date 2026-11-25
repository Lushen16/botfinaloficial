'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createChainProvider } = require('../reconstruction/telemetry/chain-provider.cjs');
const { createInputSink } = require('../reconstruction/telemetry/input-sink.cjs');
const { createBlindReplay } = require('../reconstruction/automation.cjs');

const frame = seq => ({ seq, pid: 1, sampledAtMs: 1000 * seq, player: null });

test('provider decodes three frames and stops delivering callbacks after stop', () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  let kills = 0;
  child.kill = () => { kills++; };
  const provider = createChainProvider({ mode: 'live', pid: 1, spawnImpl: () => child });
  const received = [];
  provider.start(value => received.push(value));
  const records = [1, 2, 3].map(frame);
  const text = records.map(JSON.stringify).join('\n') + '\n';
  child.stdout.write(text.slice(0, 5));
  child.stdout.write(text.slice(5));
  assert.deepEqual(provider.latest(), records[2]);
  provider.stop();
  child.stdout.end(JSON.stringify(frame(4)) + '\n');
  assert.equal(kills, 1);
  assert.deepEqual(received, records);
});

test('sink distinguishes acceptance, rejection, invalid JSON and child failure', () => {
  for (const [status, stdout, accepted] of [[0, '{"success":true}', true], [0, '{"success":false}', false],
    [0, 'not JSON', false], [1, '{"success":true}', false]]) {
    const sink = createInputSink({ mode: 'live', pid: 1, spawnSyncImpl: () => ({ status, stdout }) });
    const result = sink.step(0);
    assert.equal(result.accepted, accepted);
    assert.ok(Number.isFinite(result.queuedAtMs));
  }
});

test('blind replay never dispatches or advances with only null players', () => {
  const replay = createBlindReplay({ frames: [1, 2, 3].map(frame), pid: 1, route: [{ x: 8, y: 8, z: 7 }] });
  while (replay.provider.next()) for (let tick = 0; tick < 20; tick++) replay.tick();
  assert.deepEqual(replay.calls, []);
  assert.equal(replay.state.index, 0);
});
