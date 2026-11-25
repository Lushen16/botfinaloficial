'use strict';

// Banco offline. Só o simulador ou um arquivo escolhido pelo operador fornece posições.
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { parseArgs } = require('node:util');
const { EngineRuntime } = require('../reconstruction/engine-runtime.cjs');
const { createAutomation, createFrameAutomation } = require('../reconstruction/automation.cjs');
const { createPathPlanner } = require('../reconstruction/pathfinder.cjs');
const { realPosition, sameTile } = require('../reconstruction/engines/shared.cjs');

const cenarios = ['reta', 'reta-exata', 'descarte', 'atraso', 'teleporte', 'bloqueio', 'corredor', 'escada', 'multidao'];
const vetores = [[0,-1], [1,0], [0,1], [-1,0], [1,-1], [1,1], [-1,1], [-1,-1]];
const pos = (x, y = 100, z = 7) => ({ x, y, z });
const INTERVALO = 5000;
const PASSO_RELOGIO = 50;

function lerCaptura(arquivo) {
  const bytes = fs.readFileSync(arquivo);
  const codificacao = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf16le' : 'utf8';
  const registros = JSON.parse(bytes.toString(codificacao).replace(/^\uFEFF/, '')).samples;
  if (!Array.isArray(registros) || !registros.length) throw Error('Esperado um arquivo histórico com samples[].');
  const inicio = registros[0].at;
  let anterior = -Infinity;
  return registros.map(({ at, pos: ponto, id, error }) => {
    if (!Number.isFinite(at) || at < anterior) throw Error('Carimbo inválido ou fora de ordem na captura.');
    anterior = at;
    const jogador = !error && realPosition(ponto) && Number.isInteger(id) ? { id, pos: ponto } : null;
    return { t: Math.round((at - inicio) * 1000), jogador };
  });
}

function criarCenario(nome, captura) {
  if (!captura && !cenarios.includes(nome)) throw Error('Cenário desconhecido: ' + nome);
  const inicio = captura ? captura.find(r => r.jogador)?.jogador.pos : pos(100);
  if (!inicio) throw Error('Captura sem posição válida.');
  const finalCaptura = captura?.findLast(r => r.jogador)?.jogador.pos;
  let alvo = finalCaptura ?? pos(nome.startsWith('reta') ? 300 : 110);
  if (nome === 'corredor') alvo = pos(104, 104);
  if (nome === 'escada') alvo = pos(100, 101, 8);
  const escada = nome === 'escada';
  const waypoint = escada ? { action: 'stairs', pos: inicio, param: 'south' }
    : { action: ['reta', 'captura'].includes(nome) ? 'walk' : 'safespot', pos: alvo };
  function livre({ x, y }) {
    if (nome === 'bloqueio') return x !== 105 || y !== 100;
    if (nome === 'corredor') return (y === 100 && x >= 100 && x <= 104)
      || (x === 104 && y >= 100 && y <= 104);
    return true;
  }
  return { inicio, alvo, waypoint, escada, livre };
}

async function executar({ nome = 'reta', captura, registrar = () => {} } = {}) {
  if (captura) nome = 'captura';
  const mundo = criarCenario(nome, captura);
  let t = 0, fisica = mundo.inicio, amostra, seq = 0, indice = -1, anteriorEnvio;
  let emitidos = 0, aplicados = 0, confirmados = 0, consultasPlano = 0, chamadasSemCache = 0;
  let ultimaConsulta = -Infinity, maiorIntervalo = 0, esperaFrame = 0, custo = 0;
  let chegouEm = null, concluiuEm = null, enviadosDesdeAmostra = [];
  let evento, ultimoCarimbo = null, ciclos = 0, interrupcoes = 0;
  const mapa = { tile: p => ({ seen: true, walkable: mundo.livre(p) }) };
  const plano = createPathPlanner({ getMap: () => mapa, now: () => t });
  const planejador = captura ? undefined : {
    ...plano,
    plan(de, para, bloqueada) {
      consultasPlano++;
      // Após o TTL de 750 ms toda consulta deste cenário exige uma busca.
      if (t - ultimaConsulta > 750 || bloqueada) chamadasSemCache++;
      ultimaConsulta = t;
      return plano.plan(de, para, bloqueada);
    },
  };
  const config = { walker: { waypoints: [mundo.waypoint], loop: false, humanize: false } };
  const runtime = new EngineRuntime({ automatic: false, now: () => t });
  runtime.modules = ['walker'];
  runtime.paused = false;
  runtime.automation = createAutomation(config, { now: () => t, stepPlanner: planejador });
  runtime.frameAutomation = createFrameAutomation(config);
  runtime.adapter = {
    supportedCommands: ['walk'],
    async command(comando, dir) {
      if (comando !== 'walk' || !vetores[dir]) throw Error('Ordem inesperada no ensaio.');
      const origem = captura ? amostra.jogador.pos : fisica;
      const [dx, dy] = vetores[dir];
      const destino = pos(origem.x + dx, origem.y + dy, origem.z);
      evento = { origem, destino, dir };
      emitidos++;
      if (anteriorEnvio !== undefined) maiorIntervalo = Math.max(maiorIntervalo, t - anteriorEnvio);
      anteriorEnvio = t;
      enviadosDesdeAmostra.push(destino);
      if (!captura) {
        const retido = (nome === 'descarte' && emitidos === 2)
          || (nome === 'multidao' && fisica.x === 103 && emitidos <= 5);
        const quinaLivre = !dx || !dy || (mundo.livre(pos(origem.x + dx, origem.y))
          && mundo.livre(pos(origem.x, origem.y + dy)));
        if (!retido && quinaLivre && mundo.livre(destino)) {
          fisica = mundo.escada ? { ...destino, z: 8 } : destino;
          aplicados++;
          custo += dx && dy ? 14 : 10;
          if (chegouEm === null && sameTile(fisica, mundo.alvo)) chegouEm = t;
        }
      }
      return { delivered: true, status: 0 };
    },
  };
  const limite = captura ? Math.ceil(captura.at(-1).t / PASSO_RELOGIO) * PASSO_RELOGIO : 1050000;
  let publEm = 0;
  for (t = 0; t <= limite; t += PASSO_RELOGIO) {
    evento = null;
    if (t >= publEm) {
      if (captura) {
        while (indice + 1 < captura.length && captura[indice + 1].t <= t) indice++;
        amostra = captura[indice];
      } else if (!(nome === 'atraso' && t >= 5000 && t < 20000)) {
        if (nome === 'teleporte' && t === 15000) fisica = pos(102, 106);
        amostra = { t, jogador: { id: 1, pos: fisica } };
      }
      if (amostra.t !== ultimoCarimbo) {
        seq++;
        ultimoCarimbo = amostra.t;
        if (!captura && enviadosDesdeAmostra.length === 1 && sameTile(enviadosDesdeAmostra[0], amostra.jogador?.pos)) confirmados++;
        enviadosDesdeAmostra = [];
      }
      publEm += INTERVALO;
    }
    const idade = t - amostra.t;
    const criaturas = nome === 'multidao' ? [101, 102, 103, 104].map((x, i) =>
      ({ id: i + 2, pos: pos(x, 101), type: 1, healthPercent: 100 })) : [];
    const saida = await runtime.runFrameTick({ online: Boolean(amostra.jogador), stale: idade > 11000, ageMs: idade,
      telemetry: { seq, sampledAtMs: amostra.t, player: amostra.jogador, creaturesAvailable: true, creatures: criaturas } }, runtime.epoch);
    if (saida.faults.length) throw Error(JSON.stringify(saida.faults));
    ciclos++;
    if (saida.status === 'await-frame') esperaFrame++;
    if (saida.status === 'interrupted') interrupcoes++;
    const pendente = runtime.automation.walker.state.pendingStep;
    registrar({ t, state: saida.walk?.reason ?? saida.walk?.action ?? saida.status,
      from: evento?.origem ?? null, to: evento?.destino ?? null, dir: evento?.dir ?? null,
      expected: pendente?.target ?? null, actual: amostra.jogador?.pos ?? null, ageMs: idade, rng: null,
      cenario: nome, seq, mundoSimulado: captura ? null : fisica });
    if (concluiuEm === null && runtime.automation.walker.state.finished) {
      concluiuEm = t;
      if (!captura) break;
    }
  }
  // Custos ótimos em unidades 10/14 para estas geometrias. No bloqueio de
  // uma casa, duas diagonais afastadas da quina substituem dois cardinais.
  const comparavel = !captura && !mundo.escada && nome !== 'teleporte' && chegouEm !== null;
  let otimo = 10 * (mundo.alvo.x - mundo.inicio.x);
  if (nome === 'bloqueio') otimo += 8;
  if (nome === 'corredor') otimo = 80;
  const duracao = Math.min(t, limite);
  return { cenario: nome, ciclos, snapshots: seq, esperaFrame, interrupcoes, duracaoMs: duracao,
    emitidos, aplicadosNoSimulador: captura ? null : aplicados, confirmadosPorPosicao: captura ? null : confirmados,
    razaoDescarte: captura || !emitidos ? null : (emitidos - aplicados) / emitidos,
    tilesPorMinuto: captura || !duracao ? null : aplicados * 60000 / duracao,
    missteps: captura ? null : 0, consultasPlano, buscasGarantidas: chamadasSemCache, eventosUnstuck: null,
    maiorIntervaloEmissoesMs: emitidos > 1 ? maiorIntervalo : null, chegadaExataMs: chegouEm, rotaConcluidaMs: concluiuEm,
    custoRealSobreOtimo: comparavel && custo ? custo / otimo : null,
    eficiencia: comparavel && custo ? otimo / custo : null };
}

async function principal() {
  const { values } = parseArgs({ options: { cenario: { type: 'string' }, captura: { type: 'string' },
    trace: { type: 'string' }, conferir: { type: 'string' } } });
  if (values.captura && values.cenario) throw Error('Escolha captura ou cenário.');
  const captura = values.captura && lerCaptura(values.captura);
  const lista = values.cenario === 'todos' ? cenarios : [values.cenario ?? 'reta'];
  const resumoHash = createHash('sha256');
  const arquivo = values.trace && fs.openSync(values.trace, 'wx');
  try {
    for (const nome of lista) {
      const resumo = await executar({ nome, captura, registrar(linha) {
        const texto = JSON.stringify(linha) + '\n';
        resumoHash.update(texto);
        if (arquivo !== undefined) fs.writeSync(arquivo, texto);
      } });
      console.log(JSON.stringify(resumo));
    }
  } finally {
    if (arquivo !== undefined) fs.closeSync(arquivo);
  }
  const sha256 = resumoHash.digest('hex');
  if (values.conferir) {
    const anterior = createHash('sha256');
    for await (const trecho of fs.createReadStream(values.conferir)) anterior.update(trecho);
    if (anterior.digest('hex') !== sha256) throw Error('A trilha diverge da repetição.');
  }
  console.log(JSON.stringify({ sha256 }));
}

module.exports = { executar, lerCaptura };
if (require.main === module) principal().catch(erro => { console.error(erro.message); process.exitCode = 1; });
