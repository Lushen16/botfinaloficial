'use strict';

/**
 * Abre o cliente com NOME DE EXECUTAVEL ALEATORIO (como o Shiba manda:
 * "altere o nome do executavel para um nome aleatorio"). Cada sessao nasce
 * com outro nome, entao o modulo principal/processo deixa de ser sempre
 * `PokeAlliance_dx.exe`.
 *
 *   node tools/live_new_name_launch.cjs
 *   node tools/live_new_name_launch.cjs --dir "C:\caminho\do\jogo"
 *
 * O exe original nao e' tocado: cria uma copia na mesma pasta (o jogo acha os
 * assets pelo diretorio de trabalho). Mantem as 3 copias mais novas.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const DEFAULT_DIR = path.join(process.env.LOCALAPPDATA || '', 'PokeAlliance Games', 'PokeAlliance');
const arg = (name, fallback = null) => {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const gameDir = path.resolve(arg('dir', DEFAULT_DIR));
const original = path.join(gameDir, 'PokeAlliance_dx.exe');

if (!fs.existsSync(original)) {
  console.error('exe do cliente nao encontrado em ' + original);
  process.exit(2);
}

/* Um cliente por vez: o servidor ve varios logins do mesmo IP e a regra pode
 * tratar multi-client como abuso. `--keep-others` desliga. */
if (!process.argv.includes('--keep-others')) {
  const others = spawnSync('tasklist.exe', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
  for (const line of String(others.stdout || '').split(/\r?\n/u)) {
    const match = /^"(PokeAlliance(?![^"]*Launcher)[^"]*\.exe)","([0-9]+)"/iu.exec(line.trim());
    if (match) spawnSync('taskkill.exe', ['/PID', match[2], '/F'], { windowsHide: true });
  }
}

const suffix = crypto.randomBytes(3).toString('hex');
const name = `PokeAlliance_${suffix}.exe`;
const target = path.join(gameDir, name);
fs.copyFileSync(original, target);

/* Limpa copias antigas, mantendo as 3 mais recentes. */
const copies = fs.readdirSync(gameDir)
  .filter(entry => /^PokeAlliance_[0-9a-f]{6}\.exe$/iu.test(entry))
  .map(entry => ({ entry, at: fs.statSync(path.join(gameDir, entry)).mtimeMs }))
  .sort((a, b) => b.at - a.at);
for (const old of copies.slice(3)) {
  try { fs.unlinkSync(path.join(gameDir, old.entry)); } catch { /* em uso */ }
}

const started = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  `Start-Process -FilePath '${target.replace(/'/gu, "''")}' -WorkingDirectory '${gameDir.replace(/'/gu, "''")}' | Out-Null`],
{ encoding: 'utf8', windowsHide: true });
if (started.error || started.status !== 0) {
  console.error((started.stderr || started.error?.message || 'falha ao iniciar').trim());
  process.exit(1);
}

function findPid() {
  const run = spawnSync('tasklist.exe', ['/FI', `IMAGENAME eq ${name}`, '/FO', 'CSV', '/NH'],
    { encoding: 'utf8', windowsHide: true });
  const match = /^"[^"]+","([0-9]+)"/m.exec(String(run.stdout || ''));
  return match ? Number(match[1]) : null;
}

(async () => {
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    const pid = findPid();
    if (pid) {
      console.log(JSON.stringify({ ok: true, pid, name, path: target }));
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  console.log(JSON.stringify({ ok: false, name, reason: 'processo nao apareceu em 40 s' }));
  process.exitCode = 1;
})();
