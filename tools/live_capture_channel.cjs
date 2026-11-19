'use strict';

/**
 * Captura pelo canal nativo (`useWith`), com verificacao de efeito no corpo.
 *
 *   node tools/live_capture_channel.cjs --pid <PID> --key 4
 *   node tools/live_capture_channel.cjs --pid <PID> --key 4 --kill
 *   node tools/live_capture_channel.cjs --pid <PID> --dry
 *
 * O corpo vem de `telemetry.items` (o item publica `corpseId` = id alvo). O
 * comando manda a tecla da bola e clica no tile do corpo. Aceite so' com o
 * corpo saindo de `items` dentro da janela; ACK nao conta.
 *
 * `--kill` mata o selvagem vivo mais proximo antes, para criar corpo.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const adapter = require('../reconstruction/native-adapter.cjs');

const args = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const index = args.indexOf('--' + name);
  return index >= 0 ? args[index + 1] : fallback;
};
const pid = Number(opt('pid', process.env.PKA_PID || 0));
const ballKey = String(opt('key', '4'));
const wantKill = args.includes('--kill');
const dry = args.includes('--dry');
const maxDistance = Number(opt('max-distance', 3));
const ballSlot = Number(opt('slot', 0));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const chebyshev = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

if (!Number.isInteger(pid) || pid <= 0) {
  console.error('uso: node tools/live_capture_channel.cjs --pid <PID> --key <tecla da bola> [--kill] [--dry]');
  process.exit(2);
}

function focusGame() {
  const script = "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class FG{[DllImport(\"user32.dll\")]public static extern bool SetForegroundWindow(IntPtr h);[DllImport(\"user32.dll\")]public static extern bool ShowWindow(IntPtr h,int c);}'; $p=Get-Process -Id " + pid + " -ErrorAction SilentlyContinue; if($p){[void][FG]::ShowWindow($p.MainWindowHandle,9);[void][FG]::SetForegroundWindow($p.MainWindowHandle)}";
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8' });
}

const evidenceFile = path.resolve(__dirname, '../local-data',
  'capture-channel-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
const evidence = { generatedAt: new Date().toISOString(), pid, ballKey, samples: [], result: null };

function finish(result) {
  evidence.result = result;
  fs.mkdirSync(path.dirname(evidenceFile), { recursive: true });
  fs.writeFileSync(evidenceFile, JSON.stringify(evidence, null, 1) + '\n');
  console.log(JSON.stringify({ ...result, evidence: evidenceFile }));
  process.exit(result.ok ? 0 : 1);
}

async function main() {
  let adapterHandle;
  for (let attempt = 0; attempt < 12 && !adapterHandle; attempt += 1) {
    try { adapterHandle = await adapter.open({ pid }); } catch { await sleep(500); }
  }
  if (!adapterHandle) finish({ ok: false, reason: 'canal indisponivel' });

  const telemetry = () => adapterHandle.getSnapshot()?.telemetry || {};
  await sleep(800);
  let state = adapterHandle.getSnapshot();
  if (!state?.online || state.stale) finish({ ok: false, reason: 'sessao offline/estale' });
  if (state.telemetry?.runtimeReady !== true) finish({ ok: false, reason: 'runtimeReady=false' });

  focusGame();
  await sleep(600);

  if (wantKill) {
    const target = (telemetry().creatures || [])
      .filter(entry => entry.type === 1 && entry.healthPercent > 0)
      .sort((a, b) => chebyshev(a.pos, telemetry().position) - chebyshev(b.pos, telemetry().position))[0];
    if (!target) finish({ ok: false, reason: 'nenhum selvagem vivo para matar' });
    evidence.killed = { id: target.id, name: target.name };
    for (let step = 0; step < 6; step += 1) {
      const playerNow = telemetry().position;
      if (chebyshev(playerNow, target.pos) <= 1) break;
      if (!target.pos || target.pos.z !== playerNow.z) break;
      const dx = target.pos.x - playerNow.x;
      const dy = target.pos.y - playerNow.y;
      const direction = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 2 : 6) : (dy > 0 ? 4 : 0);
      await adapterHandle.command('walk', direction).catch(() => {});
      await sleep(700);
    }
    for (let i = 0; i < 25; i += 1) {
      const live = (telemetry().creatures || []).find(entry => entry.id === target.id);
      if (!live || live.healthPercent <= 0) break;
      await adapterHandle.command('attack', target.id).catch(() => {});
      await sleep(650);
    }
    await sleep(9000);
  }

  const player = telemetry().position;
  const candidates = (telemetry().items || [])
    .filter(item => item.pos && item.pos.z === player.z)
    .map(item => ({ item, distance: chebyshev(item.pos, player) }))
    .filter(entry => entry.distance <= maxDistance)
    .sort((a, b) => a.distance - b.distance);
  evidence.candidates = candidates.map(entry => ({ id: entry.item.id, distance: entry.distance, pos: entry.item.pos }));
  if (!candidates.length) finish({ ok: false, reason: 'nenhum corpo a <= ' + maxDistance + ' tiles' });
  const corpse = candidates[0].item;
  evidence.corpse = corpse;
  if (dry) finish({ ok: true, dry: true, corpse });

  const result = await adapterHandle
    .command('useWith', { x: corpse.pos.x, y: corpse.pos.y, z: corpse.pos.z,
      itemId: Number(opt('item-id', 48961)), targetId: corpse.corpseId ?? corpse.id, stack: ballSlot || (corpse.stack ?? 1), key: ballKey || undefined })
    .catch(error => ({ error: error.message }));
  evidence.command = result;

  const gone = () => !(telemetry().items || []).some(item => item.id === corpse.id);
  let removed = false;
  for (let i = 0; i < 10; i += 1) {
    await sleep(500);
    const items = telemetry().items || [];
    evidence.samples.push({ at: i, items: items.length, corpsePresent: items.some(item => item.id === corpse.id) });
    if (!items.some(item => item.id === corpse.id)) { removed = true; break; }
  }
  await adapterHandle.close();
  finish({ ok: removed, corpseId: corpse.id, command: result, removed, samples: evidence.samples.length });
}

main().catch(error => finish({ ok: false, reason: error.message }));
