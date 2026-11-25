'use strict';

/**
 * Walker por CLIQUE NO TILE (autowalk do cliente), entrada fisica.
 *
 * Modelo do Shiba: uma acao por vez, jogo em foco, mouse de nivel de hardware.
 * Nao usa DLL, nao usa PostMessage.
 *
 *   node tools/live_click_walk.cjs --pid 1234 --name Char --seconds 120
 *   node tools/live_click_walk.cjs --pid 1234 --name Char --to 3290,2110,7
 *
 * Requer: jogo em personagem, janela visivel, scanner Python disponivel.
 * Le a rota do perfil ativo (local-data/profiles/electron/settings.json).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const arg = (name, fallback = null) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

const pid = Number(arg('pid', 0));
const playerName = String(arg('name', ''));
const seconds = Number(arg('seconds', 120));
const to = String(arg('to', ''));
if (!Number.isInteger(pid) || pid <= 0 || !playerName) {
  console.error('uso: node tools/live_click_walk.cjs --pid <PID> --name <Char> [--seconds 120] [--to x,y,z]');
  process.exit(2);
}

const creaturesFile = path.join(os.tmpdir(), 'pka-click-creatures-' + pid + '.json');
const viewportFile = path.join(root, 'local-data', 'keyboard-combat.json');
const viewport = JSON.parse(fs.readFileSync(viewportFile, 'utf8')).viewport;

function clientSize() {
  const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class CR{[StructLayout(LayoutKind.Sequential)]public struct R{public int l,t,r,b;}[DllImport("user32.dll")]public static extern bool GetClientRect(IntPtr h, ref R r);}'; $p=Get-Process | Where-Object { $_.ProcessName -like "PokeAlliance*" -and $_.ProcessName -notlike "*Launcher*" } | Select-Object -First 1; $r=New-Object CR+R; [void][CR]::GetClientRect($p.MainWindowHandle,[ref]$r); "$($r.r-$r.l)x$($r.b-$r.t)"`],
  { encoding: 'utf8', windowsHide: true });
  const m = /^(\d+)x(\d+)/m.exec(String(run.stdout || '').trim());
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

function route() {
  const settings = JSON.parse(fs.readFileSync(path.join(root, 'local-data/profiles/electron/settings.json'), 'utf8'));
  const profile = settings.profiles.find(p => p.name === settings.activeProfile);
  const waypoints = (profile?.config?.walker?.waypoints || [])
    .filter(w => ['walk', 'box', 'safespot'].includes(w.action) && w.pos)
    .map(w => ({ ...w.pos }));
  if (to) {
    const [x, y, z] = to.split(',').map(Number);
    waypoints.push({ x, y, z });
  }
  return waypoints;
}

function project(player, tile, size) {
  const sx = size.width / viewport.width;
  const sy = size.height / viewport.height;
  const scale = (sx + sy) / 2;
  return {
    x: Math.round((viewport.centerX + (tile.x - player.x) * viewport.tileSize) * sx),
    y: Math.round((viewport.centerY + (tile.y - player.y) * viewport.tileSize) * sy),
    width: size.width, height: size.height, scale,
  };
}

async function main() {
  const size = clientSize();
  if (!size) { console.error('nao consegui ler o tamanho do cliente'); process.exit(3); }
  console.log(JSON.stringify({ client: size, viewport }));

  const scanner = spawn('python', ['tools/scan_creatures.py', '--pid', String(pid),
    '--player-name', playerName, '--stream', '--interval-ms', '200', '--output', creaturesFile],
  { cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  scanner.stderr.on('data', d => process.stderr.write('[scanner] ' + d.toString()));

  const actuator = spawn('python', ['tools/combat_actuator.py'], { cwd: root, windowsHide: true });
  let buffer = '';
  const pending = [];
  actuator.stdout.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (line.trim()) { const r = pending.shift(); if (r) r(line); }
    }
  });
  let nextId = 1;
  const send = command => new Promise(resolve => {
    pending.push(resolve);
    actuator.stdin.write(JSON.stringify({ id: nextId++, pid, request: command }) + '\n');
  });

  const waypoints = route();
  if (!waypoints.length) { console.error('rota vazia no perfil'); process.exit(4); }
  let index = 0, lastClick = 0, clicks = 0, started = false;
  const deadline = Date.now() + seconds * 1000;
  try {
    while (Date.now() < deadline) {
      let snapshot;
      try { snapshot = JSON.parse(fs.readFileSync(creaturesFile, 'utf8')); } catch { await sleep(200); continue; }
      const player = snapshot.player?.pos;
      if (!player) { await sleep(200); continue; }
      if (!started) {
        started = true;
        let best = 0, bestDistance = Infinity;
        waypoints.forEach((w, i) => {
          const d = Math.max(Math.abs(w.x - player.x), Math.abs(w.y - player.y));
          if (d < bestDistance) { bestDistance = d; best = i; }
        });
        index = best;
      }
      const goal = waypoints[index];
      const distance = Math.max(Math.abs(goal.x - player.x), Math.abs(goal.y - player.y));
      /* Autowalk precisa de destino visivel: mira no maximo 6 tiles por clique. */
      const stepGoal = {
        x: player.x + Math.max(-6, Math.min(6, goal.x - player.x)),
        y: player.y + Math.max(-6, Math.min(6, goal.y - player.y)),
        z: player.z,
      };
      if (distance <= 1 && Math.abs(goal.z - player.z) <= 0) {
        index += 1;
        if (index >= waypoints.length) break;
        continue;
      }
      if (Date.now() - lastClick >= 1100) {
        const point = project(player, stepGoal, size);
        const inside = point.x > 0 && point.y > 0 && point.x < size.width && point.y < size.height;
        if (inside) {
          const reply = await send({ kind: 'click', pid, playerName, sendInput: true,
            x: point.x, y: point.y, width: size.width, height: size.height });
          clicks += 1;
          console.log(JSON.stringify({ at: new Date().toISOString(), stepGoal, player, point, reply: reply.slice(0, 120) }));
        }
        lastClick = Date.now();
      }
      await sleep(150);
    }
  } finally {
    actuator.stdin.end();
    scanner.kill();
  }
  console.log(JSON.stringify({ done: true, clicks, waypoint: index }));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
main().catch(error => { console.error(error); process.exit(1); });
