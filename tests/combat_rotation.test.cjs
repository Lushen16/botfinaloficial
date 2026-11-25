'use strict';

/**
 * Rotação de alvo quando o ataque entregue NAO produz dano.
 *
 * O ataque pode ser recusado em silêncio pelo jogo quando a criatura ja' e' o
 * alvo atual (`[rt+0x2548]`, rc==4). O motor arma uma observacao por ataque;
 * sem queda de HP depois da janela, o alvo vai para `deferredTargets` e a
 * escolha passa para outro. Deferimento expira para o alvo poder voltar.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTargetEngine } = require('../reconstruction/engines/target-engine.cjs');
const { createRecorder } = require('../reconstruction/automation.cjs');

function telemetry({ tick = 1, aHp = 100, bHp = 100 } = {}) {
  return {
    position: { x: 100, y: 100, z: 7 }, playerName: 'Player', healthPercent: 100,
    pokemonName: 'Dugtrio', activeSlot: 1, roster: [], tick, playerId: 9,
    creatures: [
      { id: 1, name: 'Magnemite', pos: { x: 101, y: 100, z: 7 }, healthPercent: aHp, canAttack: true },
      { id: 2, name: 'Magnemite', pos: { x: 102, y: 100, z: 7 }, healthPercent: bHp, canAttack: true },
    ],
  };
}

function engine() {
  return createTargetEngine({
    target: { monsters: ['*'], maxDistance: 5, combo: { enabled: false } },
  });
}

function attacks(recorder) {
  return recorder.events.filter(event => event.name === 'attack').map(event => event.parameter);
}

test('sem dano na janela, o proximo ataque vai para outro alvo', () => {
  const target = engine();
  const recorder = createRecorder();
  let t = telemetry({ tick: 1 });

  const first = target.step(t, recorder, 0);
  assert.deepEqual(attacks(recorder), [1], 'primeiro ataque no mais proximo');
  target.recordDispatch('attack', 1, 0);
  target.recordAttackDelivery(1, t, 0);
  void first;

  for (const [now, tick] of [[500, 2], [1000, 3], [1500, 4]]) {
    t = telemetry({ tick });
    target.step(t, recorder, now);
  }
  t = telemetry({ tick: 5 });
  const rotated = target.step(t, recorder, 2000);
  assert.equal(rotated.targetId, 2, 'alvo deferido sai da escolha');
  assert.equal(attacks(recorder).at(-1), 2);
});

test('dano no alvo mantem o alvo', () => {
  const target = engine();
  const recorder = createRecorder();
  const t0 = telemetry({ tick: 1 });
  target.step(t0, recorder, 0);
  target.recordDispatch('attack', 1, 0);
  target.recordAttackDelivery(1, t0, 0);
  assert.equal(target.state.effectVerified, false);
  target.step(telemetry({ tick: 2, aHp: 80 }), recorder, 500);
  assert.equal(target.state.effectVerified, true);
  const kept = target.step(telemetry({ tick: 3, aHp: 80 }), recorder, 2500);
  assert.equal(kept.targetId, 1);
  assert.ok(attacks(recorder).every(id => id === 1));
});

test('observed target carries its tile; three unconfirmed requests then cooldown', () => {
  const target = engine();
  const sink = createRecorder();
  const frame = tick => ({ ...telemetry({ tick, bHp: 0 }), creaturesAvailable: true });
  for (let tick = 1; tick <= 3; tick++) target.step(frame(tick), sink, tick * 1000);
  assert.equal(attacks(sink).length, 3);
  assert.deepEqual(sink.events[0].extra.pos, frame(1).creatures[0].pos);
  assert.equal(target.step(frame(4), sink, 4000).effectVerified, false);
  assert.equal(target.step(frame(5), sink, 5000).reason, 'target-cooldown');
  assert.equal(attacks(sink).length, 3);
  target.step(frame(6), sink, 8000);
  assert.equal(attacks(sink).length, 4);
});

test('o deferimento expira e o alvo volta a ser escolhido', () => {
  const target = engine();
  const recorder = createRecorder();
  const t0 = telemetry({ tick: 1 });
  target.step(t0, recorder, 0);
  target.recordDispatch('attack', 1, 0);
  target.recordAttackDelivery(1, t0, 0);
  for (const [now, tick] of [[500, 2], [1000, 3], [1500, 4], [2000, 5]]) {
    target.step(telemetry({ tick }), recorder, now);
  }
  // B morto, A deferido ate' 6000; em 6000 A volta.
  const back = target.step(telemetry({ tick: 6, bHp: 0 }), recorder, 6001);
  assert.equal(back.targetId, 1);
});
