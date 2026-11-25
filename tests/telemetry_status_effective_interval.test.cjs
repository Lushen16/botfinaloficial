'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { telemetryStatus, renderTelemetryStatus } = require('../reconstruction/app/ui/diagnostics.js');

test('configured and reported effective intervals are separate diagnostic values', () => {
  const state = telemetryStatus({pid:7,telemetry:{intervalMs:5000,effectiveIntervalMs:5000}},
    {},{intervalMs:2000});
  assert.equal(state.interval,'2 s');
  assert.equal(state.effectiveInterval,'5 s');
  const unknown = telemetryStatus({pid:7,telemetry:{}},{},{intervalMs:2000});
  assert.equal(unknown.interval,'2 s');
  assert.equal(unknown.effectiveInterval,'—');
});

test('effective interval from another runtime or an invalid value is not displayed', () => {
  const session = {pid:7,telemetry:{}};
  assert.equal(telemetryStatus(session,{pid:8,telemetry:{effectiveIntervalMs:5000}}).effectiveInterval,'—');
  assert.equal(telemetryStatus(session,{pid:7,telemetry:{effectiveIntervalMs:5000}}).effectiveInterval,'5 s');
  for (const value of [-1,0,NaN,Infinity,'5000']) {
    assert.equal(telemetryStatus({pid:7,telemetry:{effectiveIntervalMs:value}}).effectiveInterval,'—');
  }
});

test('renderer labels the effective value and clears it when the next session lacks metadata', () => {
  const node = {textContent:''};
  const document = {getElementById:id=>id === 'sample-effective-interval' ? node : null};
  renderTelemetryStatus(document,{pid:7,telemetry:{effectiveIntervalMs:5000}});
  assert.equal(node.textContent,'5 s');
  renderTelemetryStatus(document,{pid:8,telemetry:{}});
  assert.equal(node.textContent,'—');
  const html = fs.readFileSync(path.join(__dirname,'../reconstruction/app/ui/index.html'),'utf8');
  assert.match(html,/<dt>Intervalo efetivo informado<\/dt><dd id="sample-effective-interval">/u);
});
