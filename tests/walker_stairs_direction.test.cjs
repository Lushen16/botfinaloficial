'use strict';

/**
 * Escada DIRECIONAL: `param` decide para onde pisar.
 *
 * DEFEITO: a UI oferece "No tile / Norte / Leste / Sul / Oeste" para o ponto
 * `stairs`, mas o motor ignorava `param` — só esperava o `z` mudar. Numa escada
 * que exige andar para o lado, a transição nunca vinha e o waypoint terminava em
 * `stairs-timeout`.
 *
 * REGRA: com direção, o motor despacha UM `walk` nessa direção ao chegar no
 * tile e espera o `z`; sem direção, só pisa no tile (buraco, rampa). O passo
 * não é repetido: `pendingStairs` segura os ticks seguintes.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { createWalkerEngine } = require('../reconstruction/engines/walker-engine.cjs');

const DIRS = { north: 0, east: 1, south: 2, west: 3 };

function setup(param) {
  const engine = createWalkerEngine({
    walker: { loop: false, stepIntervalMs: 0,
      waypoints: [{ action: 'stairs', pos: { x: 102, y: 100, z: 7 }, param }] },
  });
  const events = [];
  const sink = { command: (name, direction) => events.push([name, direction]) };
  const sample = (patch = {}) => ({ position: { x: 102, y: 100, z: 7 }, tick: 1, playerId: 1, ...patch });
  return { engine, sink, events, sample };
}

test('stairs com direcao despacha um walk para o lado', () => {
  const { engine, sink, events, sample } = setup('north');
  const result = engine.step(sample(), sink, 0);
  assert.equal(result.action, 'move');
  assert.equal(result.reason, 'stairs-stepping');
  assert.deepEqual(events, [['walk', DIRS.north]]);
});

test('o passo nao se repete enquanto espera o andar', () => {
  const { engine, sink, events, sample } = setup('east');
  engine.step(sample(), sink, 0);
  for (let now = 100; now < 4000; now += 100) {
    const held = engine.step(sample({ tick: now / 100 + 1 }), sink, now);
    assert.equal(held.action, 'hold');
    assert.equal(held.reason, 'stairs');
  }
  assert.equal(events.length, 1, 'um unico walk, mesmo com varios ticks');
});

test('z mudou depois do passo: avanca', () => {
  const { engine, sink, sample } = setup('south');
  engine.step(sample(), sink, 0);
  const done = engine.step(sample({ position: { x: 102, y: 101, z: 8 }, tick: 2 }), sink, 100);
  assert.equal(done.action, 'done');
  assert.equal(done.reason, 'stairs');
});

test('sem direcao continua so pisando no tile', () => {
  const { engine, sink, events, sample } = setup('');
  const result = engine.step(sample(), sink, 0);
  assert.equal(result.action, 'hold');
  assert.equal(result.reason, 'stairs');
  assert.deepEqual(events, []);
});

test('direcao invalida cai no modo No tile', () => {
  const { engine, sink, events, sample } = setup('diagonal');
  const result = engine.step(sample(), sink, 0);
  assert.equal(result.reason, 'stairs');
  assert.deepEqual(events, []);
});

test('sem transicao, o timeout continua valendo', () => {
  const { engine, sink, sample } = setup('west');
  engine.step(sample(), sink, 0);
  const timedOut = engine.step(sample({ tick: 2 }), sink, 5000);
  assert.equal(timedOut.reason, 'stairs-timeout');
});
