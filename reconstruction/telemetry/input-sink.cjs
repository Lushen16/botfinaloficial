'use strict';
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

function createLiveSink({ pid, python, env = process.env, spawnSyncImpl = spawnSync, timeoutMs = 4000 } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) throw TypeError('pid precisa ser inteiro positivo');

  function run(args) {
    const queuedAtMs = Date.now();
    const outcome = spawnSyncImpl(python || env.PKA_PYTHON || 'python',
      [path.join(ROOT, 'tools', 'walker_input.py'), '--pid', String(pid), ...args],
      { cwd: ROOT, windowsHide: true, encoding: 'utf8', timeout: timeoutMs, env });
    if (outcome.error) return { accepted: false, queuedAtMs, error: outcome.error.message };
    if (outcome.status !== 0) {
      return { accepted: false, queuedAtMs, error: (outcome.stderr || '').trim() || 'exit ' + outcome.status };
    }
    const text = (outcome.stdout || '').trim().split('\n').pop();
    let parsed;
    try { parsed = JSON.parse(text); } catch { return { accepted: false, queuedAtMs, error: 'stdout invalido' }; }
    return { accepted: parsed.success === true, queuedAtMs, transport: parsed.transport,
      eventsSent: parsed.eventsSent, pointerEventsSent: parsed.pointerEventsSent };
  }

  return {
    step(direction) {
      const queuedAtMs = Date.now();
      if (!Number.isInteger(direction) || direction < 0 || direction > 7) {
        return { accepted: false, queuedAtMs, error: 'direction fora de 0..7' };
      }
      return run(['--direction', String(direction)]);
    },
    clickClient(x, y) {
      const queuedAtMs = Date.now();
      if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0) {
        return { accepted: false, queuedAtMs, error: 'coordenada de cliente invalida' };
      }
      return run(['--click', String(x), String(y)]);
    },
    talk(text) {
      const queuedAtMs = Date.now();
      if (typeof text !== 'string' || !text || text.length > 200) {
        return { accepted: false, queuedAtMs, error: 'texto invalido (1..200)' };
      }
      return run(['--talk', text]);
    },
    potion(hotkey) {
      const queuedAtMs = Date.now();
      if (typeof hotkey !== 'string' || !hotkey.trim()) {
        return { accepted: false, queuedAtMs, error: 'hotkey vazia' };
      }
      return run(['--potion', hotkey]);
    },
  };
}

function createInputSink({ mode = 'replay', outcomes = [], now = Date.now, ...live } = {}) {
  if (mode === 'live') return createLiveSink(live);
  if (mode !== 'replay') throw Error('modo deve ser live ou replay');
  const calls = [];
  const decide = () => (outcomes[calls.length] ?? true) === true;
  return {
    calls,
    step(direction) {
      const accepted = Number.isInteger(direction) && direction >= 0 && direction <= 7 && decide();
      const result = { accepted, queuedAtMs: now() };
      calls.push({ type: 'step', direction, ...result }); return result;
    },
    clickClient(x, y) {
      const accepted = Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && decide();
      const result = { accepted, queuedAtMs: now() };
      calls.push({ type: 'clickClient', x, y, ...result }); return result;
    },
    talk(text) {
      const accepted = typeof text === 'string' && text.length > 0 && decide();
      const result = { accepted, queuedAtMs: now() };
      calls.push({ type: 'talk', text, ...result }); return result;
    },
    potion(hotkey) {
      const accepted = typeof hotkey === 'string' && hotkey.length > 0 && decide();
      const result = { accepted, queuedAtMs: now() };
      calls.push({ type: 'potion', hotkey, ...result }); return result;
    },
  };
}
module.exports = { createInputSink, createLiveSink };
