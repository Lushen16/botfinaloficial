'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { ChannelCaptureRuntime, channelCaptureConfig } = require('../reconstruction/channel-capture.cjs');

const config = (patch = {}) => ({
  looting: { captureEnabled: true, maxCaptureDist: 3, captureDelay: 500, ballSlot: 0, ballKey: '', ...patch },
});
const telemetry = (items, patch = {}) => ({
  position: { x: 100, y: 100, z: 7 },
  items,
  ...patch,
});
const corpse = (id, x, y, z = 7) => ({ id, corpseId: id, stack: 1, container: false, pos: { x, y, z } });

test('planeja o corpo mais proximo dentro do alcance', () => {
  const capture = new ChannelCaptureRuntime();
  const candidate = capture.plan(telemetry([corpse(11, 103, 100), corpse(12, 101, 101)]), config(), 1000);
  assert.ok(candidate);
  assert.equal(candidate.item.id, 12);
  assert.deepEqual(candidate.parameter, { x: 101, y: 101, z: 7, itemId: 1, targetId: 12, stack: 0 });
});

test('ignora outros andares e fora do alcance', () => {
  const capture = new ChannelCaptureRuntime();
  assert.equal(capture.plan(telemetry([corpse(1, 100, 101, 6)]), config(), 0), null);
  assert.equal(capture.plan(telemetry([corpse(2, 110, 100)]), config(), 0), null);
  assert.equal(capture.last.reason, 'no-eligible-corpse');
});

test('leva tecla e slot configurados para o comando', () => {
  const capture = new ChannelCaptureRuntime();
  const candidate = capture.plan(telemetry([corpse(5, 100, 101)]),
    config({ ballSlot: 9, ballKey: '4' }), 0);
  assert.equal(candidate.parameter.stack, 9);
  assert.equal(candidate.parameter.key, '4');
});

test('respeita delay entre tentativas e o limite por corpo', () => {
  const { MAX_ATTEMPTS_PER_CORPSE } = require('../reconstruction/channel-capture.cjs');
  const capture = new ChannelCaptureRuntime();
  const candidate = capture.plan(telemetry([corpse(7, 100, 101)]), config(), 1000);
  capture.record(candidate, config(), 1000, true);
  assert.equal(capture.plan(telemetry([corpse(7, 100, 101)]), config(), 1200), null);
  assert.equal(capture.last.status, 'cooldown');
  for (let i = 0; i < MAX_ATTEMPTS_PER_CORPSE - 1; i += 1) {
    const next = capture.plan(telemetry([corpse(7, 100, 101)]), config(), 2000 + i * 1000);
    assert.ok(next, 'tentativa ' + (i + 2));
    capture.record(next, config(), 2000 + i * 1000, true);
  }
  assert.equal(capture.plan(telemetry([corpse(7, 100, 101)]), config(), 99000), null);
  assert.equal(capture.last.reason, 'no-eligible-corpse');
});

test('captureAfterCombat bloqueia durante o combate', () => {
  const capture = new ChannelCaptureRuntime();
  const cfg = config({ captureAfterCombat: true });
  assert.equal(capture.plan(telemetry([corpse(3, 100, 101)]), cfg, 0, { inCombat: true }), null);
  assert.equal(capture.last.reason, 'capture-after-combat');
  assert.ok(capture.plan(telemetry([corpse(3, 100, 101)]), cfg, 0, { inCombat: false }));
});

test('desligado devolve null sem estado de erro', () => {
  const capture = new ChannelCaptureRuntime();
  assert.equal(capture.plan(telemetry([corpse(1, 100, 101)]), config({ captureEnabled: false }), 0), null);
  assert.equal(capture.last.status, 'off');
});

test('config aceita valores fora de faixa com sanidade', () => {
  const settings = channelCaptureConfig({ looting: { captureEnabled: true, maxCaptureDist: 99, ballSlot: 40, captureDelay: 1 } });
  assert.equal(settings.maxDistance, 99);
  assert.equal(settings.ballSlot, 20);
  assert.equal(settings.delayMs, 1000);
});


test('humanizacao da caminhada varia a cadencia e pausa de vez em quando', () => {
  const { createWalkerEngine } = require('../reconstruction/engines/walker-engine.cjs');
  const movements = [];
  const engine = createWalkerEngine(
    { walker: { loop: false, stepIntervalMs: 406, humanize: true,
      waypoints: [{ action: 'walk', pos: { x: 140, y: 100, z: 7 } }] } },
    { random: () => 0 });
  const recorder = { command: (name, parameter) => { movements.push([name, parameter]); return true; } };
  let time = 0;
  const reasons = [];
  for (let i = 0; i < 40; i += 1) {
    time += 100;
    const result = engine.step({ position: { x: 100, y: 100, z: 7 } }, recorder, time);
    reasons.push(result.reason);
  }
  assert.ok(reasons.includes('humanize-pause'));
});
