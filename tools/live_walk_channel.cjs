#!/usr/bin/env node
'use strict';

/**
 * F4 — walker do clone contra o cliente real.
 *
 * Roda pelo caminho de producao (EngineRuntime + native-adapter + pipe da nossa
 * pka_native.dll) e so' aprova quando o EFEITO aparece na posicao. Aceita:
 *
 *   node tools/live_walk_channel.cjs --pid <PID> --case free
 *   node tools/live_walk_channel.cjs --pid <PID> --case box
 *   node tools/live_walk_channel.cjs --pid <PID> --case wall
 *   node tools/live_walk_channel.cjs --pid <PID> --case stairs --stairs x,y,z --dir north
 *
 * Casos:
 *   free   - 3 tiles em rota livre; um passo por tile, mesmo z, sem stuck.
 *   box    - waypoint `box` no tile de um monstro vivo a 2..12 tiles; precisa
 *            cumprir com `arrived-adjacent` (ou chegada exata) SEM `stuck`.
 *   wall   - dois pontos separados por parede no mapa OTMM; precisa chegar
 *            (o guloso puro nao contorna) e a rota precisa ter mais passos que
 *            a distancia em reta.
 *   stairs - waypoint `stairs` na posicao informada com direcao; precisa mudar
 *            de z e nao emitir mais de um walk.
 *
 * NAO prova: luring, combate, nem que o mapa do Shiba se comporta igual.
 * Evidencia: local-data/walk-channel-<stamp>.json (amostras por passo).
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const os = require('node:os');
const { EngineRuntime } = require(path.join(ROOT, 'reconstruction', 'engine-runtime.cjs'));
const { OtmmReader } = require(path.join(ROOT, 'reconstruction', 'otmm.cjs'));

const KEY_DIR = path.join(ROOT, 'captures');
const OUT_DIR = path.join(ROOT, 'local-data');
const DEFAULT_MAP = path.join(os.homedir(), 'AppData', 'Roaming', 'PokeAlliance', 'PokeAllianceV3', 'minimap854.otmm');

function arg(flag, fallback = null) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const pid = Number(arg('--pid', 0));
const testCase = String(arg('--case', 'free'));
const timeoutMs = Number(arg('--timeout-ms', 25000));
if (!Number.isInteger(pid) || pid <= 0) { console.error('faltou --pid'); process.exit(2); }

const keyFile = path.join(KEY_DIR, `channel-key-${pid}.json`);
if (!fs.existsSync(keyFile)) { console.error('sem chave em ' + keyFile); process.exit(2); }
const key = JSON.parse(fs.readFileSync(keyFile, 'utf8')).key;

const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
const evidenceFile = path.join(OUT_DIR, `walk-channel-${stamp}.json`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const DIRS = { north: 0, east: 1, south: 2, west: 3 };
const DELTA = { 0: [0, -1], 1: [1, 0], 2: [0, 1], 3: [-1, 0], 4: [0, -1], 5: [0, 1], 6: [0, 1], 7: [0, -1] };

const evidence = { generatedAt: new Date().toISOString(), pid, case: testCase, samples: [], result: null };

function finish(result) {
  evidence.result = result;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(evidenceFile, JSON.stringify(evidence, null, 1) + '\n');
  console.log(JSON.stringify({ ...result, evidence: evidenceFile }));
  process.exit(result.ok ? 0 : 1);
}

function mapFromDisk() {
  if (!fs.existsSync(DEFAULT_MAP)) return null;
  try { return new OtmmReader(DEFAULT_MAP); } catch { return null; }
}

function currentMap() {
  const mapPath = process.env.PKA_MAP_FILE;
  if (mapPath && fs.existsSync(mapPath)) { try { return new OtmmReader(mapPath); } catch { return null; } }
  return mapFromDisk();
}

function free(map, pos) {
  if (!map) return true;
  const tile = map.tile(pos);
  if (!tile) return true;
  if (!tile.seen) return true;
  return tile.walkable === true;
}

const step = (pos, dir) => {
  const [dx, dy] = DELTA[dir];
  return { x: pos.x + dx, y: pos.y + dy, z: pos.z };
};

function pickFreeAhead(pos) {
  for (const [name, dir] of Object.entries(DIRS)) {
    const a = step(pos, dir);
    const b = step(a, dir);
    const c = step(b, dir);
    if (free(currentMap(), a) && free(currentMap(), b) && free(currentMap(), c)) {
      return { dir, target: c };
    }
  }
  return null;
}

/* Parede a frente: acha cardinal com parede em 2..4 e livre alem dela. */
function pickAcrossWall(pos) {
  const map = currentMap();
  if (!map) return null;
  for (const [name, dir] of Object.entries(DIRS)) {
    for (let depth = 2; depth <= 4; depth += 1) {
      let cursor = pos;
      let blockedAt = null;
      for (let i = 1; i <= depth; i += 1) {
        cursor = step(cursor, dir);
        const tile = map.tile(cursor);
        if (tile && tile.seen && tile.walkable === false) { blockedAt = i; break; }
      }
      if (blockedAt === null) continue;
      const beyond = step(step(cursor, dir), dir);
      if (!free(map, beyond)) continue;
      return { dir, target: beyond, wallAt: cursor };
    }
  }
  return null;
}

function pickMonster(telemetry, player) {
  const list = (Array.isArray(telemetry?.creatures) ? telemetry.creatures : [])
    .filter(entry => entry && entry.type === 1 && entry.healthPercent > 0 && entry.pos)
    .map(entry => ({ entry, distance: Math.max(Math.abs(entry.pos.x - player.x), Math.abs(entry.pos.y - player.y)) }))
    .filter(item => item.distance >= 2 && item.distance <= 12)
    .sort((a, b) => a.distance - b.distance);
  return list.length ? list[0].entry.pos : null;
}

async function main() {
  const adapter = require(path.join(ROOT, 'reconstruction', 'native-adapter.cjs'));
  const map = currentMap();
  const runtime = new EngineRuntime({
    mapProvider: () => map,
    openAdapter: options => adapter.open(options),
    intervalMs: 50,
  });

  const baseConfig = {
    target: { maxDistance: 12, monsters: [], combo: { enabled: false } },
    healer: { healHpPercent: 0 },
    hoenn: { perfectLure: false, minWildsToEngage: 0, potionHpPercent: 0, useMedicine: false },
    walker: { loop: false, stepIntervalMs: 406, waypoints: [] },
    tools: {},
  };

  await runtime.connect(pid, baseConfig);
  let session = null;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    session = runtime.sessions[0];
    if (session && session.online && !session.stale && session.telemetry?.position) break;
    await sleep(100);
  }
  if (!session || !session.online || session.stale) {
    finish({ ok: false, reason: 'sem sessao online/fresca', online: Boolean(session?.online), stale: Boolean(session?.stale) });
  }
  const telemetry0 = session.telemetry;
  if (telemetry0.runtimeReady !== true) {
    finish({ ok: false, reason: 'runtimeReady=false (menu?)', position: telemetry0.position });
  }
  const start = { ...telemetry0.position };
  if (start.x === 0 && start.y === 0) finish({ ok: false, reason: 'posicao sentinela', position: start });

  let target = null;
  let waypointAction = 'walk';
  let stairs = null;

  if (testCase === 'free') {
    const pick = pickFreeAhead(start);
    if (!pick) finish({ ok: false, reason: 'sem corredor livre de 3 tiles' });
    target = pick.target;
  } else if (testCase === 'wall') {
    const pick = pickAcrossWall(start);
    if (!pick) finish({ ok: false, reason: 'nenhuma parede 2..4 tiles com passagem atras', map: Boolean(map) });
    target = pick.target;
    evidence.wallAt = pick.wallAt;
  } else if (testCase === 'box') {
    const monster = pickMonster(telemetry0, start);
    if (!monster) finish({ ok: false, reason: 'nenhum monstro vivo a 2..12 tiles' });
    target = monster;
    waypointAction = 'box';
  } else if (testCase === 'stairs') {
    const raw = String(arg('--stairs', ''));
    const dirName = String(arg('--dir', ''));
    const [x, y, z] = raw.split(',').map(Number);
    if (![x, y, z].every(Number.isInteger) || !Object.hasOwn(DIRS, dirName)) {
      finish({ ok: false, reason: 'use --stairs x,y,z --dir north|east|south|west' });
    }
    stairs = { x, y, z, dir: dirName };
    target = { x, y, z };
    waypointAction = 'stairs';
  } else {
    finish({ ok: false, reason: 'caso invalido' });
  }

  const config = structuredClone(baseConfig);
  config.walker.waypoints = [{ action: waypointAction, pos: target, param: stairs ? stairs.dir : '' }];
  const straight = Math.max(Math.abs(target.x - start.x), Math.abs(target.y - start.y));
  evidence.start = start;
  evidence.target = target;
  evidence.straightDistance = straight;

  await runtime.setModules('walker', true, pid, config);
  const startedAt = Date.now();
  let next = null;
  let frames = 0;
  const observed = new Set();

  while (Date.now() - startedAt < timeoutMs) {
    await sleep(100);
    const live = runtime.sessions[0];
    if (!live || !live.online) { evidence.samples.push({ t: Date.now() - startedAt, lost: true }); break; }
    const position = live.telemetry?.position;
    if (position) {
      const last = evidence.samples.at(-1);
      if (!last || last.x !== position.x || last.y !== position.y || last.z !== position.z) {
        evidence.samples.push({ t: Date.now() - startedAt, ...position });
      }
      frames += 1;
    }
    if (runtime.last?.reason) observed.add(runtime.last.reason);
    if (runtime.last?.walk?.reason) observed.add(runtime.last.walk.reason);
    if (position && Date.now() - startedAt > 600) {
      const dNow = Math.max(Math.abs(position.x - target.x), Math.abs(position.y - target.y));
      if (testCase === 'stairs' ? position.z !== start.z : dNow <= 1) { next = 'arrived'; break; }
    }
    const lastStatus = runtime.last?.status;
    if (lastStatus && lastStatus !== 'walking' && lastStatus !== 'consumable') { next = lastStatus; break; }
    if (runtime.last?.walk?.action === 'done') { next = 'done'; break; }
  }

  await runtime.pause().catch(() => {});
  await runtime.setModules('walker', false, pid, config).catch(() => {});
  const end = evidence.samples.at(-1) || start;
  const dz = end.z - start.z;
  const steps = evidence.samples.filter(sample => !sample.lost).length - 1;
  const distanceToTarget = Math.max(Math.abs(end.x - target.x), Math.abs(end.y - target.y));
  const reasons = [...observed];

  let ok = false;
  let reason = null;
  if (testCase === 'free') {
    /* `walk` tem margem de chegada de 1 tile depois de ter se aproximado
     * (`arrived-within-one-tile`); 1 tile de folga e' o contrato, nao falha. */
    ok = dz === 0 && distanceToTarget <= 1 && !reasons.includes('stuck') && steps >= straight - 1;
    reason = ok ? null : `delta final (${end.x - start.x},${end.y - start.y}) dz=${dz}; alvo a ${distanceToTarget}; stuck=${reasons.includes('stuck')}`;
  } else if (testCase === 'wall') {
    ok = dz === 0 && distanceToTarget <= 1 && steps > straight && !reasons.includes('stuck');
    reason = ok ? null : distanceToTarget <= 1 ? `chegou sem contornar (passos ${steps} <= reta ${straight})` : `nao chegou; alvo a ${distanceToTarget}`;
  } else if (testCase === 'box') {
    ok = distanceToTarget <= 1 && !reasons.includes('stuck');
    reason = ok ? null : `alvo a ${distanceToTarget}; stuck=${reasons.includes('stuck')}`;
  } else if (testCase === 'stairs') {
    ok = dz !== 0;
    reason = ok ? null : 'andar nao mudou (stairs-timeout?)';
  }

  await runtime.close().catch(() => {});
  finish({ ok, reason, steps, end, distanceToTarget, dz, lastStatus: next, reasons, durationMs: Date.now() - startedAt });
}

main().catch(error => finish({ ok: false, reason: 'erro: ' + error.message }));
