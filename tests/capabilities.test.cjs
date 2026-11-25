'use strict';

/*
 * G04 — contrato de capacidades e recusa antecipada.
 *
 * Estes testes usam a fixture ESTRITA (`RuntimeServer({ strict: true,
 * declaration })`), que recusa com status 4 o que nao declarou. A fixture
 * permissiva (`autoAck` generico) continua existindo para framing/autenticacao,
 * mas nao serve como prova de implementacao de comando.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { once } = require('node:events');

const capabilities = require('../reconstruction/capabilities.cjs');
const { RuntimeServer } = require('../reconstruction/runtime-server.cjs');
const { Transport } = require('../reconstruction/transport.cjs');
const { EngineRuntime } = require('../reconstruction/engine-runtime.cjs');
const nativeAdapter = require('../reconstruction/native-adapter.cjs');
const { COMMANDS } = require('../reconstruction/protocol.cjs');

let nextPid = 54000 + (process.pid % 500);

const NATIVE_DECLARATION = Object.freeze({
  contract: 'pka-capabilities', version: 1, server: 'pka_native',
  commands: [...capabilities.NATIVE_COMMANDS],
});

const telemetry = (patch = {}) => ({
  schema: 2, nativeVerified: true, pulseVersion: 3, tick: 1, playerId: 1, fightMode: 0, chaseMode: 0,
  clockMs: 1, position: { x: 100, y: 100, z: 7 }, healthPercent: 100,
  activeSlot: 1, moves: [], nativeSequence: [], pokemonName: 'Charizard', comboPokemonName: 'Charizard',
  conditionEvents: true, conditionsKnown: true, conditions: [],
  roster: [{ slot: 1, uuid: 'uuid', name: 'Charizard', healthPercent: 100, moves: null }],
  creatures: [], items: [], tiles: [], ...patch,
});

const dynamicConfig = (extra = {}) => ({
  target: { monsters: [], maxDistance: 8, luring: { frontEnabled: true }, ...extra },
  healer: {}, hoenn: {},
});

const walkerConfig = () => ({
  target: { monsters: [], maxDistance: 8, luring: {} }, healer: {}, hoenn: {},
  walker: { waypoints: [{ action: 'walk', pos: { x: 105, y: 100, z: 7 } }] },
});

function strictPair(options = {}) {
  const pid = nextPid++;
  const key = 'g04-strict-fixture';
  const server = new RuntimeServer({ pid, key, strict: true, declaration: NATIVE_DECLARATION, ...options });
  const transport = new Transport({ pid, key, startupTimeoutMs: 4000, commandTimeoutMs: 2000 });
  return { pid, server, transport };
}

const stateBytes = () => {
  const bytes = Buffer.alloc(48);
  bytes.writeUInt32LE(1, 0);
  bytes.writeUInt32LE(1, 4);
  bytes.writeUInt32LE(100, 8);
  bytes.writeDoubleLE(100, 12);
  bytes.writeDoubleLE(50, 20);
  bytes.writeDoubleLE(150, 28);
  bytes.writeUInt32LE(0, 36);
  bytes.writeUInt32LE(0, 40);
  bytes.writeUInt32LE(1, 44);
  return bytes;
};

/* ---------------------------------------------------------------- contrato */

test('the native declaration lists exactly the implemented command set', () => {
  const parsed = capabilities.parseDeclaration(NATIVE_DECLARATION);
  assert.equal(parsed.state, 'valid');
  assert.deepEqual(parsed.commands, [...capabilities.NATIVE_COMMANDS]);
  assert.ok(!parsed.commands.includes('chase'), 'chase nao tem handler na DLL');
  assert.ok(!parsed.commands.includes('revive'), 'revive e rejeitado pelo encoder');
  assert.ok(parsed.commands.includes('potion'), 'potion numerico e implementado');
});

test('absent, malformed and unknown declarations grant no command', () => {
  assert.equal(capabilities.parseDeclaration(undefined).state, 'absent');
  assert.equal(capabilities.parseDeclaration('texto').state, 'malformed');
  assert.equal(capabilities.parseDeclaration({ contract: 'x' }).state, 'malformed');
  assert.equal(capabilities.parseDeclaration({ contract: 'x', version: 1, commands: [] }).state, 'malformed');
  const unknown = capabilities.parseDeclaration({ contract: 'fornecedor-x', version: 1, commands: ['walk'] });
  assert.equal(unknown.state, 'unknown');
  assert.deepEqual(unknown.commands, [], 'contrato desconhecido nao habilita nada');
});

/* ------------------------------------------------- compatibilidade estatica */

test('dynamic lure requires chase and is refused without it', () => {
  const { requirements } = capabilities.requirementsFor(['target'], dynamicConfig());
  const missing = capabilities.evaluate(requirements, capabilities.parseDeclaration(NATIVE_DECLARATION));
  assert.equal(missing.ok, false);
  const feature = missing.missing.find(entry => entry.feature === 'dynamic-lure');
  assert.ok(feature, 'dynamic lure precisa ser apontada');
  assert.deepEqual(feature.commands, ['chase']);
  assert.match(capabilities.describeMissing(missing.missing), /dynamic-lure/);
});

test('dynamic lure passes when the server declares chase', () => {
  const declaration = capabilities.parseDeclaration({ ...NATIVE_DECLARATION, commands: [...capabilities.NATIVE_COMMANDS, 'chase'] });
  const { requirements } = capabilities.requirementsFor(['target'], dynamicConfig());
  assert.equal(capabilities.evaluate(requirements, declaration).ok, true);
});

test('a compatible isolated walker stays available', () => {
  const { requirements } = capabilities.requirementsFor(['walker'], walkerConfig());
  const result = capabilities.evaluate(requirements, capabilities.parseDeclaration(NATIVE_DECLARATION));
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
});

test('configurations that do not need chase are not penalised', () => {
  for (const luring of [{}, { enabled: true }, { randomEnabled: true }]) {
    const { requirements } = capabilities.requirementsFor(['target'], { target: { monsters: [], luring } });
    const result = capabilities.evaluate(requirements, capabilities.parseDeclaration(NATIVE_DECLARATION));
    assert.equal(result.ok, true, 'luring ' + JSON.stringify(luring) + ' nao exige chase');
  }
});

/* ------------------------------------------------------ fluxo com transporte */

test('a strict fixture refuses chase with status 4 — the bug the auto-ACK hid', async () => {
  const { server, transport } = strictPair();
  await server.start();
  try {
    await transport.connect();
    const ack = await transport.sendCommand('chase', 1);
    assert.equal(ack.status, 4, 'fixture estrita recusa chase como a DLL real');
    const accepted = await transport.sendCommand('attack', 12);
    assert.equal(accepted.status, 0, 'o que foi declarado continua aceito');
  } finally {
    transport.close();
    await server.close();
  }
});

test('the permissive transport fixture still answers a generic ACK', async () => {
  /* Fixture de transporte: prova framing/ACK, NAO implementacao de comando.
   * Por isso ela responde 0 para chase — e por isso nao serve de evidencia. */
  const pid = nextPid++;
  const key = 'g04-permissive-fixture';
  const server = new RuntimeServer({ pid, key });
  const transport = new Transport({ pid, key });
  await server.start();
  try {
    await transport.connect();
    const ack = await transport.sendCommand('chase', 1);
    assert.equal(ack.status, 0);
  } finally {
    transport.close();
    await server.close();
  }
});

test('dynamic lure is refused before any automation command is sent', async () => {
  const { pid, server, transport } = strictPair();
  const runtime = new EngineRuntime({ automatic: false,
    openAdapter: context => nativeAdapter.open(context, { transport, capabilityTimeoutMs: 2000 }) });
  await server.start();
  try {
    const state = await runtime.setModules('target', true, pid, dynamicConfig());
    assert.equal(state.status, 'blocked');
    assert.equal(state.reason, 'capability-missing');
    assert.match(state.error, /dynamic-lure/);
    assert.match(state.error, /chase/);
    assert.deepEqual(runtime.modules, [], 'nada sobe');
    assert.equal(runtime.state.paused, true);
    assert.deepEqual(server.commands, [], 'nenhum comando de automacao saiu');
  } finally {
    await runtime.close();
    await server.close();
  }
});

test('dynamic lure keeps working when the server declares chase', async () => {
  const declaration = { ...NATIVE_DECLARATION, commands: [...capabilities.NATIVE_COMMANDS, 'chase'] };
  const { pid, server, transport } = strictPair({ declaration });
  const runtime = new EngineRuntime({ automatic: false,
    openAdapter: context => nativeAdapter.open(context, { transport, capabilityTimeoutMs: 2000 }) });
  await server.start();
  try {
    const state = await runtime.setModules('target', true, pid, dynamicConfig());
    assert.deepEqual(runtime.modules, ['target'], 'modulo sobe quando a capacidade existe');
    assert.notEqual(state.status, 'blocked');
  } finally {
    await runtime.close();
    await server.close();
  }
});

test('an isolated walker stays available next to a refused dynamic target', async () => {
  const { pid, server, transport } = strictPair();
  const runtime = new EngineRuntime({ automatic: false,
    openAdapter: context => nativeAdapter.open(context, { transport, capabilityTimeoutMs: 2000 }) });
  await server.start();
  try {
    const state = await runtime.setModules('walker', true, pid, walkerConfig());
    assert.deepEqual(runtime.modules, ['walker'], 'walker compativel sobe sozinho');
    assert.equal(state.paused, false);
    server.publishState(stateBytes());
    const received = once(transport, 'telemetry');
    server.publishTelemetry(telemetry());
    await received;
    await runtime.tick();
    const sent = server.commands.map(command => command.type);
    assert.ok(sent.every(type => type !== COMMANDS.chase), 'nunca emite chase');
    assert.ok(server.commands.length > 0, 'o walker emitiu comando');
  } finally {
    await runtime.close();
    await server.close();
  }
});

test('a batch with an incompatible command sends nothing at all', async () => {
  const { pid, server, transport } = strictPair();
  const runtime = new EngineRuntime({ automatic: false,
    openAdapter: context => nativeAdapter.open(context, { transport, capabilityTimeoutMs: 2000 }) });
  await server.start();
  try {
    await runtime.setModules('target', true, pid, dynamicConfig({ combo: { enabled: true } }));
    /* A declaracao encolhe para simular servidor que deixou de anunciar
     * `combo`, ja com o modulo no ar. */
    runtime.adapter.supportedCommands.length = 0;
    runtime.adapter.supportedCommands.push('attack', 'talk');
    const received = once(transport, 'telemetry');
    server.publishTelemetry(telemetry({ creatures: [
      { id: 12, name: 'Wild', type: 1, pos: { x: 101, y: 100, z: 7 }, healthPercent: 70, canAttack: true }] }));
    await received;
    await runtime.tick();
    assert.deepEqual(server.commands, [], 'nem o attack anterior pode sair');
  } finally {
    await runtime.close();
    await server.close();
  }
});

test('revalidating a configuration change re-checks capabilities', async () => {
  const { pid, server, transport } = strictPair();
  const runtime = new EngineRuntime({ automatic: false,
    openAdapter: context => nativeAdapter.open(context, { transport, capabilityTimeoutMs: 2000 }) });
  await server.start();
  try {
    await runtime.setModules('target', true, pid, dynamicConfig());
    assert.deepEqual(runtime.modules, []);
    /* Mesma sessao, config sem dynamic: passa. */
    const state = await runtime.setModules('target', true, pid,
      { target: { monsters: [], luring: { enabled: true } }, healer: {}, hoenn: {} });
    assert.deepEqual(runtime.modules, ['target']);
    assert.notEqual(state.reason, 'capability-missing');
  } finally {
    await runtime.close();
    await server.close();
  }
});

/* ------------------------------------------------ coerencia com a DLL em C */

test('the C declaration lists exactly the same commands as capabilities.cjs', () => {
  /* Trava a divergencia entre o blob publicado por build_automation e o
   * modulo JS. Se alguem acrescentar um comando na DLL sem handler, este
   * teste falha antes de o bug chegar ao jogo. */
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'native', 'pka_native.c'), 'utf8');
  /* CRLF: o arquivo chega do checkout do Windows. Sem o `\r?` o bloco nunca
   * casa e o teste falha dizendo "CAP_COMMANDS deve existir", escondendo o
   * motivo real. */
  const block = source.match(/#define CAP_COMMANDS ([\s\S]*?)\r?\n\r?\n/);
  assert.ok(block, 'CAP_COMMANDS deve existir em pka_native.c');
  const names = [...block[1].matchAll(/\\"([a-zA-Z]+)\\"/g)].map(match => match[1]).sort();
  assert.deepEqual(names, [...capabilities.NATIVE_COMMANDS].sort());
  assert.match(source, /#define CAP_CONTRACT "pka-capabilities"/);
  assert.match(source, /#define CAP_VERSION 1/);
  assert.equal(capabilities.VERSION, 1);
});


/* ============================================================================
 * G04-R1 — lacunas da revisao
 * ========================================================================= */

/* --------------------------------------------------- 1. stop no contrato */

test('stop is required for movement and for combat', () => {
  const walker = capabilities.requirementsFor(['walker'], walkerConfig());
  const target = capabilities.requirementsFor(['target'], dynamicConfig({ luring: {} }));
  assert.ok(walker.commands.includes('stop'), 'movimento exige stop');
  assert.ok(target.commands.includes('stop'), 'combate exige stop');
});

test('a server declaring walk but not stop cannot start movement', async () => {
  const declaration = { contract: 'pka-capabilities', version: 1,
    commands: ['walk', 'attack', 'talk', 'combo', 'switchPokemon', 'potion', 'hotkey'] };
  const { pid, server, transport } = strictPair({ declaration });
  const runtime = new EngineRuntime({ automatic: false,
    openAdapter: context => nativeAdapter.open(context, { transport, capabilityTimeoutMs: 2000 }) });
  await server.start();
  try {
    const state = await runtime.setModules('walker', true, pid, walkerConfig());
    assert.equal(state.status, 'blocked');
    assert.match(state.error, /stop/);
    assert.deepEqual(runtime.modules, []);
    assert.deepEqual(server.commands, []);
  } finally {
    await runtime.close();
    await server.close();
  }
});

/* -------------------------------- 2. partida conjunta sem execucao parcial */

test('a joint request with one incompatible module starts nothing', async () => {
  /* Walker compativel isolado; Target pede `chase` que nao existe. */
  const { pid, server, transport } = strictPair();
  const runtime = new EngineRuntime({ automatic: false,
    openAdapter: context => nativeAdapter.open(context, { transport, capabilityTimeoutMs: 2000 }) });
  await server.start();
  try {
    const config = { ...dynamicConfig(), walker: walkerConfig().walker };
    const state = await runtime.setModules('all', true, pid, config);
    assert.equal(state.status, 'blocked');
    assert.deepEqual(runtime.modules, [], 'nao sobe so o Walker');
    assert.deepEqual(server.commands, []);
  } finally {
    await runtime.close();
    await server.close();
  }
});

test('the walker requested alone still starts after the joint refusal', async () => {
  const { pid, server, transport } = strictPair();
  const runtime = new EngineRuntime({ automatic: false,
    openAdapter: context => nativeAdapter.open(context, { transport, capabilityTimeoutMs: 2000 }) });
  await server.start();
  try {
    const joint = { ...dynamicConfig(), walker: walkerConfig().walker };
    await runtime.setModules('all', true, pid, joint);
    assert.deepEqual(runtime.modules, []);
    const state = await runtime.setModules('walker', true, pid, walkerConfig());
    assert.deepEqual(runtime.modules, ['walker']);
    assert.notEqual(state.status, 'blocked');
  } finally {
    await runtime.close();
    await server.close();
  }
});

/* ------------------------------------------- 3. requisitos do caminho real */

test('healer item channel follows the engine: hotkey first, no silent fallback', () => {
  /* Hotkey configurada -> exige `hotkey`, nao `action`. */
  const withHotkey = capabilities.requirementsFor(['healer'], {
    healer: {}, hoenn: { potionHpPercent: 60, potionHotkey: 'F3', potionActionBar: 3 } });
  assert.ok(withHotkey.commands.includes('hotkey'));
  assert.ok(!withHotkey.commands.includes('potion'), 'com hotkey nao exige potion');

  /* Sem hotkey, com slot -> `potion` numerico. */
  const withSlot = capabilities.requirementsFor(['healer'], {
    healer: {}, hoenn: { potionHpPercent: 60, potionHotkey: '', potionActionBar: 3 } });
  assert.ok(withSlot.commands.includes('potion'));
  assert.ok(!withSlot.commands.includes('action'));

  /* Nenhum canal de potion -> o motor nao emite potion. */
  const none = capabilities.requirementsFor(['healer'], {
    healer: {}, hoenn: { potionHpPercent: 60, potionHotkey: '', potionActionBar: 0,
      useMedicine: false } });
  assert.ok(!none.commands.includes('action'));
  assert.ok(!none.commands.includes('potion'));

  /* Medicine ligada SEM hotkey: exige `hotkey` no start. Medicine nao tem
   * fallback numerico; sem isso o motor so' bloqueia a cada tick. */
  const medicineMissing = capabilities.requirementsFor(['healer'], {
    healer: {}, hoenn: { potionHpPercent: 0, useMedicine: true, medicineHotkey: '' } });
  assert.ok(medicineMissing.commands.includes('hotkey'));
  const medicineOk = capabilities.requirementsFor(['healer'], {
    healer: {}, hoenn: { potionHpPercent: 0, useMedicine: true, medicineHotkey: 'F4' } });
  assert.ok(medicineOk.commands.includes('hotkey'));
});

test('requirements do not ask for commands the configuration does not use', () => {
  const bare = capabilities.requirementsFor(['target'], { target: { monsters: [], luring: {} } });
  assert.deepEqual(bare.commands.sort(), ['attack', 'stop'], 'sem combo/lure/PokeStop');

  const withCombo = capabilities.requirementsFor(['target'], {
    target: { monsters: [], luring: {}, combo: { enabled: true, useNativeSequence: true } } });
  assert.ok(withCombo.commands.includes('combo'), 'combo nativo manda !autocombo');
  assert.ok(!withCombo.commands.includes('hotkey'));

  const enumerated = capabilities.requirementsFor(['target'], {
    target: { monsters: [], luring: {}, combo: { enabled: true, useNativeSequence: false } } });
  assert.ok(enumerated.commands.includes('talk'), 'combo enumerado usa talk');
  assert.ok(!enumerated.commands.includes('combo'));

  const revive = capabilities.requirementsFor(['target'], {
    target: { monsters: [], luring: {}, autoRevive: { enabled: true, hotkey: 'f' } } });
  assert.ok(revive.commands.includes('hotkey'), 'autoRevive usa hotkey');
  assert.ok(!revive.commands.includes('revive'), 'nunca exige revive');

  const stop = capabilities.requirementsFor(['target'], {
    target: { monsters: [], luring: {}, combo: { enabled: true, usePokeStop: true } } });
  assert.ok(stop.commands.includes('talk'), 'PokeStop usa talk');
});

test('capture capability does not block target activation', () => {
  const { requirements } = capabilities.requirementsFor(['target'], {
    target: { monsters: [], luring: {} }, looting: { captureEnabled: true } });
  const missing = capabilities.evaluate(requirements, capabilities.parseDeclaration(NATIVE_DECLARATION));
  assert.equal(missing.ok, true);
  assert.ok(!requirements.some(entry => entry.commands.includes('useWith')));
});

test('luring mode comes from normalizeLuring, not a local copy', () => {
  const { normalizeLuring } = require('../reconstruction/engines/lure-engine.cjs');
  /* maxDistance fora do limite: a copia antiga usava 30, o lure-engine usa 16.
   * Se capabilities tivesse copia propria, o modo poderia divergir. */
  const config = { target: { luring: { frontEnabled: true, maxDistance: 25 } } };
  assert.equal(normalizeLuring(config).mode, 'dynamic');
  const { requirements } = capabilities.requirementsFor(['target'], config);
  assert.ok(requirements.some(entry => entry.feature === 'dynamic-lure'));
});

/* --------------------------------------- 4. retirada e restauracao de capacidades */

test('removing a capability mid-session blocks before the engine advances', async () => {
  const { pid, server, transport } = strictPair();
  const runtime = new EngineRuntime({ automatic: false,
    openAdapter: context => nativeAdapter.open(context, { transport, capabilityTimeoutMs: 2000 }) });
  await server.start();
  try {
    await runtime.setModules('walker', true, pid, walkerConfig());
    server.publishState(stateBytes());
    const received = once(transport, 'telemetry');
    server.publishTelemetry(telemetry());
    await received;
    await runtime.tick();
    const before = server.commands.length;
    assert.ok(before > 0, 'andou antes da retirada');

    /* Servidor republica declaracao sem `stop`. */
    transport.emit('declaration', { contract: 'pka-capabilities', version: 1,
      commands: ['walk', 'talk'] });
    const result = await runtime.tick();
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'capability-lost');
    assert.equal(server.commands.length, before, 'nada novo foi despachado');
    assert.equal(runtime.state.interrupt, 'unconfirmed-no-stop',
      'sem stop nao declaramos parada confirmada');
  } finally {
    await runtime.close();
    await server.close();
  }
});

test('a restored capability does not resume by itself', async () => {
  const { pid, server, transport } = strictPair();
  const runtime = new EngineRuntime({ automatic: false,
    openAdapter: context => nativeAdapter.open(context, { transport, capabilityTimeoutMs: 2000 }) });
  await server.start();
  try {
    await runtime.setModules('walker', true, pid, walkerConfig());
    transport.emit('declaration', { contract: 'pka-capabilities', version: 1, commands: ['walk'] });
    await runtime.tick();
    assert.equal(runtime.state.paused, true);

    /* Capacidade volta. */
    transport.emit('declaration', { contract: 'pka-capabilities', version: 1,
      commands: [...capabilities.NATIVE_COMMANDS] });
    const result = await runtime.tick();
    assert.equal(result, null, 'nao retoma sozinho');
    assert.equal(runtime.state.paused, true);
    await assert.rejects(runtime.togglePause(), /reative o modulo/);
  } finally {
    await runtime.close();
    await server.close();
  }
});

/* ------------------------------------ 5. fixture sem contrato nao vira valid */

test('an adapter exposing only supportedCommands gets no implicit validity', async () => {
  const { EventEmitter } = require('node:events');
  const adapter = Object.assign(new EventEmitter(), {
    supportedCommands: ['walk', 'attack', 'stop'],
    /* sem capabilities() */
    getSnapshot: () => ({ pid: 10, online: true, ageMs: 0, telemetry: telemetry() }),
    command: async () => true, pauseWalker: async () => true, close: async () => {},
  });
  const runtime = new EngineRuntime({ automatic: false, openAdapter: async () => adapter });
  const state = await runtime.setModules('walker', true, 10, walkerConfig());
  assert.equal(state.status, 'blocked');
  assert.equal(state.reason, 'capability-missing');
  assert.deepEqual(runtime.modules, []);
  await runtime.close();
});

/* --------------------------------------------- 6. declaracao e diagnostico */

test('an unknown command name in the declaration is not usable', () => {
  const parsed = capabilities.parseDeclaration({ contract: 'pka-capabilities', version: 1,
    commands: ['walk', 'stop', 'teletransporte'] });
  assert.deepEqual(parsed.commands, ['walk', 'stop']);
  assert.deepEqual(parsed.unrecognised, ['teletransporte']);
});

test('revive is rejected by the encoder even if declared', () => {
  /* Prova contra a implementacao, nao contra uma lista nossa. */
  const { encodeCommand } = require('../reconstruction/protocol.cjs');
  assert.throws(() => encodeCommand(1, 'revive', 0), /n.o suportados/);
  const parsed = capabilities.parseDeclaration({ contract: 'pka-capabilities', version: 1,
    commands: ['walk', 'stop', 'revive'] });
  assert.deepEqual(parsed.unrecognised, ['revive'], 'declarar revive nao habilita');
});

test('a declaration without a valid server name is still accepted but flagged', () => {
  const parsed = capabilities.parseDeclaration({ contract: 'pka-capabilities', version: 1,
    commands: ['walk', 'stop'] });
  assert.equal(parsed.state, 'valid');
  assert.equal(parsed.server, null);
  assert.equal(parsed.serverValid, false, 'server nao e prova de autenticidade');
});

test('the server name never grants capability', () => {
  const named = capabilities.parseDeclaration({ contract: 'pka-capabilities', version: 1,
    server: 'pka_native', commands: ['walk'] });
  assert.deepEqual(named.commands, ['walk'], 'nome nao acrescenta comando');
  const absent = capabilities.parseDeclaration({ contract: 'pka-capabilities', version: 1,
    commands: ['walk'] });
  assert.deepEqual(absent.commands, named.commands, 'identificacao nao muda o conjunto');
});
