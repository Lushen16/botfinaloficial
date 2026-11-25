'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const schema = require('../readable/shared/schema.js');
const { migrateTelemetry, validateTelemetry, validateConfig, TELEMETRY_DEFAULTS } = require('../reconstruction/settings.cjs');

for (const location of ['root', 'tools']) {
  test('migration recovers an obsolete ' + location + ' mode without mutating the profile', () => {
    const config = schema.createConfig();
    const telemetry = { mode:'python',intervalMs:7000,playerName:'Demo',maxSessionMin:10 };
    if (location === 'root') config.telemetry = telemetry;
    else config.tools.telemetry = telemetry;
    const original = structuredClone(config);
    const migrated = migrateTelemetry(config);
    assert.equal(migrated.telemetry.mode,TELEMETRY_DEFAULTS.mode);
    assert.equal(migrated.telemetry.intervalMs,7000);
    assert.equal(migrated.telemetry.playerName,'Demo');
    assert.equal(migrated.telemetry.maxSessionMin,10);
    assert.deepEqual(migrated.tools.telemetry,migrated.telemetry);
    assert.deepEqual(config,original);
  });
}

test('explicit assignment remains strict; migration does not hide other invalid fields', () => {
  assert.throws(() => validateTelemetry({mode:'python'}),/telemetry.mode/u);
  const config = schema.createConfig();
  config.telemetry = {mode:'python'};
  assert.throws(() => validateConfig(config),/telemetry.mode/u);
  config.telemetry.intervalMs = 1000;
  assert.throws(() => migrateTelemetry(config),/telemetry.intervalMs/u);
  config.telemetry = {mode:'python',executableSha256:'not-a-sha'};
  assert.throws(() => migrateTelemetry(config),/telemetry.executableSha256/u);
});

test('migration preserves supported modes and tools precedence over the root alias', () => {
  for (const mode of ['native','replay','chain']) {
    const config = schema.createConfig();
    config.telemetry = {mode:'python',intervalMs:1000};
    config.tools.telemetry = {mode,intervalMs:8000};
    const migrated = migrateTelemetry(config);
    assert.equal(migrated.telemetry.mode,mode);
    assert.equal(migrated.telemetry.intervalMs,8000);
  }
});
