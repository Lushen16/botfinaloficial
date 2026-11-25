'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { migrateTelemetry } = require('../reconstruction/settings.cjs');
const {
  shouldSpawnLegacy,
  createTracker,
  reapStale,
  inspectReaderDescendants,
  bootProviders,
  validateGameProcessPid,
} = require('../reconstruction/app/provider-guard.cjs');

test('perfil sem telemetry migra para chain, nao legacy', () => {
  const migrated = migrateTelemetry({});
  assert.equal(migrated.telemetry.mode, 'chain');
  assert.equal(migrated.tools.telemetry.mode, 'chain');
  assert.equal(migrateTelemetry(null).telemetry.mode, 'chain');
});

test('shouldSpawnLegacy e deny-by-default para config ausente, chain ou replay', () => {
  assert.equal(shouldSpawnLegacy(undefined), false);
  assert.equal(shouldSpawnLegacy(null), false);
  assert.equal(shouldSpawnLegacy({}), false);
  assert.equal(shouldSpawnLegacy(migrateTelemetry({})), false);
  assert.equal(shouldSpawnLegacy({ telemetry: { mode: 'chain' } }, { keyboardBackend: true }), false);
  assert.equal(shouldSpawnLegacy({ telemetry: { mode: 'replay' } }, { keyboardBackend: true }), false);
  assert.equal(shouldSpawnLegacy({ telemetry: { mode: 'native' } }, { keyboardBackend: false, env: {} }), false);
  assert.equal(shouldSpawnLegacy({ telemetry: { mode: 'native' } }, { keyboardBackend: true, env: {} }), true);
  assert.equal(shouldSpawnLegacy({ telemetry: { mode: 'native' } }, { keyboardBackend: true, simEnabled: true }), false);
});

test('modo chain nao spawna nenhum processo python', async () => {
  const spawnedCmds = [];
  const cfg = migrateTelemetry({});
  const result = bootProviders(cfg, {
    keyboardBackend: false,
    startLegacy: () => {
      spawnedCmds.push('python tools/pka_live_session.py');
    },
  });
  assert.equal(result.legacySpawned, false);
  assert.equal(spawnedCmds.filter(c => /python|pka_live_session|scan_/.test(c)).length, 0);
});

test('spawnTracked grava pidfile sem detached e stopAll mata arvore e limpa pidfile', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pka-tracker-'));
  const pidFile = path.join(dir, 'providers.pid');
  const killed = [];
  const spawnOpts = [];
  const tracker = createTracker({
    pidFile,
    spawnImpl: (cmd, args, opts) => {
      spawnOpts.push(opts);
      const child = new EventEmitter();
      child.pid = 9901;
      child.kill = () => {};
      return child;
    },
    execImpl: (cmd, args) => { killed.push([cmd, ...args]); },
  });
  tracker.spawnTracked('python', ['tools/pka_live_session.py'], { detached: true });
  assert.equal(spawnOpts[0].detached, false);
  assert.equal(spawnOpts[0].windowsHide, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(pidFile, 'utf8')), [9901]);
  tracker.stopAll();
  assert.equal(fs.existsSync(pidFile), false);
  if (process.platform === 'win32') {
    assert.ok(killed.some(k => k.includes('/PID') && k.includes('9901') && k.includes('/T')));
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('reapStale mata apenas PIDs com CommandLine de provider e preserva PID reciclado', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pka-reaper-'));
  const pidFile = path.join(dir, 'providers.pid');
  fs.writeFileSync(pidFile, JSON.stringify([4111, 4222]), 'utf8');
  const killed = [];
  const reaped = reapStale({
    pidFile,
    execImpl: (cmd, args) => {
      if (cmd === 'powershell.exe') {
        if (args[2].includes('ProcessId=4111')) return 'python tools/pka_live_session.py --watch';
        return '"C:\\Windows\\System32\\notepad.exe"';
      }
      if (cmd === 'taskkill.exe') killed.push(args);
      return '';
    },
  });
  assert.deepEqual(reaped, [4111]);
  assert.equal(fs.existsSync(pidFile), false);
  if (process.platform === 'win32') {
    assert.equal(killed.length, 1);
    assert.ok(killed[0].includes('4111'));
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('validateGameProcessPid rejeita launcher e PIDs que nao sao PokeAlliance', () => {
  const notGame = validateGameProcessPid(1234, {
    execImpl: () => JSON.stringify({ ProcessId: 1234, Name: 'notepad.exe', CommandLine: 'notepad.exe' }),
  });
  assert.equal(notGame.valid, false);
  const launcher = validateGameProcessPid(1235, {
    execImpl: () => JSON.stringify({ ProcessId: 1235, Name: 'PokeAllianceLauncher.exe', CommandLine: 'Launcher' }),
  });
  assert.equal(launcher.valid, false);
  const validGame = validateGameProcessPid(1236, {
    execImpl: () => JSON.stringify({ ProcessId: 1236, Name: 'PokeAlliance_dx.exe', ExecutablePath: 'C:\\PokeAlliance_dx.exe', CommandLine: '"C:\\PokeAlliance_dx.exe"' }),
  });
  assert.equal(validGame.valid, true);
});

test('T8 & Buraco 1/5: reaper mata PKA Tools.exe orfao e inspectReaderDescendants e recursivo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pka-tools-reaper-'));
  const pidFile = path.join(dir, 'providers.pid');
  fs.writeFileSync(pidFile, JSON.stringify([7100]), 'utf8');
  const killed = [];
  const reaped = reapStale({
    pidFile,
    execImpl: (cmd, args) => {
      if (cmd === 'powershell.exe' && args[2].includes('ProcessId=7100')) {
        return '"C:\\app\\dist-tools\\PKA Tools.exe" --pid 4512 --chain-rva 0x3A03598 --no-scan --stream-port 55555';
      }
      if (cmd === 'taskkill.exe') killed.push(args);
      return '';
    },
  });
  assert.deepEqual(reaped, [7100]);
  if (process.platform === 'win32') {
    assert.ok(killed.some(k => k.includes('7100') && k.includes('/T')));
  }
  const tree = inspectReaderDescendants(100, () => JSON.stringify([
    { ProcessId: 100, ParentProcessId: 1, Name: 'electron.exe', CommandLine: 'electron' },
    { ProcessId: 200, ParentProcessId: 100, Name: 'PKA Tools.exe', CommandLine: 'PKA Tools.exe --stream-port 55555' },
    { ProcessId: 201, ParentProcessId: 200, Name: 'PKA Tools.exe', CommandLine: 'PKA Tools.exe --stream-port 55555' },
    { ProcessId: 300, ParentProcessId: 201, Name: 'python.exe', CommandLine: 'python helper.py' },
  ]));
  assert.equal(tree.readers.length, 2);
  assert.equal(tree.readerRoots.length, 1);
  assert.equal(tree.python.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('T4: PKA_LEGACY_PYTHON=1 habilita spawn legado apenas com flag explicita', () => {
  const cfg = migrateTelemetry({});
  assert.equal(shouldSpawnLegacy(cfg, { keyboardBackend: false, env: {} }), false);
  assert.equal(shouldSpawnLegacy(cfg, { keyboardBackend: false, env: { PKA_LEGACY_PYTHON: '1' } }), true);
  let called = 0;
  const res = bootProviders(cfg, { env: { PKA_LEGACY_PYTHON: '1' }, startLegacy: () => { called++; } });
  assert.equal(res.legacySpawned, true);
  assert.equal(called, 1);
});
