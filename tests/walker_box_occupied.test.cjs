'use strict';

/**
 * M02 - box/safespot com o TILE DO WAYPOINT ocupado.
 *
 * DEFEITO (medido em simulacao, 2026-11-17/18): `box` e `safespot` exigiam o
 * tile exato. Com uma criatura parada no tile do waypoint — situacao normal
 * numa hunt — o motor tentava entrar, falhava, contornava e ORBITAVA. A guarda
 * de progresso (M01, ORBIT_SAMPLES) encerrava em `stuck` apos 13 comandos
 * (~5,85 s na cadencia de 406 ms) e a rota AVANCAVA sem cumprir a box. Com
 * `loop: true` isso se repetia a cada volta.
 *
 * REGRA NOVA: `box`/`safespot` sao AREA. Se o tile do waypoint esta' ocupado
 * por criatura viva e o corpo ja' esta' a 1 tile (qualquer um dos 8 vizinhos),
 * o waypoint conta como cumprido (`arrived-adjacent`).
 *
 * DISCRIMINACAO: sem a regra o primeiro tick devolve `move` (e a rota orbiga
 * ate' `stuck`); com ela devolve `advance`.
 *
 * O que NAO e' provado: a geometria real da box do Shiba. A captura nao tem
 * selvagem (kind5 esconde type 1). Aqui a fonte de ocupacao e' a nossa
 * telemetria, nao a do fornecedor.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { createWalkerEngine } = require('../reconstruction/engines/walker-engine.cjs');

const DELTA = {
  0: [0, -1], 1: [1, 0], 2: [0, 1], 3: [-1, 0],
  4: [1, -1], 5: [1, 1], 6: [-1, 1], 7: [-1, -1],
};

function creature(id, type, pos, healthPercent = 100) {
  return { id, type, pos: { ...pos }, healthPercent, canAttack: type === 1, name: 'Mon' + id };
}

/* Mundo: posicao do corpo + criaturas fixas. O tile de destino nao e' fisico
 * aqui — quem bloqueia e' a criatura publicada na telemetria. */
function makeWorld(start, creatures = []) {
  const state = { pos: { ...start }, tick: 0 };
  return {
    get pos() { return { ...state.pos }; },
    sample() {
      return {
        position: { ...state.pos }, tick: state.tick, playerId: 1,
        creatures: creatures.map(entry => ({ ...entry, pos: { ...entry.pos } })),
      };
    },
    apply(direction) {
      state.tick += 1;
      const delta = DELTA[direction];
      if (!delta) return;
      const next = { x: state.pos.x + delta[0], y: state.pos.y + delta[1], z: state.pos.z };
      if (creatures.some(entry => entry.pos.x === next.x && entry.pos.y === next.y
          && entry.healthPercent > 0)) return;
      state.pos = next;
    },
  };
}

function firstTick({ action, waypoint, start, creatures }) {
  const engine = createWalkerEngine({
    walker: { loop: false, stepIntervalMs: 0, waypoints: [{ action, pos: waypoint }] },
  });
  const world = makeWorld(start, creatures);
  const events = [];
  const sink = { command: (name, parameter) => events.push([name, parameter]) };
  const result = engine.step(world.sample(), sink, 0);
  return { result, events };
}

/* ----------------------------------------------------------- o que fecha */

test('box com o tile ocupado e corpo vizinho conta como chegada', () => {
  const waypoint = { x: 102, y: 100, z: 7 };
  const { result, events } = firstTick({
    action: 'box', waypoint, start: { x: 101, y: 100, z: 7 },
    creatures: [creature(50, 1, waypoint)],
  });
  assert.equal(result.action, 'done', 'waypoint unico: cumpre e encerra');
  assert.equal(result.reason, 'arrived-adjacent');
  assert.equal(events.length, 0, 'nao pode gastar passo para entrar no tile ocupado');
});

test('safespot segue a mesma regra', () => {
  const waypoint = { x: 102, y: 100, z: 7 };
  const { result } = firstTick({
    action: 'safespot', waypoint, start: { x: 101, y: 100, z: 7 },
    creatures: [creature(50, 1, waypoint)],
  });
  assert.equal(result.reason, 'arrived-adjacent');
});

test('vizinho diagonal tambem vale (a box e area, nao cruz)', () => {
  const waypoint = { x: 102, y: 100, z: 7 };
  const { result } = firstTick({
    action: 'box', waypoint, start: { x: 101, y: 101, z: 7 },
    creatures: [creature(50, 1, waypoint)],
  });
  assert.equal(result.reason, 'arrived-adjacent');
});

test('o proprio Pokemon parado no tile tambem bloqueia (type 3)', () => {
  const waypoint = { x: 102, y: 100, z: 7 };
  const { result } = firstTick({
    action: 'box', waypoint, start: { x: 101, y: 100, z: 7 },
    creatures: [creature(7, 3, waypoint)],
  });
  assert.equal(result.reason, 'arrived-adjacent');
});

/* --------------------------------------------------- o que NAO pode mudar */

test('walk continua exigindo o tile exato mesmo com o tile ocupado', () => {
  const waypoint = { x: 102, y: 100, z: 7 };
  const { result, events } = firstTick({
    action: 'walk', waypoint, start: { x: 101, y: 100, z: 7 },
    creatures: [creature(50, 1, waypoint)],
  });
  assert.equal(result.action, 'move');
  assert.deepEqual(events[0], ['walk', 1], 'tenta entrar no tile ocupado');
});

test('corpo morto no tile nao conta como ocupacao', () => {
  const waypoint = { x: 102, y: 100, z: 7 };
  const { result, events } = firstTick({
    action: 'box', waypoint, start: { x: 101, y: 100, z: 7 },
    creatures: [creature(50, 1, waypoint, 0)],
  });
  assert.equal(result.action, 'move', 'deve andar para o tile livre');
  assert.deepEqual(events[0], ['walk', 1]);
});

test('monstro longe nao antecipa a chegada', () => {
  const waypoint = { x: 102, y: 100, z: 7 };
  const { result } = firstTick({
    action: 'box', waypoint, start: { x: 101, y: 100, z: 7 },
    creatures: [creature(50, 1, { x: 108, y: 100, z: 7 })],
  });
  assert.equal(result.action, 'move');
});

test('corpo a 2 tiles com o tile ocupado ainda anda (nao antecipa)', () => {
  const waypoint = { x: 102, y: 100, z: 7 };
  const { result } = firstTick({
    action: 'box', waypoint, start: { x: 100, y: 100, z: 7 },
    creatures: [creature(50, 1, waypoint)],
  });
  assert.equal(result.action, 'move');
});

test('sem lista de criaturas a regra nao se aplica', () => {
  const waypoint = { x: 102, y: 100, z: 7 };
  const { result } = firstTick({ action: 'box', waypoint, start: { x: 101, y: 100, z: 7 } });
  assert.equal(result.action, 'move');
});
