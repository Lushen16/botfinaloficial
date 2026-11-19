'use strict';

const { sameTile, samePlane, planeDistance, direction, isPosition } = require('./shared.cjs');

const ACTIONS = Object.freeze(['walk', 'safespot', 'box', 'stairs', 'wait', 'say']);
const STAIRS_TIMEOUT_MS = 5000;
const STUCK_LIMIT = 3;
const STALL_LIMIT = 6;
/**
 * Quanto esperar por uma amostra que confirme o passo antes de considerar
 * que ele nao aconteceu. Sem isso o motor ficaria em `hold` para sempre se o
 * personagem estivesse preso numa parede.
 *
 * 2500 ms e' o mesmo valor do motor de referencia
 * (`botfinal/engines/walker-engine.cjs: DEFAULT_PROGRESS_TIMEOUT_MS`).
 */
const PROGRESS_TIMEOUT_MS = 2500;

/**
 * Queda de `tick` que caracteriza REINICIO da telemetria, nao uma amostra
 * apenas fora de ordem.
 *
 * POR QUE: a guarda de ordenacao so' aceita tick ESTRITAMENTE maior. Se o
 * cliente reiniciar (reconexao, reinjecao da DLL, troca de personagem), o
 * contador volta para perto de zero e TODA amostra nova fica abaixo do
 * `sampleTick` do passo pendente. Sem tratar isso a rota passa a andar no
 * ritmo do prazo — um passo a cada 2500 ms — ate' o fim da rota.
 *
 * Um salto de volta de 1000+ ticks nao acontece por reordenacao de rede; o
 * que acontece e' 1 a 3 ticks para tras.
 */
const TICK_RESET_MIN = 1000;

/**
 * Intervalo entre passos de caminhada, medido no cliente real.
 *
 * MEDIDO 2026-11-15, tap passivo (`native/pka_tap_572.jsonl`) com o Shiba
 * andando: 7 mudancas de tile, intervalos 407, 406, 406, 203, 407 ms —
 * mediana 406 ms por tile (~2,46 tiles/s). O renderer do Shiba consulta a
 * posicao a cada ~203 ms (mediana), ou seja, DUAS leituras por passo; o 203
 * da lista e' artefato de amostragem (duas leituras caindo dos lados da
 * mudanca), nao um passo rapido. Ferramenta: `tools/tap_walk_cadence.cjs`.
 *
 * POR QUE PACEAR: o motor e' chamado a cada 50 ms (canal nativo) e a cada
 * 100 ms com piso de 250 ms (teclado/RPM). Sem piso proprio, a rota despacha
 * mais rapido do que o jogo processa e a posicao confirmada vira amostra
 * repetida — o personagem anda aos trancos e a fila de teclas cresce. Com o
 * piso no valor medido, o passo sai no mesmo ritmo da referencia.
 *
 * Ajustavel por `walker.stepIntervalMs` (0 desliga o piso).
 */
const STEP_INTERVAL_MS = 406;
const STEP_INTERVAL_MAX_MS = 2000;

/**
 * Amostras consecutivas SEM melhorar a distancia ao waypoint antes de declarar
 * a rota travada.
 *
 * POR QUE (M01, medido em simulacao): `attempts` zera sempre que o corpo muda
 * de tile (`state.attempts = stuck ? attempts+1 : 0`). Quando o TILE do
 * waypoint esta' ocupado por outra criatura mas os vizinhos estao livres, o
 * contorno `clockwise` faz o corpo ORBITAR: cada passo cai num tile novo, ou
 * seja, `stuck` nunca fica verdadeiro, `attempts` nunca acumula e `stuck` nunca
 * dispara. Medido com `box` a 2 tiles e (102,100) bloqueado:
 *
 *   300 comandos, 12 tiles unicos distintos, deriva de ate' 3 tiles do waypoint,
 *   `stuck` NUNCA reportado.
 *
 * A guarda correta e' de PROGRESSO, nao de tile repetido: conta amostras
 * consecutivas que nao aproximam do waypoint.
 *
 * O TEMPO ATE' O `stuck` DEPENDE DO PISO DE CADENCIA, porque a guarda e'
 * avaliada DEPOIS dele (uma amostra que cai em `cadence` nao chega ao contador).
 * Medido com `box` a 2 tiles e (102,100) bloqueado:
 *
 *   stepIntervalMs: 0    -> stuck em 1250 ms (~25 amostras de 50 ms, 13 comandos)
 *   stepIntervalMs: 406  -> stuck em 5850 ms (13 comandos, ~406 ms por passo)
 *
 * O numero util e' o de PASSOS, nao o de milissegundos: 13 comandos em ambos.
 * A versao anterior deste comentario dizia "12 amostras ~ 600 ms", que era
 * falso por ~10x no regime padrao (o piso de 406 ms domina o tempo).
 */
const ORBIT_SAMPLES = 12;

function clockwise(directionId) {
  return directionId <= 3 ? (directionId + 1) % 4 : 4 + (directionId - 4 + 1) % 4;
}

/* Direcao de saída de um waypoint `stairs` (`param`). Vazio = só pisar no tile
 * (buraco, rampa). O `param` do Shiba é a direção para usar a escada; antes ele
 * era ignorado e o motor só esperava o `z` mudar — escada direcional falhava. */
const STAIR_DIRECTIONS = Object.freeze({ north: 0, east: 1, south: 2, west: 3 });

function stairDirection(param) {
  const key = String(param ?? '').trim().toLowerCase();
  return Object.hasOwn(STAIR_DIRECTIONS, key) ? STAIR_DIRECTIONS[key] : null;
}

/* Direcao -> delta de tile, no vocabulario do protocolo (mesmo de shared). */
const STEP_DELTA = Object.freeze({
  0: [0, -1], 1: [1, 0], 2: [0, 1], 3: [-1, 0],
  4: [1, -1], 5: [1, 1], 6: [-1, 1], 7: [-1, -1],
});

/**
 * O tile do waypoint esta' ocupado por outra criatura viva?
 *
 * `box` e `safespot` sao AREA, nao tile exato (ver ARRIVAL_TOLERANCE_ACTIONS).
 * Um monstro parado no tile exato e' o caso normal numa hunt; sem esta leitura
 * a unica saida era orbitar ate' o `stuck`.
 *
 * A fonte e' a telemetria: qualquer criatura com posicao no tile, viva
 * (`healthPercent > 0`) e que nao seja o proprio jogador. Corpo morto
 * (`healthPercent === 0`) nao bloqueia; criatura sem o campo conta como viva.
 * Sem lista de criaturas a regra nao se aplica e o motor segue exigindo o tile.
 */
function tileOccupied(telemetry, pos) {
  const creatures = Array.isArray(telemetry?.creatures) ? telemetry.creatures : [];
  return creatures.some(entry => entry && entry.id !== telemetry.playerId
    && Number(entry.healthPercent) !== 0 && samePlane(entry.pos, pos));
}

/* Acoes cujo tile e' area: chegada vale no vizinho quando o tile esta' ocupado. */
const ARRIVAL_TOLERANCE_ACTIONS = Object.freeze(['box', 'safespot']);

function normalizeWaypoint(waypoint) {
  if (!waypoint || typeof waypoint !== 'object') throw new Error('Waypoint invalido.');
  if (!ACTIONS.includes(waypoint.action)) throw new Error('Acao do waypoint invalida.');
  if (!isPosition(waypoint.pos)) throw new Error('Posicao do waypoint invalida.');
  return {
    action: waypoint.action,
    pos: { x: waypoint.pos.x, y: waypoint.pos.y, z: waypoint.pos.z },
    param: waypoint.param === undefined || waypoint.param === null ? '' : waypoint.param,
    stairCheckMonsters: waypoint.stairCheckMonsters === true,
  };
}

function createWalkerEngine(config, options = {}) {
  const walker = config?.walker || {};
  /* Planejador opcional (ver reconstruction/pathfinder.cjs). Sem ele, ou sem
   * resposta, o motor mantem o passo guloso de sempre. */
  const planner = options && typeof options.stepPlanner?.plan === 'function'
    ? options.stepPlanner : null;
  const waypoints = (Array.isArray(walker.waypoints) ? walker.waypoints : []).map(normalizeWaypoint);
  const loop = walker.loop !== false;
  const smart = walker.smartWalking === true;
  const startNearest = walker.startNearestWaypoint === true;
  /* Piso de cadencia: `null`/ausente = valor medido; 0 = sem piso. */
  const stepIntervalMs = Number.isFinite(Number(walker.stepIntervalMs))
    ? Math.min(STEP_INTERVAL_MAX_MS, Math.max(0, Number(walker.stepIntervalMs)))
    : STEP_INTERVAL_MS;
  const state = { index: 0, waitingUntil: 0, lastPosition: null, lastMoveTick: null, attempts: 0, stalls: 0,
    pendingStairs: null, saidIndex: -1, finished: false, started: false, approachFrom: null,
    pendingStep: null, wasSkipped: false, tickSeq: 0, lastDispatchAt: -Infinity,
    /* Guarda de orbita (ver ORBIT_SAMPLES): melhor distancia ja' vista ao
     * waypoint atual e quantas amostras seguidas nao melhoraram. */
    bestRemaining: null, orbitSamples: 0, usingPlan: false };

  function nearestIndex(position) {
    let best = 0;
    let bestDistance = Infinity;
    for (let index = 0; index < waypoints.length; index += 1) {
      const current = planeDistance(position, waypoints[index].pos);
      if (current < bestDistance) { bestDistance = current; best = index; }
    }
    return best;
  }

  function advance() {
    state.waitingUntil = 0;
    state.saidIndex = -1;
    state.attempts = 0;
    state.stalls = 0;
    state.approachFrom = null;
    state.pendingStep = null;
    /* Zera a guarda de orbita: o proximo waypoint tem a propria metrica. */
    state.bestRemaining = null;
    state.orbitSamples = 0;
    if (state.index + 1 < waypoints.length) { state.index += 1; return true; }
    if (loop && waypoints.length) { state.index = 0; return true; }
    state.finished = true;
    return false;
  }

  function next(emitted, reason) {
    return advance()
      ? { action: 'advance', emitted, index: state.index, ...(reason ? { reason } : {}) }
      : { action: 'done', emitted, ...(reason ? { reason } : {}) };
  }

  /**
   * Reconcilia o passo pendente contra uma amostra nova.
   *
   * POR QUE EXISTE (medido 2026-11-14): a versao anterior comparava
   * `telemetry.tick === state.lastMoveTick` (IGUALDADE). Isso barrava so' a
   * amostra repetida:
   *
   *   repetida    (10, 10, 10)  -> 1 passo   OK
   *   atrasada    (10,  9,  9)  -> 2 passos  BUG
   *   fora ordem  (10, 12, 11)  -> 3 passos  BUG
   *   sem tick    (undef x3)    -> 3 passos  BUG
   *
   * Uma amostra ATRASADA tem tick diferente do ultimo despacho, entao passava
   * pela guarda e o motor despachava outro passo com a MESMA posicao — o
   * personagem andava dois tiles para um alvo de um.
   *
   * A regra correta e' de ORDEM, nao de igualdade: so' uma amostra com tick
   * ESTRITAMENTE MAIOR que o do despacho pode confirmar ou negar o passo.
   *
   * QUANDO NAO HA TICK (telemetria antiga, fixtures sem o campo): nao existe
   * ordem para comparar, entao a discriminacao passa a ser a POSICAO. Se a
   * amostra ainda mostra o tile de origem, o passo esta' em voo. Isso mantem
   * compatibilidade com consumidores que nao publicam `tick` sem reabrir o
   * bug de despachar duas vezes para a mesma posicao.
   *
   * Devolve:
   *   { hold: motivo }        -> nao despachar nada neste tick
   *   { abort: motivo }       -> passo descartado por anomalia
   *   { confirmed: true }     -> passo chegou; o chamador SEGUE e despacha o
   *                              proximo no mesmo tick (contrato de 1 passo
   *                              por tick deste motor)
   */
  function reconcile(sample, now) {
    const pending = state.pendingStep;
    if (!pending) return { confirmed: true };

    const tick = Number.isInteger(sample.tick) ? sample.tick : null;

    /* --- 1. ordenacao --- */
    if (tick !== null && pending.sampleTick !== null) {
      if (tick <= pending.sampleTick) {
        /* Excecao a "so' tick maior vale": queda grande de tick significa que a
         * telemetria reiniciou. O `sampleTick` do pendente pertence a um
         * contador que nao existe mais, entao ele nao pode barrar nada —
         * descarta o pendente e segue com esta amostra (a posicao dela e'
         * verdade). Ver TICK_RESET_MIN. */
        if (pending.sampleTick - tick < TICK_RESET_MIN) {
          /* Amostra antiga, repetida ou fora de ordem: nao confirma e nao
           * despacha. Deixa o prazo decidir. */
          checkTimeout(now);
          return { hold: 'await-position-sample' };
        }
        state.pendingStep = null;
        state.attempts += 1;
        state.lastPosition = null;
      }
    } else if (sameTile(sample.position, pending.from)) {
      /* Sem tick: unica evidencia de "ainda em voo" e' a posicao de origem. */
      checkTimeout(now);
      return { hold: 'await-position-sample' };
    }

    /* --- 2. entidade trocou (respawn, troca de mapa, reconexao) ---
     * Os tiles do passo pendente pertencem ao personagem anterior; comparar a
     * posicao nova com eles seria comparar mundos diferentes. */
    if (Number.isInteger(sample.playerId) && Number.isInteger(pending.playerId)
        && sample.playerId !== pending.playerId) {
      state.pendingStep = null;
      state.lastPosition = null;
      return { abort: 'entity-changed', expected: pending.playerId, observed: sample.playerId };
    }

    /* --- 3. andar mudou: interrompe, nao reinterpreta como chegada --- */
    if (sample.position.z !== pending.target.z) {
      state.pendingStep = null;
      return { abort: 'floor-changed', expectedZ: pending.target.z,
        observedZ: sample.position.z };
    }

    /* --- 4. chegou ao TILE DESTE PASSO --- */
    if (sameTile(sample.position, pending.target)) {
      state.pendingStep = null;
      state.attempts = 0;
      state.lastPosition = sample.position;
      return { confirmed: true };
    }

    /* --- 5. ainda na origem ---
     *
     * DUAS leituras possiveis desta mesma observacao, e a diferenca importa:
     *
     *   a) o passo esta' em voo — o jogo ainda nao processou;
     *   b) o passo NAO aconteceu — parede, obstaculo, cooldown.
     *
     * Distinguir exige um teto. Antes eu esperava `PROGRESS_TIMEOUT_MS`
     * (2500 ms) sempre, mas isso fazia uma rota presa ficar em `hold` para
     * sempre quando os ticks vinham rapidos: 7 ticks de 300 ms = 2100 ms,
     * abaixo do prazo, e o teste de "rota presa reporta erro" nunca via o
     * `stuck`.
     *
     * Regra: cada amostra NOVA (tick maior) mostrando a posicao de origem
     * conta como uma tentativa sem progresso. Ao atingir STUCK_LIMIT o
     * chamador ve' `attempts` alto e o contorno `clockwise` entra; em
     * STALL_LIMIT a rota reporta `stuck`. Amostra repetida (mesmo tick) nao
     * conta — essa e' a guarda de nao-duplicar, acima. */
    if (sameTile(sample.position, pending.from)) {
      pending.originSamples = (pending.originSamples || 0) + 1;
      if (pending.originSamples >= STUCK_LIMIT) {
        state.pendingStep = null;
        state.attempts += 1;
        state.lastPosition = sample.position;
        return { confirmed: true, reason: 'no-progress' };
      }
      checkTimeout(now);
      return { hold: 'await-position-sample' };
    }

    /* --- 6. nem origem nem alvo: deslocamento inesperado ---
     * Pode ser overshoot do proprio passo ou algo externo movendo o
     * personagem. Nao reinterpretar como sucesso: descarta o pendente e deixa
     * o proximo tick recalcular a rota da posicao real. */
    state.pendingStep = null;
    return { abort: 'unexpected-displacement', from: pending.from,
      target: pending.target, observed: { ...sample.position } };
  }

  /** Passo pendente passou do prazo sem confirmacao. */
  function checkTimeout(now) {
    const pending = state.pendingStep;
    if (!pending) return;
    if (now - pending.sentAt < PROGRESS_TIMEOUT_MS) return;
    state.pendingStep = null;
    /* Nao avanca indice: o passo nao aconteceu. Incrementa `attempts` para o
     * contorno `clockwise` entrar em acao no proximo despacho. */
    state.attempts += 1;
  }

  /**
   * Avisa o motor que ele NAO foi consultado neste tick.
   *
   * POR QUE: `rpm-combat-runtime.cjs` roda o walker em paralelo com o combate,
   * mas PULA o walker enquanto `last.status === 'combat'`, durante
   * capture/revive, ou quando a regra do monstro e' `movement: 'stand'`.
   * Nesses ticks `runWalkerTick` devolve `null` sem chamar `step`.
   *
   * O passo pendente daquele instante continua "em voo". Na retomada, o
   * primeiro `step` compara a amostra com esse pendente velho e devolve
   * `hold: await-position-sample` — a rota parece travada por ate'
   * PROGRESS_TIMEOUT_MS (2500 ms) mesmo com tudo em ordem.
   *
   * Medido: 4 testes de RPM falhavam com `expected 'move', actual 'hold'`
   * exatamente nessa retomada apos o combate.
   *
   * POR QUE UM METODO E NAO UM LIMIAR DE TEMPO: o motor nao sabe a cadencia
   * do chamador. Adivinhar por `now` erra quando os ticks sao irregulares
   * (RPM usa 300 ms nos testes e o runtime real varia). O chamador sabe com
   * certeza se pulou — entao ele avisa. */
  function notifySkipped() {
    state.wasSkipped = true;
  }

  /** Chamado no inicio de cada `step`.
   *
   * Se o tick anterior foi pulado (combate/captura/pausa), o passo pendente
   * daquele momento nao vale mais. Ver notifySkipped().
   *
   * SEGUNDO SINAL, independente do chamador: `last.status` mudou desde o
   * ultimo despacho. O runtime troca de estado (combat -> walking) entre os
   * ticks, e o pendente criado em `combat` nao pode ser reconciliado contra
   * uma amostra de `walking`. O motor detecta isso sozinho comparando o `now`
   * do despacho com o `now` atual: se passou de um tick de progresso sem
   * confirmacao, o pendente expirou. */
  function clearIfSkipped(now) {
    const skipped = state.wasSkipped;
    state.wasSkipped = false;
    const pending = state.pendingStep;
    if (!pending) return;
    /* SEM `tick` na amostra: o pendente so' vale para o instante em que foi
     * criado. Sem ordenacao por tick, nao ha como distinguir "a amostra nao
     * mudou porque o jogo ainda nao processou" de "o jogo processou e voltou
     * ao mesmo lugar". Nesse caso o motor nao espera: recalcula a cada tick.
     *
     * Isso preserva o contrato dos consumidores que nao publicam `tick`
     * (fixtures de RPM, telemetria antiga): um passo por tick, sempre
     * despachando enquanto a posicao nao chegar. Com `tick` presente, a
     * espera ordenada de `reconcile` entra em acao. */
    if (pending.sampleTick === null && state.tickSeq > 0 && pending.seq !== state.tickSeq) {
      state.pendingStep = null;
      /* NAO zera `lastPosition`: ele e' a memoria de "a posicao mudou desde o
       * ultimo despacho" e alimenta `attempts`. Zerar aqui fazia uma rota
       * presa nunca acumular tentativas — o motor ficaria em `move` para
       * sempre em vez de reportar `stuck`. */
      return;
    }
    const expirou = now - pending.sentAt >= PROGRESS_TIMEOUT_MS;
    if (!skipped && !expirou) return;
    state.pendingStep = null;
    /* `lastPosition` NAO e' zerado aqui: se o personagem nao se mexeu, o
     * contador de tentativas tem que continuar subindo (senao uma rota presa
     * alterna move/hold para sempre em vez de reportar `stuck`). Se ele se
     * mexeu, `sameTile` zera o contador no proximo despacho. */
  }

  function step(telemetry, sink, now) {
    if (!waypoints.length || state.finished) return { action: 'idle', emitted: [] };
    state.tickSeq += 1;
    clearIfSkipped(now);
    const position = telemetry.position;
    if (!state.started) {
      state.started = true;
      if (startNearest) state.index = nearestIndex(position);
    }

    if (state.pendingStairs) {
      if (position.z !== state.pendingStairs.fromZ) {
        state.pendingStairs = null;
        state.lastPosition = position;
        return next([], 'stairs');
      }
      if (now >= state.pendingStairs.deadline) {
        state.pendingStairs = null;
        state.lastPosition = position;
        return next([], 'stairs-timeout');
      }
      return { action: 'hold', emitted: [], reason: 'stairs' };
    }

    const waypoint = waypoints[state.index];
    if (waypoint.action === 'wait') {
      if (!state.waitingUntil) state.waitingUntil = now + Math.min(3600000, Math.max(0, Number(waypoint.param) || 0));
      if (now < state.waitingUntil) return { action: 'hold', emitted: [], reason: 'wait' };
      return next([], 'wait');
    }
    if (waypoint.action === 'say') {
      const emitted = [];
      if (state.saidIndex !== state.index) {
        const text = String(waypoint.param).trim();
        if (!text || Buffer.byteLength(text, 'utf8') > 255) return { action: 'idle', emitted, reason: 'say-invalid' };
        sink.command('talk', text);
        emitted.push(['talk', text]);
        state.saidIndex = state.index;
      }
      return next(emitted, 'say');
    }
    // Walking is plane-based: reaching (x, y) counts as arrived on any z.
    // Only a stairs waypoint verifies z, by waiting for the floor to change
    // from the floor observed when the stair tile was reached.
    if (waypoint.action === 'stairs' && samePlane(position, waypoint.pos)) {
      const direction = stairDirection(waypoint.param);
      state.pendingStairs = {
        fromZ: position.z,
        deadline: now + STAIRS_TIMEOUT_MS,
      };
      if (direction === null) return { action: 'hold', emitted: [], reason: 'stairs' };
      /* Passo UNICO para dentro da escada. Sem `pendingStep`: o que confirma a
       * transicao e' o `z`, nao o tile. O guarda `pendingStairs` impede repetir. */
      sink.command('walk', direction);
      state.lastDispatchAt = now;
      state.lastPosition = position;
      return { action: 'move', emitted: [['walk', direction]], direction, index: state.index, reason: 'stairs-stepping' };
    }

    /* --- box/safespot com o tile do waypoint ocupado ---
     *
     * Diferente de `walk` (que e' um ponto), `box` e `safespot` sao area: o
     * Shiba para e combate na regiao. Exigir o tile exato fazia o corpo orbitar
     * quando um monstro estava em cima do waypoint — situacao normal, nao erro
     * (ver ORBIT_SAMPLES). Aqui o vizinho livre vale como chegada.
     *
     * Fica ANTES do passo pendente: nao ha o que reconciliar, o waypoint ja'
     * foi cumprido. A condicao exige distancia 1 E o tile ocupado; waypoint
     * livre continua exigindo o tile exato, e um monstro longe nao antecipa a
     * chegada. */
    if (ARRIVAL_TOLERANCE_ACTIONS.includes(waypoint.action)
        && planeDistance(position, waypoint.pos) === 1
        && tileOccupied(telemetry, waypoint.pos)) {
      state.pendingStep = null;
      return next([], 'arrived-adjacent');
    }

    /* --- Chegada ao waypoint TEM PRECEDENCIA sobre o passo pendente ---
     * Se a amostra ja' mostra o tile do waypoint, nao ha o que reconciliar:
     * avanca. Isso cobre overshoot (o personagem andou 2 tiles) sem tratar
     * como `unexpected-displacement`. */
    if (samePlane(position, waypoint.pos)) {
      state.pendingStep = null;
      return next([], 'arrived');
    }
    // Require actual progress on this leg so dense routes cannot cycle in place.
    if (waypoint.action === 'walk' && state.approachFrom?.z === position.z
        && position.z === waypoint.pos.z && planeDistance(position, waypoint.pos) === 1
        && planeDistance(state.approachFrom, waypoint.pos) > 1) {
      state.pendingStep = null;
      return next([], 'arrived-within-one-tile');
    }

    /* --- Passo em voo: reconciliar antes de qualquer novo despacho --- */
    let reconciled = null;
    if (state.pendingStep) {
      const r = reconcile(telemetry, now);
      if (r.hold) {
        return { action: 'hold', emitted: [], reason: r.hold,
          index: state.index, pending: { ...state.pendingStep } };
      }
      /* `confirmed`: segue e despacha o proximo passo neste mesmo tick.
       * `abort`: o pendente ja' foi descartado e a posicao observada e' a nova
       * verdade — tambem despacha neste tick, a partir dela, em vez de gastar
       * um tick parado. Com a rota no ritmo do chamador (100 ms) e' o que
       * separa "recalculou" de "travou por um tick". O motivo vai no payload
       * para diagnostico. */
      reconciled = r.abort || null;
    }

    const target = smart ? smartTarget(position, waypoint) : waypoint.pos;
    if (target.x === position.x && target.y === position.y) {
      state.stalls += 1;
      if (state.stalls >= STALL_LIMIT) return next([], 'floor-mismatch');
      return { action: 'hold', emitted: [], reason: 'floor-mismatch' };
    }
    /* Tentativa sem progresso: a posicao nao mudou desde o ultimo despacho.
     *
     * Conta AQUI, fora do pendente, porque o pendente e' descartado a cada
     * tick quando a telemetria nao publica `tick` (ver clearIfSkipped). Sem
     * isso o contador zeraria junto e uma rota presa nunca atingiria
     * STALL_LIMIT — o teste "rota presa reporta erro" falhava.
     *
     * Mesma logica de antes: `sameTile(position, lastPosition)` significa que
     * o passo anterior nao surtiu efeito. */
    /* --- Piso de cadencia (ver STEP_INTERVAL_MS) ---
     *
     * Fica DEPOIS da reconciliacao de proposito: um passo confirmado nao
     * autoriza o proximo a sair no mesmo instante — o jogo ainda leva ~406 ms
     * por tile e despachar antes so' enfileira comando no cliente.
     *
     * NAO conta tentativa: esperar a cadencia nao e' passo sem progresso. Se
     * contasse, uma caminhada normal chegaria a STUCK_LIMIT e a rota sairia em
     * diagonal sem motivo. */
    if (now - state.lastDispatchAt < stepIntervalMs) {
      return { action: 'hold', emitted: [], reason: 'cadence', index: state.index,
        waitMs: stepIntervalMs - (now - state.lastDispatchAt) };
    }

    /* --- Plano de passo ---
     *
     * Com planejador, `remaining` e' custo de CAMINHO, nao distancia em linha
     * reta: contornar parede pode afastar do waypoint e ainda assim progredir.
     * Sem planejador (ou sem rota), cai no guloso e a metrica volta a ser
     * euclidiana. */
    let planned = null;
    if (planner && waypoint.action !== 'stairs') {
      try { planned = planner.plan(position, waypoint.pos); } catch { planned = null; }
      if (planned && !Number.isInteger(planned.direction)) planned = null;
    }
    const remaining = planned ? planned.remaining : planeDistance(position, waypoint.pos);
    if (Boolean(planned) !== state.usingPlan || state.bestRemaining === null || remaining < state.bestRemaining) {
      state.usingPlan = Boolean(planned);
      state.bestRemaining = remaining;
      state.orbitSamples = 0;
    } else {
      state.orbitSamples += 1;
      if (state.orbitSamples >= ORBIT_SAMPLES) return next([], 'stuck');
    }

    const stuck = sameTile(position, state.lastPosition);
    state.attempts = stuck ? state.attempts + 1 : 0;
    let move = planned ? planned.direction : direction(position, target);
    if (state.attempts >= STUCK_LIMIT) {
      /* Sem plano, `clockwise` e' o unico contorno. Com plano, tenta manter a
       * rota e so' desvia se ela insistir em bater. */
      if (!planned) move = clockwise(move);
      if (state.attempts >= STALL_LIMIT) return next([], 'stuck');
    }
    if (!planned && waypoint.action !== 'stairs' && position.z === waypoint.pos.z
        && planner?.canStep?.(position, move) === false) {
      state.lastPosition = position;
      state.lastDispatchAt = now;
      return { action: 'hold', emitted: [], reason: 'map-blocked', index: state.index };
    }
    const stepTarget = {
      x: position.x + STEP_DELTA[move][0],
      y: position.y + STEP_DELTA[move][1],
      z: position.z,
    };
    sink.command('walk', move);
    state.lastDispatchAt = now;

    /* Registra o passo pendente. `stepTarget` e' o TILE DESTE PASSO (1 tile),
     * nao o waypoint final — e' o que permite confirmar passo a passo sem
     * pular waypoints. Vem do delta da DIRECAO, nao do sinal do waypoint: com
     * planejador um passo pode andar contra o waypoint para contornar parede. */
    state.pendingStep = {
      direction: move,
      from: { ...position },
      target: stepTarget,
      sampleTick: Number.isInteger(telemetry.tick) ? telemetry.tick : null,
      /* Identidade da amostra que originou o passo: se o personagem trocar
       * (respawn/reconexao), os tiles pendentes deixam de valer. */
      playerId: Number.isInteger(telemetry.playerId) ? telemetry.playerId : null,
      seq: state.tickSeq,
      sentAt: now,
    };
    state.approachFrom ??= { ...position };
    state.lastPosition = position;
    state.lastMoveTick = Number.isInteger(telemetry.tick) ? telemetry.tick : null;
    return { action: 'move', emitted: [['walk', move]], direction: move, index: state.index,
      ...(reconciled ? { reconciled } : {}) };
  }

  function smartTarget(position, waypoint) {
    const dx = waypoint.pos.x - position.x;
    const dy = waypoint.pos.y - position.y;
    if (Math.abs(dx) >= Math.abs(dy)) return { x: position.x + Math.sign(dx), y: position.y, z: position.z };
    return { x: position.x, y: position.y + Math.sign(dy), z: position.z };
  }

  return {
    step,
    notifySkipped,
    /* `reset()` reinicia a INSTANCIA (troca de rota, reativacao do modulo).
     * Precisa zerar a guarda de orbita junto: se `bestRemaining` sobrevivesse,
     * a proxima rota herdaria a melhor distancia da ANTERIOR e dispararia
     * `stuck` cedo; se `orbitSamples` sobrevivesse, o contador comecaria
     * poluido e a rota morreria antes de tentar. */
    reset() { Object.assign(state, { index: 0, waitingUntil: 0, lastPosition: null, lastMoveTick: null, attempts: 0, stalls: 0,
      pendingStairs: null, saidIndex: -1, finished: false, started: false, approachFrom: null, pendingStep: null, wasSkipped: false, tickSeq: 0, lastDispatchAt: -Infinity,
      bestRemaining: null, orbitSamples: 0, usingPlan: false }); },
    get state() { return { index: state.index, pendingStairs: state.pendingStairs, finished: state.finished, total: waypoints.length,
      pendingStep: state.pendingStep ? { ...state.pendingStep } : null }; },
    waypoints: () => waypoints.map(waypoint => ({ ...waypoint, pos: { ...waypoint.pos } })),
    stepIntervalMs,
  };
}

module.exports = { createWalkerEngine, normalizeWaypoint, ACTIONS, STAIRS_TIMEOUT_MS, STUCK_LIMIT, PROGRESS_TIMEOUT_MS, TICK_RESET_MIN, STEP_INTERVAL_MS, ORBIT_SAMPLES };
