'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { executar } = require('../tools/walk-bench.cjs');

test('um comando aceito e descartado no mundo não conta como deslocamento', async () => {
  const r = await executar({ nome: 'descarte' });
  assert.equal(r.emitidos - r.aplicadosNoSimulador, 1);
  assert.equal(r.confirmadosPorPosicao, r.aplicadosNoSimulador);
  assert.equal(r.razaoDescarte, 1 / r.emitidos);
  assert.ok(r.chegadaExataMs !== null);
});

test('a posição de um teleporte não confirma o passo que o precedeu', async () => {
  const r = await executar({ nome: 'teleporte' });
  assert.ok(r.confirmadosPorPosicao < r.aplicadosNoSimulador);
  assert.equal(r.razaoDescarte, 0);
  assert.equal(r.eficiencia, null);
});

test('a trilha reproduz os mesmos bytes com humanização desligada', async () => {
  async function trilha() {
    const linhas = [];
    await executar({ nome: 'corredor', registrar: linha => linhas.push(JSON.stringify(linha)) });
    return linhas.join('\n');
  }
  assert.equal(await trilha(), await trilha());
});

test('os snapshots de captura são independentes das ordens hipotéticas do walker', async () => {
  const jogador = x => ({ id: 1, pos: { x, y: 100, z: 7 } });
  const captura = [{ t: 0, jogador: jogador(100) }, { t: 5000, jogador: null }, { t: 10000, jogador: jogador(110) }];
  const linhas = [];
  const r = await executar({ captura, registrar: linha => linhas.push(linha) });
  assert.equal(r.emitidos, 1);
  assert.equal(r.aplicadosNoSimulador, null);
  assert.equal(r.confirmadosPorPosicao, null);
  assert.equal(r.razaoDescarte, null);
  assert.ok(linhas.filter(linha => linha.actual === null).every(linha => linha.dir === null));
  assert.deepEqual(linhas.at(-1).actual, jogador(110).pos);
});

test('a escada muda de andar no simulador e preserva um só comando', async () => {
  const linhas = [];
  const r = await executar({ nome: 'escada', registrar: linha => linhas.push(linha) });
  assert.equal(r.emitidos, 1);
  assert.equal(linhas[0].actual.z, 7);
  assert.equal(linhas.at(-1).actual.z, 8);
  assert.ok(r.rotaConcluidaMs > r.chegadaExataMs);
});
