'use strict';

/**
 * Garante o canal nativo do bot antes de a interface conectar.
 *
 * A UI nao deve exigir que o usuario rode um .exe antes: ao iniciar um modulo,
 * esta funcao:
 *   1. ve se o pipe `pka-runtime-2-<pid>` ja existe;
 *   2. se nao existe, copia a DLL para a pasta do jogo com nome neutro
 *      (`d3dx9_43.dll`), copia os `pka_*.txt` ao lado e injeta;
 *   3. expoe a chave do canal em `PKA_CHANNEL_KEY` para o adapter.
 *
 * O nome neutro reduz a assinatura de modulo (o anticheat do cliente veria
 * `pka_native.dll` no processo).
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DEFAULT_MODULE = 'd3dx9_43.dll';

const pipeName = pid => '\\\\.\\pipe\\pka-runtime-2-' + pid;

function pipeExists(pid) {
  try {
    return fs.readdirSync('\\\\.\\pipe\\').some(name => name === 'pka-runtime-2-' + pid);
  } catch {
    return false;
  }
}

function processPath(pid) {
  const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `(Get-Process -Id ${pid} -ErrorAction Stop).Path`], { encoding: 'utf8', windowsHide: true });
  const value = String(run.stdout || '').trim();
  if (!value) throw Error('nao consegui obter o caminho do processo ' + pid);
  return value;
}

function credentialsFromFiles(root) {
  const keyFile = path.join(root, 'native', 'pka_channel_key.txt');
  if (!fs.existsSync(keyFile)) return false;
  const key = fs.readFileSync(keyFile, 'utf8').trim();
  if (!key) return false;
  if (!process.env.PKA_CHANNEL_KEY && !process.env.PKA_CHANNEL_KEY_FILE) process.env.PKA_CHANNEL_KEY = key;
  return true;
}

function characterName(pid) {
  const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `(Get-Process -Id ${pid} -ErrorAction Stop).MainWindowTitle`], { encoding: 'utf8', windowsHide: true });
  const title = String(run.stdout || '').trim();
  const match = /^PokeAlliance\s*-\s*(.+)$/u.exec(title);
  return match ? match[1].trim() : '';
}

function copyBuild(root, gameDir, moduleName, pidForName) {
  const source = path.join(root, 'native', 'pka_native.dll');
  if (!fs.existsSync(source)) throw Error('native/pka_native.dll ausente');
  const target = path.join(gameDir, moduleName);
  fs.copyFileSync(source, target);
  for (const name of fs.readdirSync(path.join(root, 'native'))) {
    if (!/^pka_.*\.txt$/u.test(name)) continue;
    fs.copyFileSync(path.join(root, 'native', name), path.join(gameDir, name));
  }
  /* O nome do personagem muda com a conta; sincroniza do titulo da janela
   * para o scanner achar a entidade certa (o arquivo antigo apontava para a
   * conta anterior). */
  const character = characterName(pidForName);
  if (character) {
    fs.writeFileSync(path.join(root, 'native', 'pka_player_name.txt'), character);
    fs.writeFileSync(path.join(gameDir, 'pka_player_name.txt'), character);
  }
  return target;
}

function inject(root, pid, moduleName) {
  const gameDir = path.dirname(processPath(pid));
  const dll = copyBuild(root, gameDir, moduleName, pid);
  const run = spawnSync(path.join(root, 'native', 'pka_inject.exe'), ['--pid', String(pid), '--dll', dll],
    { encoding: 'utf8', windowsHide: true });
  if (run.status !== 0) throw Error((run.stderr || run.stdout || 'injeção falhou').trim());
  return { dll, module: moduleName };
}

/**
 * @returns {Promise<{injected:boolean,module:string|null,reason?:string}>}
 */
async function ensureChannel(pid, options = {}) {
  const root = options.root || path.resolve(__dirname, '..');
  const moduleName = options.module || DEFAULT_MODULE;
  if (!Number.isInteger(pid) || pid <= 0) return { injected: false, module: null, reason: 'invalid-pid' };
  credentialsFromFiles(root);
  if (pipeExists(pid)) return { injected: false, module: null, reason: 'pipe-present' };
  if (options.dryRun) return { injected: false, module: null, reason: 'pipe-missing' };
  /* PKA_NO_INJECT=1: modelo Shiba (cliente externo do canal do jogo). Util
   * quando o handshake do canal for aceito; hoje o adapter ainda toma EPIPE. */
  if (options.inject === false) return { injected: false, module: null, reason: 'pipe-missing' };
  let injected = false;
  let module = null;
  try {
    const result = inject(root, pid, moduleName);
    injected = true;
    module = result.module;
  } catch (error) {
    return { injected: false, module: null, reason: error.message };
  }
  const deadline = Date.now() + (options.timeoutMs || 20000);
  while (Date.now() < deadline) {
    if (pipeExists(pid)) return { injected, module, reason: 'pipe-ready' };
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  return { injected, module, reason: 'pipe-timeout' };
}

module.exports = { ensureChannel, pipeExists, pipeName, DEFAULT_MODULE };
