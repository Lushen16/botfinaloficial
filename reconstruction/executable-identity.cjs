'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { isSupportedExecutable } = require('./executable-profile.cjs');

/** Resolve o caminho do executavel de um PID usando metadados do SO (zero leitura de memoria). */
function resolveExecutablePathForPid(pid, run = spawnSync) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const result = run('powershell.exe', [
    '-NoProfile',
    '-Command',
    '(Get-Process -Id ' + pid + ' -ErrorAction SilentlyContinue).Path',
  ], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  if (result.error || result.status !== 0) return null;
  const exePath = String(result.stdout || '').trim().split(/\r?\n/)[0]?.trim();
  return exePath || null;
}

function sha256File(filePath, readFileSync = fs.readFileSync) {
  if (typeof filePath !== 'string' || !filePath) return null;
  try {
    const bytes = readFileSync(filePath);
    return crypto.createHash('sha256').update(bytes).digest('hex').toLowerCase();
  } catch {
    return null;
  }
}

/** Calcula SHA-256 do binario em disco para o PID e valida contra executable-profile. */
function verifyExecutableForPid(pid, { run = spawnSync, readFileSync = fs.readFileSync } = {}) {
  const exePath = resolveExecutablePathForPid(pid, run);
  if (!exePath) {
    return { pid, path: null, sha256: null, supported: false, error: 'executable-path-unavailable' };
  }
  const sha256 = sha256File(exePath, readFileSync);
  if (!sha256) {
    return { pid, path: exePath, sha256: null, supported: false, error: 'executable-read-failed' };
  }
  const supported = isSupportedExecutable(sha256);
  return {
    pid,
    path: exePath,
    sha256,
    supported,
    error: supported ? null : 'unsupported-build',
  };
}

module.exports = { resolveExecutablePathForPid, sha256File, verifyExecutableForPid };
