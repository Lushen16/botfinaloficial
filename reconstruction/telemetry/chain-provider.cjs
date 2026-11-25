'use strict';
const { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } = require('node:fs');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const PACKAGED_BIN = path.join(ROOT, 'dist-tools', 'PKA Tools.exe');
const MIN_INTERVAL_MS = 2000;
const PROD_MIN_INTERVAL_MS = 5000;
const DEFAULT_MAX_SESSION_MIN = 20;

function resolvePython(env) {
  return env.PKA_PYTHON || 'python';
}

function recordPidImmediate(pidFile, pid) {
  if (!pidFile || !Number.isInteger(pid) || pid <= 0) return;
  try {
    let existing = [];
    if (existsSync(pidFile)) {
      const raw = readFileSync(pidFile, 'utf8').trim();
      if (raw.startsWith('[')) existing = JSON.parse(raw);
    }
    const next = [...new Set([...(Array.isArray(existing) ? existing : []), pid].filter(n => Number.isInteger(n) && n > 0))];
    mkdirSync(path.dirname(pidFile), { recursive: true });
    writeFileSync(pidFile, JSON.stringify(next), 'utf8');
  } catch {}
}

function unrecordPid(pidFile, pid) {
  if (!pidFile || !Number.isInteger(pid) || pid <= 0) return;
  try {
    if (!existsSync(pidFile)) return;
    const raw = readFileSync(pidFile, 'utf8').trim();
    if (!raw.startsWith('[')) return;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    const next = parsed.filter(n => Number.isInteger(n) && n > 0 && n !== pid);
    if (!next.length) rmSync(pidFile, { force: true });
    else writeFileSync(pidFile, JSON.stringify(next), 'utf8');
  } catch {}
}

function createLiveProvider({ pid, name, chainRva, creatureChainRva, mapTileBlocksRva, tileRadius, intervalMs = 5000, maxSessionMin = DEFAULT_MAX_SESSION_MIN, pidFile = null, python, env = process.env, spawnImpl = spawn } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) throw TypeError('pid precisa ser inteiro positivo');
  const usePackaged = !python && spawnImpl === spawn && env.PKA_CHAIN_USE_PYTHON !== '1' && existsSync(PACKAGED_BIN);
  const interval = Math.max(usePackaged ? PROD_MIN_INTERVAL_MS : MIN_INTERVAL_MS, Number(intervalMs) || MIN_INTERVAL_MS);
  const minutes = Number.isFinite(Number(maxSessionMin)) && Number(maxSessionMin) > 0 ? Number(maxSessionMin) : DEFAULT_MAX_SESSION_MIN;
  const commonArgs = ['--pid', String(pid), '--chain-rva', String(chainRva), '--interval-ms', String(interval), '--no-scan'];
  if (name) commonArgs.push('--name', name);
  if (creatureChainRva) commonArgs.push('--creatures', '--creature-chain-rva', String(creatureChainRva));
  if (mapTileBlocksRva) {
    commonArgs.push('--items', '--tile-blocks-rva', String(mapTileBlocksRva));
    if (tileRadius !== undefined && tileRadius !== null) commonArgs.push('--tile-radius', String(tileRadius));
  }
  const args = [path.join(ROOT, 'tools', 'chain_sampler.py'), ...commonArgs];
  let session = null;
  let callback = null;
  let current = null;
  let lastSeq = 0;

  function consume(line) {
    const text = line.trim();
    if (!text) return;
    let frame;
    try { frame = JSON.parse(text); } catch { return; }
    if (!Number.isInteger(frame.seq) || frame.seq <= lastSeq) return;
    lastSeq = frame.seq;
    if (!frame.sampledAtMs) frame.sampledAtMs = Date.now();
    if (!frame.pid) frame.pid = pid;
    if (frame.player === undefined) frame.player = null;
    current = frame;
    if (callback) callback(frame);
  }

  function detach(entry) {
    if (!entry) return;
    if (entry.child && entry.child.stdout) {
      entry.child.stdout.removeAllListeners('data');
      entry.child.removeAllListeners('exit');
    }
    if (entry.socket) {
      entry.socket.removeAllListeners('data');
      entry.socket.destroy();
    }
    if (entry.server) {
      try { entry.server.close(); } catch {}
    }
  }

  return {
    start(cb) {
      if (typeof cb !== 'function') throw TypeError('callback precisa ser funcao');
      callback = cb;
      if (session) return;
      const entry = { child: null, socket: null, server: null, buffer: '' };
      session = entry;

      if (usePackaged) {
        const server = net.createServer((socket) => {
          if (session !== entry) { socket.destroy(); return; }
          entry.socket = socket;
          socket.setEncoding('utf8');
          socket.on('data', (chunk) => {
            if (session !== entry) return;
            entry.buffer += chunk;
            let index;
            while ((index = entry.buffer.indexOf('\n')) >= 0) {
              consume(entry.buffer.slice(0, index));
              entry.buffer = entry.buffer.slice(index + 1);
            }
          });
        });
        entry.server = server;
        server.listen(0, '127.0.0.1', () => {
          if (session !== entry) { try { server.close(); } catch {} return; }
          const addr = server.address();
          const port = addr && typeof addr === 'object' ? addr.port : 0;
          const exeArgs = [...commonArgs, '--minutes', String(minutes), '--stream-port', String(port)];
          const child = spawnImpl(PACKAGED_BIN, exeArgs, { cwd: ROOT, windowsHide: true, detached: false, env });
          recordPidImmediate(pidFile, child?.pid);
          entry.child = child;
          child.on('exit', () => {
            unrecordPid(pidFile, child?.pid);
            if (session === entry) {
              detach(entry);
              session = null;
            }
          });
        });
        return;
      }

      const child = spawnImpl(resolvePython(env), args, { cwd: ROOT, windowsHide: true, detached: false, env });
      recordPidImmediate(pidFile, child?.pid);
      entry.child = child;
      entry.child.stdout.setEncoding('utf8');
      entry.child.stdout.on('data', (chunk) => {
        if (session !== entry) return;
        entry.buffer += chunk;
        let index;
        while ((index = entry.buffer.indexOf('\n')) >= 0) {
          consume(entry.buffer.slice(0, index));
          entry.buffer = entry.buffer.slice(index + 1);
        }
      });
      entry.child.on('exit', () => {
        unrecordPid(pidFile, child?.pid);
        if (session === entry) session = null;
      });
    },
    stop() {
      callback = null;
      const entry = session;
      session = null;
      if (entry) {
        detach(entry);
        if (entry.child) {
          unrecordPid(pidFile, entry.child.pid);
          if (process.platform === 'win32' && Number.isInteger(entry.child.pid) && entry.child.pid > 0) {
            try { execFileSync('taskkill.exe', ['/PID', String(entry.child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }); } catch {}
          }
          try { entry.child.kill(); } catch {}
        }
      }
    },
    latest() { return current; },
    get intervalMs() { return interval; },
  };
}

function createChainProvider({ mode = 'replay', file, frames, ...live } = {}) {
  if (mode === 'live') return createLiveProvider(live);
  if (mode !== 'replay') throw Error('modo deve ser live ou replay');
  const records = frames ?? JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (!Array.isArray(records)) throw TypeError('Expected an array of frames');
  let index = 0, callback = null, current = null;
  return {
    mode: 'replay',
    start(cb) { if (typeof cb !== 'function') throw TypeError('Expected callback'); callback = cb; },
    stop() { callback = null; },
    latest() { return current; },
    next() {
      if (!callback || index >= records.length) return false;
      current = records[index++]; callback(current); return true;
    },
  };
}

module.exports = {
  createChainProvider,
  createLiveProvider,
  PACKAGED_BIN,
  MIN_INTERVAL_MS,
  PROD_MIN_INTERVAL_MS,
  DEFAULT_MAX_SESSION_MIN,
};
