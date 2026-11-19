'use strict';

/**
 * M01 - ORBITA em volta de waypoint com o tile ocupado.
 *
 * DEFEITO MEDIDO (simulacao com fisica de grade, 2026-11-17):
 * com um waypoint `box` a 2 tiles e o TILE DO WAYPOINT bloqueado (outra
 * criatura parada nele — situacao normal numa hunt), os vizinhos livres fazem o
 * motor tentar entrar, falhar e desviar. O corpo orbita para sempre:
 *
 *   ANTES: 300 comandos `walk`, 12 tiles unicos, deriva de ate' 3 tiles do
 *          waypoint, `stuck` NUNCA reportado. `attempts` zera a cada tile novo
 *          (`attempts = stuck ? attempts+1 : 0`), entao o contorno `clockwise`
 *          nunca escala para `stuck`.
 *   DEPOIS: `stuck` em ~13 comandos.
 *
 * A correcao e' a guarda de PROGRESSO (`ORBIT_SAMPLES`): conta amostras
 * consecutivas que nao aproximam do waypoint. Nao muda a politica de chegada
 * de nenhum dos seis tipos de waypoint.
 *
 * O que este arquivo NAO cobre: se o corpo realmente atravessa o tile ocupado
 * depende do jogo. A simulacao aplica fisica de GRADE (1 tile por comando,
 * obstaculo bloqueia) porque a fisica real nao e' observavel passivamente.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { createWalkerEngine, ORBIT_SAMPLES } = require('../reconstruction/engines/walker-engine.cjs');

/* Corpo simulado com fisica de grade. `blocked` sao tiles que ele nao entra. */
const DELTA = {
  0: [0, -1], 1: [1, 0], 2: [0, 1], 3: [-1, 0],
  4: [1, -1], 5: [1, 1], 6: [-1, 1], 7: [-1, -1],
};

function makeWorld(start, blockedTiles = []) {
  const state = { pos: { ...start }, tick: 0 };
  const blocked = new Set(blockedTiles);
  return {
    get pos() { return { ...state.pos }; },
    sample() { return { position: { ...state.pos }, tick: state.tick, playerId: 1 }; },
    /* O tick avanca SEMPRE: o jogo publica telemetria mesmo com o corpo preso. */
    apply(direction) {
      state.tick += 1;
      const delta = DELTA[direction];
      if (!delta) return false;
      const next = { x: state.pos.x + delta[0], y: state.pos.y + delta[1], z: state.pos.z };
      if (blocked.has(`${next.x},${next.y}`)) return false;
      state.pos = next;
      return true;
    },
    /* Transicao de andar (escada): muda z sem mover. */
    changeFloor(z) { state.pos = { ...state.pos, z }; state.tick += 1; },
  };
}

function drive({ waypoints, start, blocked, maxSteps = 400, stepIntervalMs = 0 }) {
  const engine = createWalkerEngine({ walker: { loop: false, stepIntervalMs, waypoints } });
  const world = makeWorld(start, blocked);
  const events = [];
  const sink = { command: (name, parameter) => events.push([name, parameter]) };
  let pending = null;
  let now = 0;
  for (let i = 0; i < maxSteps; i += 1) {
    if (pending !== null) { world.apply(pending); pending = null; }
    const result = engine.step(world.sample(), sink, now);
    if (result.action === 'move') pending = result.direction;
    if (result.action === 'done') return { done: true, reason: result.reason, steps: i, events };
    if (result.reason === 'stuck') return { done: true, reason: 'stuck', steps: i, events };
    now += 50;
  }
  return { done: false, steps: maxSteps, events };
}

/* --------------------------------------------------------------- regressao */

test('box com o tile ocupado termina em stuck em vez de orbitar para sempre', () => {
  const run = drive({
    waypoints: [{ action: 'box', pos: { x: 102, y: 100, z: 7 } }],
    start: { x: 100, y: 100, z: 7 },
    blocked: ['102,100'],
  });
  assert.equal(run.done, true, 'a rota precisa terminar');
  assert.equal(run.reason, 'stuck');
  /* 13 medido; folga para nao amar o numero exato, mas muito abaixo dos 300
   * que a versao anterior gastava sem nunca terminar. */
  assert.ok(run.events.length <= ORBIT_SAMPLES + 4,
    `terminou com ${run.events.length} comandos; esperado <= ${ORBIT_SAMPLES + 4}`);
});

test('safespot com o tile ocupado tambem termina em stuck', () => {
  const run = drive({
    waypoints: [{ action: 'safespot', pos: { x: 102, y: 100, z: 7 } }],
    start: { x: 100, y: 100, z: 7 },
    blocked: ['102,100'],
  });
  assert.equal(run.reason, 'stuck');
  assert.ok(run.events.length <= ORBIT_SAMPLES + 4);
});

test('alvo bloqueado longe do waypoint tambem termina em stuck', () => {
  const run = drive({
    waypoints: [{ action: 'box', pos: { x: 104, y: 100, z: 7 } }],
    start: { x: 100, y: 100, z: 7 },
    blocked: ['104,100'],
    maxSteps: 200,
  });
  assert.equal(run.reason, 'stuck');
});

/* ------------------------------------------------- o que NAO pode regredir */

test('caminho livre continua chegando e nao vira stuck', () => {
  const run = drive({
    waypoints: [{ action: 'walk', pos: { x: 105, y: 100, z: 7 } }],
    start: { x: 100, y: 100, z: 7 },
  });
  assert.equal(run.done, true);
  assert.notEqual(run.reason, 'stuck');
  assert.equal(run.events.length, 4, 'um comando por tile');
});

test('curva em L continua chegando', () => {
  const run = drive({
    waypoints: [{ action: 'walk', pos: { x: 103, y: 97, z: 7 } }],
    start: { x: 100, y: 100, z: 7 },
  });
  assert.notEqual(run.reason, 'stuck');
  assert.equal(run.done, true);
});

test('obstaculo simples no caminho ainda e contornado e chega', () => {
  /* Parede de 1 tile logo a frente; o alvo fica depois dela. O contorno
   * `clockwise` acha a volta e a rota termina em advance. */
  const run = drive({
    waypoints: [{ action: 'walk', pos: { x: 104, y: 100, z: 7 } }],
    start: { x: 100, y: 100, z: 7 },
    blocked: ['101,100'],
  });
  assert.equal(run.done, true);
  assert.notEqual(run.reason, 'stuck');
});

test('box alcancavel chega sem stuck', () => {
  const run = drive({
    waypoints: [{ action: 'box', pos: { x: 103, y: 100, z: 7 } }],
    start: { x: 100, y: 100, z: 7 },
  });
  assert.equal(run.done, true);
  assert.notEqual(run.reason, 'stuck');
});

test('a guarda de orbita nao dispara em rota longa e reta', () => {
  /* 20 tiles em linha reta: muitas amostras, mas cada passo melhora a distancia
   * ao waypoint. Se a guarda contasse amostras em vez de PROGRESSO, isto
   * falharia. */
  const run = drive({
    waypoints: [{ action: 'walk', pos: { x: 120, y: 100, z: 7 } }],
    start: { x: 100, y: 100, z: 7 },
    maxSteps: 100,
  });
  assert.notEqual(run.reason, 'stuck');
  assert.equal(run.done, true);
  assert.equal(run.events.length, 19);
});

/* ------------------------------------------------------------- reset() */

test('reset() descarta o historico da guarda de orbita', () => {
  /* Precisa de ORBITA REAL: um corpo parado e' pego pelo caminho antigo
   * (`attempts`/`stalls`), que nao usa a guarda, e o teste passaria mesmo sem
   * a limpeza. Aqui o corpo orbita em volta de um `box` com o tile ocupado.
   *
   * Propriedade: depois de `reset()`, a mesma instancia se comporta como nova.
   * Se `orbitSamples`/`bestRemaining` sobrevivessem, a pre-carga encurtaria a
   * segunda contagem.
   *
   * MEDIDO com pre-carga de 6 amostras de orbita:
   *   com limpeza no reset()   -> stuck em 26
   *   sem limpeza (mutacao)    -> stuck em 18
   */
  const blocked = ['102,100'];
  const makeEngine = () => createWalkerEngine({
    walker: { loop: false, stepIntervalMs: 0,
      waypoints: [{ action: 'box', pos: { x: 102, y: 100, z: 7 } }] },
  });

  /* Dirige com fisica de grade ate' travar ou gastar `limit` amostras. */
  const drive = (engine, limit) => {
    const world = makeWorld({ x: 100, y: 100, z: 7 }, blocked);
    const sink = { command: () => {} };
    let pending = null;
    let now = 0;
    for (let i = 0; i < 400; i += 1) {
      if (pending !== null) { world.apply(pending); pending = null; }
      const result = engine.step(world.sample(), sink, now);
      if (result.action === 'move') pending = result.direction;
      if (result.reason === 'stuck') return { stuck: i + 1 };
      if (limit && i + 1 >= limit) return { stopped: i + 1 };
      now += 50;
    }
    return { never: true };
  };

  /* Referencia: instancia nova, sem pre-carga. */
  const baseline = drive(makeEngine(), 0);
  assert.ok(Number.isInteger(baseline.stuck), 'a orbita precisa terminar em stuck');

  /* Instancia que ORBITOU antes, depois reset. */
  const engine = makeEngine();
  const preload = drive(engine, 6);
  assert.equal(preload.stopped, 6, 'a pre-carga para antes de travar');
  engine.reset();
  const after = drive(engine, 0);

  assert.equal(after.stuck, baseline.stuck,
    'reset() nao pode deixar historico: a contagem precisa igualar a instancia nova');
});

test('reset() tambem descarta a melhor distancia ao waypoint', () => {
  /* `bestRemaining` herdado e' pior que `orbitSamples` herdado: se a rota
   * anterior chegou a 1 tile, a nova (que comeca a 4) nunca "melhora" e trava
   * imediatamente. */
  const engine = createWalkerEngine({
    walker: { loop: false, stepIntervalMs: 0,
      waypoints: [{ action: 'box', pos: { x: 101, y: 100, z: 7 } }] },
  });
  const sink = { command: () => {} };
  /* Chega pertinho: bestRemaining = 0. */
  engine.step({ position: { x: 101, y: 100, z: 7 }, tick: 1, playerId: 1 }, sink, 0);
  engine.reset();

  /* Agora o corpo esta' a 4 tiles do mesmo waypoint. Com o cache limpo a
   * primeira amostra estabelece 4 como referencia e nao trava. */
  const first = engine.step({ position: { x: 105, y: 100, z: 7 }, tick: 1, playerId: 1 }, sink, 0);
  assert.notEqual(first.reason, 'stuck');
  assert.equal(first.action, 'move');
});

/* -------------------------------------- transicao de andar: dois desfechos */

test('transicao de andar CONFIRMADA quando o z muda depois da chegada', () => {
  /* Ordem importa: o motor grava `fromZ` na amostra em que ve a chegada ao
   * tile da escada. So' DEPOIS disso o jogo troca de andar. Trocar antes faz o
   * motor gravar o andar destino como origem e esperar uma mudanca que nunca
   * vem — foi um falso `stairs-timeout` no harness de comparacao. */
  const engine = createWalkerEngine({ walker: { loop: false, stepIntervalMs: 0,
    waypoints: [{ action: 'stairs', pos: { x: 102, y: 100, z: 7 } }] } });
  const world = makeWorld({ x: 100, y: 100, z: 7 }, []);
  const events = [];
  const sink = { command: (name, parameter) => events.push([name, parameter]) };
  let pending = null;
  let now = 0;
  let arrived = false;
  for (let i = 0; i < 200; i += 1) {
    if (pending !== null) { world.apply(pending); pending = null; }
    const result = engine.step(world.sample(), sink, now);
    if (result.action === 'move') pending = result.direction;
    if (!arrived && result.reason === 'stairs') { arrived = true; world.changeFloor(8); }
    if (result.action === 'done') {
      assert.equal(result.reason, 'stairs', 'transicao confirmada, nao timeout');
      assert.equal(world.pos.z, 8);
      return;
    }
    now += 50;
  }
  assert.fail('a rota nunca concluiu a transicao');
});

test('stairs-TIMEOUT quando o z nao muda', () => {
  const engine = createWalkerEngine({ walker: { loop: false, stepIntervalMs: 0,
    waypoints: [{ action: 'stairs', pos: { x: 102, y: 100, z: 7 } }] } });
  const world = makeWorld({ x: 100, y: 100, z: 7 }, []);
  const events = [];
  const sink = { command: (name, parameter) => events.push([name, parameter]) };
  let pending = null;
  let now = 0;
  for (let i = 0; i < 300; i += 1) {
    if (pending !== null) { world.apply(pending); pending = null; }
    const result = engine.step(world.sample(), sink, now);
    if (result.action === 'move') pending = result.direction;
    if (result.action === 'done') {
      assert.equal(result.reason, 'stairs-timeout');
      assert.equal(world.pos.z, 7, 'nunca trocou de andar');
      assert.ok(now >= 5000, 'respeitou STAIRS_TIMEOUT_MS');
      return;
    }
    now += 50;
  }
  assert.fail('a rota nunca concluiu');
});

test('a margem de um tile continua valendo para walk (nao foi ampliada)', () => {
  /* O box com tile ocupado NAO ganhou tolerancia: continua exigindo o tile. A
   * correcao foi a guarda de progresso, nao a margem. */
  const walk = drive({
    waypoints: [{ action: 'walk', pos: { x: 102, y: 100, z: 7 } }],
    start: { x: 100, y: 100, z: 7 },
    blocked: ['102,100'],
    maxSteps: 200,
  });
  const box = drive({
    waypoints: [{ action: 'box', pos: { x: 102, y: 100, z: 7 } }],
    start: { x: 100, y: 100, z: 7 },
    blocked: ['102,100'],
    maxSteps: 200,
  });
  assert.notEqual(walk.reason, 'stuck', 'walk a 1 tile continua concluindo');
  assert.equal(box.reason, 'stuck', 'box com tile ocupado continua travando');
});