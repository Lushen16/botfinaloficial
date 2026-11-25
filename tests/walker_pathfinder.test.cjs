'use strict';

/**
 * M03 - pathfinding OTMM.
 *
 * O walker era guloso com contorno `clockwise`: travava em parede/corredor.
 * Aqui o planejador usa o mapa (tiles `walkable`) para escolher o passo.
 *
 * Cobre: desvio de parede, quina sem corte, bloco desconhecido passa,
 * alvo bloqueado preserva o destino, sem mapa cai no guloso, e uma parede longa
 * nao dispara a guarda de orbita (metrica e' custo de CAMINHO).
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { encodeOtmm, OtmmReader, BLOCK_SIZE } = require('../reconstruction/otmm.cjs');
const { createPathPlanner } = require('../reconstruction/pathfinder.cjs');
const { createWalkerEngine } = require('../reconstruction/engines/walker-engine.cjs');

const FREE = 1;      // seen + walkable
const WALL = 1 | 2;  // seen + bloqueado

function makeMap(walls = []) {
  const blocked = new Set(walls);
  const tiles = [];
  for (let y = 0; y < BLOCK_SIZE; y += 1) {
    for (let x = 0; x < BLOCK_SIZE; x += 1) {
      tiles.push(blocked.has(x + ',' + y) ? [WALL, 0, 0] : [FREE, 0, 100]);
    }
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otmm-'));
  const file = path.join(dir, 'teste.otmm');
  fs.writeFileSync(file, encodeOtmm([{ x: 0, y: 0, z: 0, tiles }]));
  const reader = new OtmmReader(file);
  return { reader, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const pos = (x, y) => ({ x, y, z: 0 });

test('suaviza a reta conhecida sem mudar o custo nem cortar quina', () => {
  const free = { seen: true, walkable: true };
  const from = pos(10, 10), to = pos(16, 14);
  assert.deepEqual(plannerFor({ tile: () => free }).plan(from, to), { direction: 5, remaining: 62 });
  for (const obstacle of [{ seen: true, walkable: false }, { seen: false }]) {
    const map = { tile: point => point.x === 10 && point.y === 11 ? obstacle : free };
    assert.notEqual(plannerFor(map).plan(from, to).direction, 5);
  }
});

test('suavizacao nao atravessa parede: corredor em L chega sem tile bloqueado', () => {
  const free = { seen: true, walkable: true };
  const wall = { seen: true, walkable: false };
  const walls = new Set();
  for (let y = 0; y <= 9; y += 1) walls.add(`13,${y}`);
  const map = { tile: point => (walls.has(`${point.x},${point.y}`) ? wall : free) };
  const planner = plannerFor(map);
  const delta = { 0: [0, -1], 1: [1, 0], 2: [0, 1], 3: [-1, 0],
    4: [1, -1], 5: [1, 1], 6: [-1, 1], 7: [-1, -1] };
  let position = { x: 10, y: 5, z: 0 };
  const goal = { x: 16, y: 5, z: 0 };
  let steps = 0;
  while ((position.x !== goal.x || position.y !== goal.y) && steps < 40) {
    const plan = planner.plan(position, goal);
    assert.ok(plan && Number.isInteger(plan.direction), 'plano ausente em ' + steps);
    const [dx, dy] = delta[plan.direction];
    position = { x: position.x + dx, y: position.y + dy, z: 0 };
    assert.ok(map.tile(position).walkable, 'passo bloqueado em ' + JSON.stringify(position));
    steps += 1;
  }
  assert.deepEqual(position, goal);
  assert.ok(steps <= 16, 'caminho longo demais: ' + steps);
});

test('suavizacao nao corta quina entre dois tiles bloqueados', () => {
  const free = { seen: true, walkable: true };
  const wall = { seen: true, walkable: false };
  const map = { tile: point => ((point.x === 11 && point.y === 10) || (point.x === 10 && point.y === 11)
    ? wall : free) };
  const plan = plannerFor(map).plan(pos(10, 10), pos(12, 12));
  assert.ok(plan && Number.isInteger(plan.direction));
  assert.notEqual(plan.direction, 5, 'nao pode sair na diagonal que corta a quina');
});

function plannerFor(map) {
  return createPathPlanner({ getMap: () => map, now: () => 0, cacheMs: 0 });
}

test('only distinct stalled samples trigger a detour, with and without a map', () => {
  for (const mapped of [true, false]) {
    const planner = mapped ? plannerFor({ tile: () => ({ seen: true, walkable: true }) }) : null;
    const engine = createWalkerEngine({ walker: { loop: false, stepIntervalMs: 0,
      waypoints: [{ action: 'walk', pos: pos(20,10) }] } }, { stepPlanner: planner });
    const step = tick => engine.step({ position: pos(10,10), tick }, { command() {} }, tick * 100);
    const first = step(1);
    for (const tick of [2,2,2,3,2]) assert.equal(step(tick).action, 'hold');
    const detour = step(4);
    assert.equal(detour.reason, mapped ? 'obstacle-replanned' : 'obstacle-detour');
    assert.notEqual(detour.direction, first.direction);
  }
});

test('enclosed dead end has no route, including diagonally across its corners', () => {
  const planner = plannerFor({ tile: ({ x, y }) => ({ seen: true, walkable: Math.abs(x-10) + Math.abs(y-10) !== 1 }) });
  assert.equal(planner.plan(pos(10,10),pos(20,10)), null);
});

test('with a map an unreachable goal does not trigger a greedy step into a dead end', () => {
  const planner = plannerFor({ tile: ({ x, y }) => ({ seen: true, walkable: y === 10 && [10,11,15].includes(x) }) });
  const engine = createWalkerEngine({ walker: { waypoints: [{ action: 'walk', pos: pos(15,10) }] } }, { stepPlanner: planner });
  assert.equal(engine.step({ position: pos(10,10), tick: 1 }, { command: assert.fail }, 0).reason, 'map-blocked');
});

/* Segue o plano ate' chegar, como o walker faria. */
function walkPlan(planner, from, goal, limit = 80) {
  const world = { ...from };
  const dirs = [];
  for (let i = 0; i < limit; i += 1) {
    if (world.x === goal.x && world.y === goal.y) return { reached: true, dirs };
    const planned = planner.plan(world, goal);
    if (!planned) return { reached: false, dirs, reason: 'sem-plano' };
    dirs.push(planned.direction);
    const [dx, dy] = { 0: [0, -1], 1: [1, 0], 2: [0, 1], 3: [-1, 0], 4: [1, -1], 5: [1, 1], 6: [-1, 1], 7: [-1, -1] }[planned.direction];
    world.x += dx;
    world.y += dy;
  }
  return { reached: false, dirs, reason: 'limite' };
}

test('contorna parede no caminho e chega', () => {
  const map = makeMap(['12,10']);
  try {
    const planner = plannerFor(map.reader);
    const run = walkPlan(planner, pos(10, 10), pos(14, 10));
    assert.equal(run.reached, true, run.reason);
    assert.ok(!(run.dirs[0] === 1 && run.dirs[1] === 1 && run.dirs[2] === 1),
      'nao pode insistir reto contra a parede');
  } finally { map.cleanup(); }
});

test('nao corta quina: com os dois ortogonais bloqueados usa cardinal', () => {
  const map = makeMap(['11,10', '10,11']);
  try {
    const planner = plannerFor(map.reader);
    const planned = planner.plan(pos(10, 10), pos(11, 11));
    assert.ok(planned);
    assert.ok([0, 1, 2, 3].includes(planned.direction), 'passo diagonal cortaria a quina');
  } finally { map.cleanup(); }
});

test('diagonal livre continua permitida', () => {
  const map = makeMap([]);
  try {
    const planned = plannerFor(map.reader).plan(pos(10, 10), pos(11, 11));
    assert.equal(planned.direction, 5);
  } finally { map.cleanup(); }
});

test('bloco desconhecido e passavel', () => {
  const map = makeMap([]);
  try {
    const planned = plannerFor(map.reader).plan(pos(60, 10), pos(70, 10));
    assert.ok(planned, 'saida do bloco conhecido nao pode virar parede');
    assert.equal(planned.direction, 1);
  } finally { map.cleanup(); }
});

test('alvo em cima de parede nao tem plano e nao recebe um passo na parede', () => {
  const map = makeMap(['14,10']);
  try {
    const planner = plannerFor(map.reader);
    const engine = createWalkerEngine({
      walker: { loop: false, waypoints: [{ action: 'box', pos: pos(14, 10) }] },
    }, { stepPlanner: planner });
    assert.equal(planner.plan(pos(13, 10), pos(14, 10)), null);
    const result = engine.step({ position: pos(13, 10), tick: 1 }, { command: assert.fail }, 0);
    assert.equal(result.reason, 'map-blocked');
  } finally { map.cleanup(); }
});

test('parede longa nao dispara stuck: remaining e caminho, nao reta', () => {
  const walls = [];
  for (let y = 4; y <= 16; y += 1) walls.push('12,' + y);
  const map = makeMap(walls);
  try {
    const planner = createPathPlanner({ getMap: () => map.reader, cardinalOnly: true });
    const engine = createWalkerEngine({
      walker: { loop: false, stepIntervalMs: 0, smartWalking: true,
        waypoints: [{ action: 'walk', pos: pos(14, 10) }] },
    }, { stepPlanner: planner });
    const world = { ...pos(10, 10) };
    let pending = null;
    const sink = { command: () => {} };
    for (let i = 0; i < 120; i += 1) {
      if (pending !== null) {
        const [dx, dy] = { 0: [0, -1], 1: [1, 0], 2: [0, 1], 3: [-1, 0], 4: [1, -1], 5: [1, 1], 6: [-1, 1], 7: [-1, -1] }[pending];
        world.x += dx; world.y += dy; pending = null;
        assert.equal(map.reader.tile(world)?.walkable, true);
      }
      const result = engine.step({ position: { ...world }, tick: i + 1, playerId: 1 }, sink, i * 50);
      if (result.action === 'move') {
        assert.ok(result.direction < 4, 'teclado aceita só direções cardinais');
        pending = result.direction;
      }
      if (result.action === 'done') {
        assert.ok(['arrived', 'arrived-within-one-tile'].includes(result.reason));
        return;
      }
      assert.notEqual(result.reason, 'stuck');
    }
    assert.fail('nao chegou antes do limite');
  } finally { map.cleanup(); }
});

test('sem mapa o planejador devolve null e o walker segue guloso', () => {
  const planner = createPathPlanner({ getMap: () => null });
  assert.equal(planner.plan(pos(10, 10), pos(14, 10)), null);
  const engine = createWalkerEngine({
    walker: { loop: false, stepIntervalMs: 0, waypoints: [{ action: 'walk', pos: pos(14, 10) }] },
  }, { stepPlanner: planner });
  const result = engine.step({ position: pos(10, 10), tick: 1, playerId: 1 }, { command: () => {} }, 0);
  assert.equal(result.action, 'move');
});

test('andar diferente devolve null', () => {
  const map = makeMap([]);
  try {
    assert.equal(plannerFor(map.reader).plan(pos(10, 10), { x: 10, y: 10, z: 1 }), null);
  } finally { map.cleanup(); }
});

test('o passo pendente aponta o tile da direcao planejada', () => {
  const map = makeMap([]);
  try {
    const engine = createWalkerEngine({
      walker: { loop: false, stepIntervalMs: 0, smartWalking: false,
        waypoints: [{ action: 'walk', pos: pos(11, 11) }] },
    }, { stepPlanner: plannerFor(map.reader) });
    const result = engine.step({ position: pos(10, 10), tick: 1, playerId: 1 }, { command: () => {} }, 0);
    assert.equal(result.action, 'move');
    const pending = engine.state.pendingStep;
    assert.deepEqual(pending.target, pos(11, 11));
  } finally { map.cleanup(); }
});
