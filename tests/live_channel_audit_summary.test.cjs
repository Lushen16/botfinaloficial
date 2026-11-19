'use strict';

/**
 * Atribuicao do `target.kill` na auditoria ao vivo.
 *
 * O dano pode aparecer na amostra ANTERIOR ao ACK do nosso ataque (o Pokemon do
 * jogador bate primeiro). A atribuicao precisa ser retroativa: id atacado +
 * HP caido/sumido em qualquer ponto da janela = efeito.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeKill } = require('../reconstruction/app/live-channel-audit.cjs');

const sample = (at, creatures, emitted = []) => ({
  at, creatures: creatures.map(([id, hp]) => ({ id, hp })), emitted,
});

test('dano visto antes do ACK do ataque ainda conta como efeito', () => {
  const result = summarizeKill([
    sample('t0', [[5, 100]]),
    sample('t1', [[5, 100]], [['attack', 5]]),
    sample('t2', [[5, 50]]),
  ]);
  assert.equal(result.status, 'damaged');
  assert.equal(result.passed, true);
  assert.equal(result.damaged[0].attacked, true);
});

test('ataque sem dano em alvo nenhum continua sem efeito', () => {
  const result = summarizeKill([
    sample('t0', [[5, 100], [6, 100]]),
    sample('t1', [[5, 100], [6, 100]], [['attack', 5]]),
    sample('t2', [[5, 100], [6, 100]]),
  ]);
  assert.equal(result.status, 'attack-without-effect');
  assert.equal(result.passed, false);
});

test('alvo atacado que desaparece conta como morto', () => {
  const result = summarizeKill([
    sample('t0', [[5, 30]]),
    sample('t1', [[5, 30]], [['attack', 5]]),
    sample('t2', []),
  ]);
  assert.equal(result.status, 'killed');
  assert.equal(result.passed, true);
});
