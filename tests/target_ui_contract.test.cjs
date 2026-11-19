'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const schema = require('../readable/shared/schema.js');
const messages = require('../reconstruction/app/ui/messages.js');
const { validateConfig } = require('../reconstruction/settings.cjs');
const { WalkerInputRuntime } = require('../reconstruction/walker-input-runtime.cjs');

test('native AutoCombo UI displays its hotkey only in native mode', () => {
  const published = fs.readFileSync(path.join(__dirname, '../reconstruction/app/ui/target.js'), 'utf8');
  assert.match(published, /"Hotkey AutoCombo",c,"nativeHotkey"/u);
  assert.match(published, /ACombo\.hidden="native"!==e/u);
});

test('native AutoCombo persists a configured hotkey and accepts older profiles', () => {
  const config = schema.createConfig();
  config.target.combo.enabled = true;
  config.target.combo.useNativeSequence = true;
  config.target.combo.nativeHotkey = 'C';
  const saved = validateConfig(config);
  const reloaded = validateConfig(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(reloaded.target.combo, config.target.combo);
  delete config.target.combo.nativeHotkey;
  assert.equal(Object.hasOwn(validateConfig(config).target.combo, 'nativeHotkey'), false);
});

test('older profiles with combo.n migrate the hotkey to nativeHotkey', () => {
  const config = schema.createConfig();
  config.target.combo.n = 'F5';
  const loaded = validateConfig(config);
  assert.equal(loaded.target.combo.nativeHotkey, 'F5');
  assert.equal(Object.hasOwn(loaded.target.combo, 'n'), false);
});

test('keyboard-only module error remains specific in both banner and Target diagnostics', async () => {
  const runtime = new WalkerInputRuntime({ automatic: false });
  for (const module of ['target', 'healer']) {
    let reason;
    try { await runtime.setModules(module, true, 42, schema.createConfig()); }
    catch (error) { reason = error.message; }
    assert.match(reason, /falta integrar o backend de combate/u);
    assert.equal(messages.message(reason, 'error'), reason);
    assert.equal(messages.details(reason, 'error').message, reason);
    assert.deepEqual(runtime.state.modules, []);
    assert.equal(runtime.state.paused, true);
  }
});
