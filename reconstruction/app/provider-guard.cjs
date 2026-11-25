'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const READER_RE = /pka_live_session|scan_creatures|scan_items|PKA[ _-]?Tools/i;
const PYTHON_RE = /^python/i;

function shouldSpawnLegacy(normalizedConfig, { simEnabled = false, smoke = false, keyboardBackend = false, env = process.env } = {}) {
  if (simEnabled || smoke) return false;
  const mode = normalizedConfig?.telemetry?.mode ?? normalizedConfig?.tools?.telemetry?.mode;
  if (mode === 'replay') return false;
  if (env?.PKA_LEGACY_PYTHON === '1') return true;
  if (mode !== 'native') return false;
  return Boolean(keyboardBackend);
}

function killTree(pid, execImpl = execFileSync) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    if (process.platform === 'win32') {
      execImpl('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 });
    } else {
      process.kill(pid, 'SIGKILL');
    }
    return true;
  } catch {
    return false;
  }
}

function readPidFile(pidFile, fsImpl = fs) {
  if (!pidFile || !fsImpl.existsSync(pidFile)) return [];
  try {
    const raw = fsImpl.readFileSync(pidFile, 'utf8').trim();
    if (!raw) return [];
    const values = raw.startsWith('[') ? JSON.parse(raw) : raw.split(/\s+/);
    if (!Array.isArray(values)) return [];
    const seen = new Set();
    for (const entry of values) {
      const pid = Number(entry);
      if (Number.isInteger(pid) && pid > 0) seen.add(pid);
    }
    return [...seen];
  } catch {
    return [];
  }
}

function writePidFile(pidFile, pids, fsImpl = fs) {
  if (!pidFile) return;
  try {
    const list = [...new Set(pids.filter(pid => Number.isInteger(pid) && pid > 0))];
    if (!list.length) {
      fsImpl.rmSync(pidFile, { force: true });
      return;
    }
    fsImpl.mkdirSync(path.dirname(pidFile), { recursive: true });
    fsImpl.writeFileSync(pidFile, JSON.stringify(list), 'utf8');
  } catch {}
}

function createTracker({ pidFile, spawnImpl = spawn, execImpl = execFileSync, fsImpl = fs } = {}) {
  const spawned = new Set();

  function syncPidFile() {
    const pids = [];
    for (const child of spawned) {
      if (Number.isInteger(child?.pid) && child.pid > 0) pids.push(child.pid);
    }
    writePidFile(pidFile, pids, fsImpl);
  }

  function spawnTracked(cmd, args, options = {}) {
    const cleanOptions = { ...options, windowsHide: true, detached: false };
    const child = spawnImpl(cmd, args, cleanOptions);
    spawned.add(child);
    syncPidFile();
    if (typeof child?.on === 'function') {
      child.on('exit', () => {
        spawned.delete(child);
        syncPidFile();
      });
    }
    return child;
  }

  function stopAll() {
    const targets = [...spawned];
    spawned.clear();
    for (const child of targets) {
      if (Number.isInteger(child?.pid) && child.pid > 0) {
        killTree(child.pid, execImpl);
      }
      if (typeof child?.kill === 'function') {
        try { child.kill(); } catch {}
      }
    }
    if (pidFile) {
      try { fsImpl.rmSync(pidFile, { force: true }); } catch {}
    }
  }

  return {
    spawned,
    spawnTracked,
    stopAll,
  };
}

function readProcessCommandLine(pid, execImpl = execFileSync) {
  if (!Number.isInteger(pid) || pid <= 0) return '';
  try {
    return String(execImpl('powershell.exe', [
      '-NoProfile',
      '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue).CommandLine`,
    ], { encoding: 'utf8', windowsHide: true, timeout: 5000 }) || '').trim();
  } catch {
    return '';
  }
}

function listAllProcesses(execImpl = execFileSync) {
  if (process.platform !== 'win32') return [];
  try {
    const out = String(execImpl('powershell.exe', [
      '-NoProfile',
      '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress',
    ], { encoding: 'utf8', windowsHide: true, timeout: 5000 }) || '').trim();
    if (!out) return [];
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function isOwnedOrphanReader(proc, rootDir = '') {
  const cmd = String(proc?.CommandLine || '');
  if (!cmd || !READER_RE.test(cmd)) return false;
  if (/pka_live_session|scan_creatures|scan_items/i.test(cmd)) return true;
  if (/PKA[ _-]?Tools/i.test(cmd)) {
    return /--stream-port/i.test(cmd) || (rootDir ? cmd.includes(rootDir) : false);
  }
  return false;
}

function reapStale({ pidFile, rootDir = '', reconcileLive = false, execImpl = execFileSync, fsImpl = fs } = {}) {
  const pids = readPidFile(pidFile, fsImpl);
  const reaped = [];
  const reapedSet = new Set();
  for (const pid of pids) {
    const cmdLine = readProcessCommandLine(pid, execImpl);
    if (READER_RE.test(cmdLine)) {
      killTree(pid, execImpl);
      reaped.push(pid);
      reapedSet.add(pid);
    }
  }
  if (reconcileLive && process.platform === 'win32') {
    const all = listAllProcesses(execImpl);
    for (const proc of all) {
      const pid = Number(proc?.ProcessId);
      if (!Number.isInteger(pid) || pid <= 0 || reapedSet.has(pid)) continue;
      if (isOwnedOrphanReader(proc, rootDir)) {
        killTree(pid, execImpl);
        reaped.push(pid);
        reapedSet.add(pid);
      }
    }
  }
  if (pidFile) {
    try { fsImpl.rmSync(pidFile, { force: true }); } catch {}
  }
  return reaped;
}

function collectDescendantsRecursive(allProcesses, rootPid) {
  const byParent = new Map();
  for (const proc of allProcesses) {
    const ppid = Number(proc?.ParentProcessId);
    if (!Number.isInteger(ppid)) continue;
    let bucket = byParent.get(ppid);
    if (!bucket) { bucket = []; byParent.set(ppid, bucket); }
    bucket.push(proc);
  }
  const visited = new Set([rootPid]);
  const queue = [rootPid];
  const descendants = [];
  while (queue.length) {
    const current = queue.shift();
    for (const child of byParent.get(current) || []) {
      const pid = Number(child?.ProcessId);
      if (!Number.isInteger(pid) || pid <= 0 || visited.has(pid)) continue;
      visited.add(pid);
      descendants.push(child);
      queue.push(pid);
    }
  }
  return descendants;
}

function inspectReaderDescendants(rootPid = process.pid, execImpl = execFileSync) {
  const all = listAllProcesses(execImpl);
  const descendants = Number.isInteger(rootPid) && rootPid > 0
    ? collectDescendantsRecursive(all, rootPid) : [];
  const python = descendants.filter(proc => PYTHON_RE.test(String(proc?.Name || ''))
    || /pka_live_session|scan_creatures|scan_items/i.test(String(proc?.CommandLine || '')));
  const readers = descendants.filter(proc => READER_RE.test(String(proc?.CommandLine || ''))
    || READER_RE.test(String(proc?.Name || '')));
  const readerIds = new Set(readers.map(proc => Number(proc?.ProcessId)).filter(n => Number.isInteger(n) && n > 0));
  const readerRoots = readers.filter(proc => !readerIds.has(Number(proc?.ParentProcessId)));
  return { descendants, python, readers, readerRoots };
}

function inspectPythonDescendants(rootPid = process.pid, execImpl = execFileSync) {
  return inspectReaderDescendants(rootPid, execImpl).python;
}

function validateGameProcessPid(pid, { execImpl = execFileSync } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return { valid: false, reason: 'invalid-pid' };
  if (process.platform !== 'win32') return { valid: true, pid };
  try {
    const out = String(execImpl('powershell.exe', [
      '-NoProfile',
      '-Command',
      `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue | Select-Object ProcessId,Name,ExecutablePath,CommandLine,CreationDate | ConvertTo-Json -Compress`,
    ], { encoding: 'utf8', windowsHide: true, timeout: 5000 }) || '').trim();
    if (!out) return { valid: false, reason: 'pid-not-found' };
    const info = JSON.parse(out);
    const name = String(info?.Name || '');
    const cmd = String(info?.CommandLine || '');
    if (!/^PokeAlliance/i.test(name) || /launcher/i.test(name) || /launcher/i.test(cmd)) {
      return { valid: false, reason: 'pid-not-pokealliance', name };
    }
    return { valid: true, pid, name, executablePath: info.ExecutablePath || null, creationDate: info.CreationDate || null };
  } catch {
    return { valid: false, reason: 'pid-check-failed' };
  }
}

function bootProviders(normalizedConfig, {
  simEnabled = false,
  smoke = false,
  keyboardBackend = false,
  env = process.env,
  startLegacy = () => {},
} = {}) {
  if (!shouldSpawnLegacy(normalizedConfig, { simEnabled, smoke, keyboardBackend, env })) {
    return { legacySpawned: false };
  }
  startLegacy(normalizedConfig);
  return { legacySpawned: true };
}

function createReconnectCoordinator({
  pidFile,
  rootDir = '',
  validatePid = validateGameProcessPid,
  verifyBuild = () => ({ supported: true }),
  closeRuntime = async () => {},
  stopAll = () => {},
  reap = opts => reapStale(opts),
  connectRuntime = async () => {},
  bootLegacy = () => {},
  discover = () => [],
  pickPid = pids => pids[0],
  now = Date.now,
} = {}) {
  let busy = false;
  let lastAttemptAt = 0;
  let sessionStartedAt = 0;
  let cooldownUntil = 0;

  async function reconnect(newPid, normalizedConfig) {
    if (now() < cooldownUntil) return { ok: false, reason: 'cooldown' };
    const pidCheck = validatePid(newPid);
    if (!pidCheck?.valid) return { ok: false, reason: pidCheck?.reason || 'invalid-pid' };
    const build = verifyBuild(newPid);
    if (build && build.path && !build.supported) return { ok: false, reason: 'unsupported-build' };
    await closeRuntime();
    stopAll();
    reap({ pidFile, rootDir, reconcileLive: true });
    await connectRuntime(newPid, normalizedConfig);
    sessionStartedAt = now();
    bootLegacy(normalizedConfig);
    return { ok: true, pid: newPid };
  }

  async function tick({ connected, currentPid, providerRunning = true, normalizedConfig, minIntervalMs = 5000 } = {}) {
    if (busy) return { action: 'busy' };
    const maxMin = Number(normalizedConfig?.telemetry?.maxSessionMin) || 20;
    const cooldownMin = Number(normalizedConfig?.telemetry?.cooldownMin ?? 5);
    if (connected && sessionStartedAt > 0 && now() - sessionStartedAt >= maxMin * 60000) {
      busy = true;
      try {
        sessionStartedAt = 0;
        cooldownUntil = now() + cooldownMin * 60000;
        await closeRuntime();
        stopAll();
        return { action: 'cooldown-stop', maxMin, cooldownMin };
      } finally {
        busy = false;
      }
    }
    if (now() < cooldownUntil || now() - lastAttemptAt < minIntervalMs) {
      return { action: 'wait' };
    }
    lastAttemptAt = now();
    busy = true;
    try {
      if (connected && currentPid) {
        const alive = validatePid(currentPid);
        if (alive?.valid && providerRunning !== false) {
          return { action: 'keep', pid: currentPid };
        }
        sessionStartedAt = 0;
        await closeRuntime();
        stopAll();
      }
      const pids = discover();
      if (!Array.isArray(pids) || !pids.length) return { action: 'no-game' };
      const pid = pickPid(pids);
      const res = await reconnect(pid, normalizedConfig);
      return { action: res.ok ? 'reconnected' : 'rejected', ...res };
    } finally {
      busy = false;
    }
  }

  return {
    reconnect,
    tick,
    state: () => ({ busy, sessionStartedAt, cooldownUntil }),
  };
}

module.exports = {
  LEGACY_CMD_RE: READER_RE,
  READER_RE,
  shouldSpawnLegacy,
  killTree,
  readPidFile,
  writePidFile,
  createTracker,
  listAllProcesses,
  isOwnedOrphanReader,
  reapStale,
  collectDescendantsRecursive,
  inspectReaderDescendants,
  inspectPythonDescendants,
  validateGameProcessPid,
  bootProviders,
  createReconnectCoordinator,
};
