'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { EngineRuntime } = require('../reconstruction/engine-runtime.cjs');
const { rpmSession } = require('../reconstruction/live-session.cjs');
const { open, channelKey } = require('../reconstruction/native-adapter.cjs');
const { Transport } = require('../reconstruction/transport.cjs');
const { RuntimeServer } = require('../reconstruction/runtime-server.cjs');
const { COMMANDS } = require('../reconstruction/protocol.cjs');
const { Controller } = require('../reconstruction/controller.cjs');
const { encodeCommand } = require('../reconstruction/protocol.cjs');

const creature = { id: 12, name: 'Wild', type: 1, pos: { x: 101, y: 100, z: 7 }, healthPercent: 70, canAttack: true };
const configuration = () => ({ target: { monsters: ['*'], skills: [
  { key: 'F1', cooldownMs: 0 }, { key: 'F2', cooldownMs: 0 }], maxDistance: 8 },
  healer: { healHpPercent: 50, healPokemonName: 'Charizard', healMoveSlot: 1, healResetSlot: 1 },
  hoenn: { potionHpPercent: 50, potionHotkey: 'F12' },
  walker: { waypoints: [{ action: 'walk', pos: { x: 105, y: 100, z: 7 } }] } });
const telemetry = () => ({ schema: 2, nativeVerified: true, pulseVersion: 3, tick: 1, playerId: 1,
  fightMode: 0, chaseMode: 0, clockMs: 1, position: { x: 100, y: 100, z: 7 }, healthPercent: 100,
  activeSlot: 1, moves: [], nativeSequence: [], pokemonName: 'Charizard', comboPokemonName: 'Charizard',
  conditionEvents: true, conditionsKnown: true, conditions: [], roster: [{ slot: 1, uuid: 'uuid', name: 'Charizard', healthPercent: 100, moves: null }],
  creatures: [structuredClone(creature)], items: [], tiles: [] });

/* Declaracao explicita do fixture. R1.5: `supportedCommands` sozinho NAO vira
 * contrato — o runtime le `capabilities()`. A lista cobre todo o vocabulario
 * do encoder para que estes testes exercitem os motores, nao a compatibilidade
 * (que tem suite propria em tests/capabilities.test.cjs). */
const FIXTURE_DECLARATION = Object.freeze({
  contract: 'pka-capabilities', version: 1, server: 'engine-runtime-fixture',
  commands: Object.keys(COMMANDS),
});

function fixture(options = {}) {
  let timestamp = 10000;
  const commands = [];
  const pauses = [];
  let session = { pid: 10, online: true, ageMs: 0, telemetry: telemetry() };
  const adapter = Object.assign(new EventEmitter(), {
    supportedCommands: [...FIXTURE_DECLARATION.commands],
    capabilities: () => require('../reconstruction/capabilities.cjs').parseDeclaration(FIXTURE_DECLARATION),
    getSnapshot: () => structuredClone(session),
    command: async (name, parameter) => { commands.push({ name, parameter, at: timestamp }); return true; },
    pauseWalker: async value => { pauses.push(value); return true; },
    close: async () => {},
  });
  const runtime = new EngineRuntime({ automatic: false, now: () => timestamp, openAdapter: async () => adapter, ...options });
  return { runtime, adapter, commands, pauses, config: configuration(),
    time(value) { timestamp = value; }, session(value) { session = value; }, get sessionValue() { return session; } };
}

test('target-only mode runs the target tick without healing or walking', async () => {
  const item = fixture();
  item.sessionValue.telemetry.healthPercent = 20;
  await item.runtime.setModules('target', true, 10, item.config);
  assert.equal(item.runtime.state.phase, 'Aguardando o jogo');
  assert.equal((await item.runtime.tick()).status, 'combat');
  assert.deepEqual(item.commands.map(value => value.name), ['attack', 'hotkey']);
  assert.equal(item.commands[1].parameter, 'f1');
  await item.runtime.close();
});

test('native target rotates after delivered attack and fresh samples without HP loss', async context => {
  const item = fixture();
  context.after(() => item.runtime.close());
  item.config.target = { monsters: ['*'], maxDistance: 8 };
  const telemetry = item.sessionValue.telemetry;
  telemetry.creatures.push({ ...creature, id: 13, pos: { x: 102, y: 100, z: 7 } });
  const attackIds = () => item.commands.filter(command => command.name === 'attack').map(command => command.parameter);
  await item.runtime.setModules('target', true, 10, item.config);
  await item.runtime.tick();
  assert.deepEqual(attackIds(), [12]);

  item.time(12000);
  await item.runtime.tick();
  assert.ok(attackIds().every(id => id === 12), 'a repeated tick does not count as fresh');
  telemetry.tick += 1;
  await item.runtime.tick();
  assert.ok(attackIds().every(id => id === 12), 'one fresh sample does not rotate');
  telemetry.tick += 1;
  await item.runtime.tick();
  assert.equal(attackIds().at(-1), 13);
});

test('native target keeps a target whose HP drops on a fresh sample', async context => {
  const item = fixture();
  context.after(() => item.runtime.close());
  item.config.target = { monsters: ['*'], maxDistance: 8 };
  const telemetry = item.sessionValue.telemetry;
  telemetry.creatures.push({ ...creature, id: 13, pos: { x: 102, y: 100, z: 7 } });
  await item.runtime.setModules('target', true, 10, item.config);
  await item.runtime.tick();
  item.time(11000);
  telemetry.tick += 1;
  await item.runtime.tick();
  item.time(12000);
  telemetry.tick += 1;
  telemetry.creatures[0].healthPercent -= 10;
  await item.runtime.tick();
  assert.equal(item.commands.filter(command => command.name === 'attack').at(-1)?.parameter, 12);
});

test('walker-only mode sends a real engine walk decision, not a target command', async () => {
  const item = fixture();
  await item.runtime.setModules('walker', true, 10, item.config);
  await item.runtime.tick();
  assert.deepEqual(item.commands.map(value => value.name), ['walk']);
  await item.runtime.pause();
  assert.deepEqual(item.pauses, [true]);
  assert.equal(await item.runtime.tick(), null);
});

test('the periodic runtime timer drives the engines after activation', { timeout: 2000 }, async context => {
  const item = fixture({ automatic: true, intervalMs: 10 });
  context.after(() => item.runtime.close());
  let dispatched;
  const sent = new Promise(resolve => { dispatched = resolve; });
  item.adapter.command = async (name, parameter) => {
    item.commands.push({ name, parameter });
    dispatched();
    return true;
  };
  await item.runtime.setModules('target', true, 10, item.config);
  let timer;
  try {
    await Promise.race([sent, new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(Error('Timer nao executou o tick.')), 1000);
    })]);
    assert.equal(item.commands[0].name, 'attack');
  } finally { clearTimeout(timer); }
});

test('healer-only mode emits the potion hotkey at low Pokemon HP', async () => {
  const item = fixture();
  item.sessionValue.telemetry.ownPokemon = { healthPercent: 30 };
  await item.runtime.setModules('healer', true, 10, item.config);
  await item.runtime.tick();
  assert.deepEqual(item.commands.map(value => [value.name, value.parameter]), [['hotkey', 'F12']]);
  await item.runtime.close();
});

test('healer dispatches a numeric potion without requiring action', async context => {
  const item = fixture();
  context.after(() => item.runtime.close());
  item.adapter.supportedCommands = ['potion', 'stop'];
  item.adapter.capabilities = () => require('../reconstruction/capabilities.cjs')
    .parseDeclaration({ ...FIXTURE_DECLARATION, commands: ['potion', 'stop'] });
  item.config.healer = {};
  item.config.hoenn = { potionHpPercent: 60, potionActionBar: 3 };
  item.sessionValue.telemetry.ownPokemon = { healthPercent: 30 };

  await item.runtime.setModules('healer', true, 10, item.config);
  assert.deepEqual(item.runtime.modules, ['healer'], JSON.stringify(item.runtime.state));
  const result = await item.runtime.tick();
  assert.equal(result?.status, 'heal', JSON.stringify(result));
  assert.deepEqual(item.commands.map(({ name, parameter }) => [name, parameter]), [['potion', 3]]);
});

test('null or missing HP is not treated as zero by the healer', async () => {
  for (const health of [null, undefined, '20', -1, 101]) {
    const item = fixture();
    item.sessionValue.telemetry.healthPercent = health;
    await item.runtime.setModules('healer', true, 10, item.config);
    assert.equal((await item.runtime.tick()).status, 'idle');
    assert.deepEqual(item.commands, []);
    await item.runtime.close();
  }
});

test('global cooldown survives module toggles and uses actual dispatch time', async () => {
  const item = fixture();
  item.adapter.command = async (name, parameter) => {
    item.commands.push({ name, parameter });
    if (name === 'attack') item.time(10100);
    return true;
  };
  await item.runtime.setModules('target', true, 10, item.config);
  await item.runtime.tick();
  item.time(10300);
  await item.runtime.tick();
  assert.equal(item.commands.filter(value => value.name === 'hotkey').length, 1);
  await item.runtime.setModules('target', true, 10, item.config);
  item.time(10349);
  await item.runtime.tick();
  assert.equal(item.commands.filter(value => value.name === 'hotkey').length, 1);
  item.time(10350);
  await item.runtime.tick();
  assert.equal(item.commands.filter(value => value.name === 'hotkey').length, 2);
  await item.runtime.close();
});

test('new connection waits for telemetry and stale telemetry stops the walker', async () => {
  const item = fixture();
  const session = item.sessionValue;
  item.session(null);
  await item.runtime.setModules('walker', true, 10, item.config);
  assert.equal((await item.runtime.tick()).reason, 'no-telemetry');
  item.session(session);
  await item.runtime.tick();
  session.stale = true;
  assert.equal((await item.runtime.tick()).reason, 'stale');
  assert.deepEqual(item.pauses, [true]);
  assert.equal(item.commands.length, 1);
  await item.runtime.close();
});

test('individual skill cooldown starts at dispatch, not at the earlier target decision', async () => {
  const item = fixture();
  item.config.target.skills = [{ key: 'F1', cooldownMs: 1000 }];
  let delayFirstAttack = true;
  item.adapter.command = async (name, parameter) => {
    item.commands.push({ name, parameter });
    if (name === 'attack' && delayFirstAttack) {
      delayFirstAttack = false;
      item.time(10100);
    }
    return true;
  };
  await item.runtime.setModules('target', true, 10, item.config);
  await item.runtime.tick();
  item.time(11099);
  await item.runtime.tick();
  assert.equal(item.commands.filter(value => value.name === 'hotkey').length, 1);
  item.time(11100);
  await item.runtime.tick();
  assert.equal(item.commands.filter(value => value.name === 'hotkey').length, 2);
  await item.runtime.close();
});

test('failed connection never enables modules and unsupported modules do not open a channel', async () => {
  const runtime = new EngineRuntime({ automatic: false, openAdapter: async () => { throw Error('Canal ausente'); } });
  await assert.rejects(runtime.setModules('scripts', true, 10, configuration()), /Modulo/);
  await assert.rejects(runtime.setModules('target', true, 10, configuration()), /Canal ausente/);
  assert.deepEqual(runtime.state.modules, []);
  assert.equal(runtime.state.paused, true);
  await runtime.close();
});

test('rejected command pauses, closes, and is never automatically retried', async () => {
  const item = fixture();
  let closed = 0;
  item.adapter.close = async () => { closed++; };
  item.adapter.command = async () => false;
  await item.runtime.setModules('target', true, 10, item.config);
  assert.equal((await item.runtime.tick()).status, 'error');
  assert.equal(item.runtime.state.paused, true);
  assert.equal(await item.runtime.tick(), null);
  await Promise.resolve();
  assert.equal(closed, 1);
});

test('stale target telemetry cancels the previously commanded attack once', async () => {
  const item = fixture();
  await item.runtime.setModules('target', true, 10, item.config);
  await item.runtime.tick();
  item.sessionValue.stale = true;
  await item.runtime.tick();
  await item.runtime.tick();
  assert.deepEqual(item.pauses, [true]);
  assert.equal(item.commands.length, 2);
  await item.runtime.close();
});

test('an unsupported command invalidates the entire batch before any command is sent', async () => {
  /* O lote e' validado ANTES do primeiro envio: se algum comando do tick nao
   * estiver declarado pelo servidor, nada sai — nem os anteriores. */
  const item = fixture();
  await item.runtime.setModules('target', true, 10, item.config);
  /* Declaracao encolhe depois da partida: simula servidor que deixou de
   * anunciar um comando que o motor ainda emite. */
  item.adapter.supportedCommands.length = 0;
  item.adapter.supportedCommands.push('attack', 'talk', 'stop');
  item.sessionValue.telemetry.healthPercent = 20; // forca hotkey no lote
  await item.runtime.tick();
  assert.deepEqual(item.commands, [], 'nenhum comando do lote pode sair');
});

test('a capability-missing startup is refused before any automation command', async () => {
  const item = fixture();
  /* Target exige attack + stop; sem `stop` a partida e' recusada. */
  item.adapter.capabilities = () => require('../reconstruction/capabilities.cjs')
    .parseDeclaration({ contract: 'pka-capabilities', version: 1, commands: ['attack'] });
  item.adapter.supportedCommands.length = 0;
  item.adapter.supportedCommands.push('attack');
  const state = await item.runtime.setModules('target', true, 10, item.config);
  assert.equal(state.status, 'blocked');
  assert.equal(state.reason, 'capability-missing');
  assert.match(state.error, /stop/);
  assert.deepEqual(item.commands, []);
  assert.deepEqual(item.runtime.modules, [], 'nenhum modulo sobe incompativel');
  assert.equal(item.runtime.state.paused, true);
});

test('a walk-only server without stop never starts movement', async () => {
  const item = fixture();
  item.adapter.capabilities = () => require('../reconstruction/capabilities.cjs')
    .parseDeclaration({ contract: 'pka-capabilities', version: 1, commands: ['walk', 'talk'] });
  item.adapter.supportedCommands.length = 0;
  item.adapter.supportedCommands.push('walk', 'talk');
  const state = await item.runtime.setModules('walker', true, 10, item.config);
  assert.equal(state.status, 'blocked');
  assert.match(state.error, /stop/);
  assert.deepEqual(item.commands, []);
  assert.deepEqual(item.runtime.modules, []);
});

test('a joint target+walker request is refused whole, not partially started', async () => {
  const item = fixture();
  /* `talk` presente, `stop` ausente: target e walker exigem stop. */
  item.adapter.capabilities = () => require('../reconstruction/capabilities.cjs')
    .parseDeclaration({ contract: 'pka-capabilities', version: 1,
      commands: ['attack', 'talk', 'walk', 'hotkey', 'combo', 'switchPokemon', 'potion'] });
  item.adapter.supportedCommands.length = 0;
  item.adapter.supportedCommands.push('attack', 'talk', 'walk', 'hotkey', 'combo', 'switchPokemon', 'potion');
  const config = { ...item.config, walker: { waypoints: [{ action: 'walk', pos: { x: 105, y: 100, z: 7 } }] } };
  const state = await item.runtime.setModules('all', true, 10, config);
  assert.equal(state.status, 'blocked');
  assert.deepEqual(item.runtime.modules, [], 'nao sobe so o Walker');
  assert.deepEqual(item.commands, [], 'nenhum comando de automacao');
  assert.match(state.error, /stop/);
});

test('the same walker alone starts when the joint request was refused', async () => {
  const item = fixture();
  item.adapter.capabilities = () => require('../reconstruction/capabilities.cjs')
    .parseDeclaration({ contract: 'pka-capabilities', version: 1, commands: ['walk', 'stop'] });
  item.adapter.supportedCommands.length = 0;
  item.adapter.supportedCommands.push('walk', 'stop');
  const config = { ...item.config, walker: { waypoints: [{ action: 'walk', pos: { x: 105, y: 100, z: 7 } }] } };
  const state = await item.runtime.setModules('walker', true, 10, config);
  assert.deepEqual(item.runtime.modules, ['walker'], 'Walker isolado compativel sobe');
  assert.notEqual(state.status, 'blocked');
  assert.notEqual(state.paused, true);
});

test('overlapping ticks do not duplicate commands and pause cancels the rest of a batch', async () => {
  const item = fixture();
  let release;
  item.adapter.command = () => new Promise(resolve => { release = resolve; });
  await item.runtime.setModules('target', true, 10, item.config);
  const pending = item.runtime.tick();
  await Promise.resolve();
  assert.equal(await item.runtime.tick(), null);
  const paused = item.runtime.pause();
  release(true);
  await pending;
  await paused;
  assert.deepEqual(item.pauses, [true]);
  assert.equal(item.runtime.state.paused, true);
});

test('command timeout stops execution without retry', async () => {
  const item = fixture({ timeoutMs: 15 });
  let calls = 0;
  item.adapter.command = () => { calls++; return new Promise(() => {}); };
  await item.runtime.setModules('target', true, 10, item.config);
  assert.match((await item.runtime.tick()).error, /Timeout/);
  assert.equal(await item.runtime.tick(), null);
  assert.equal(calls, 1);
});

test('PID changes and invalid modules are blocked before dispatch', async () => {
  const item = fixture();
  await assert.rejects(item.runtime.setModules('capture', true, 10, item.config), /Modulo/);
  await item.runtime.setModules('target', true, 10, item.config);
  item.sessionValue.pid = 99;
  assert.match((await item.runtime.tick()).error, /PID/);
  assert.deepEqual(item.commands, []);
});

test('a stale external creature source never falls back to native creatures', async () => {
  const item = fixture({ creatureSource: () => { throw Error('Stream expirado'); } });
  await item.runtime.setModules('target', true, 10, item.config);
  assert.match((await item.runtime.tick()).error, /Stream expirado/);
  assert.deepEqual(item.commands, []);
});

test('RPM session shows only observed data, with independent creature freshness', () => {
  const raw = { pid: 10, generatedAt: new Date(10000).toISOString(), player: { name: 'Player', pos: { x: 1, y: 2, z: 7 } },
    creatures: [creature], creaturesGeneratedAt: new Date(8000).toISOString() };
  const session = rpmSession(raw, 10000);
  assert.equal(session.online, true);
  assert.equal(session.healthPercent, undefined);
  assert.equal(session.telemetry.nativeVerified, false);
  assert.equal(session.telemetry.pulseVersion, undefined);
  assert.deepEqual(session.telemetry.creatures, []);
  raw.creaturesGeneratedAt = raw.generatedAt;
  assert.equal(rpmSession(raw, 10000).telemetry.creatures.length, 1);
  assert.equal(rpmSession(raw, 12000).online, false);
  assert.equal(rpmSession(raw, 9000), null);
  assert.equal(rpmSession({ ...raw, player: null }, 10000), null);
});

test('channel key is required instead of fabricated execution', () => {
  assert.throws(() => channelKey(10, {}), /Configure PKA_CHANNEL_KEY/);
});

test('controller start-all, pause, resume and stop-all control the actual engine runtime', async () => {
  const item = fixture();
  const state = { activeProfile: 'Default', profiles: [{ name: 'Default', config: item.config }] };
  const controller = new Controller({ snapshot: () => structuredClone(state) }, { runtime: item.runtime });
  const started = await controller.invoke('pka:runtime', 'all', true, 10, item.config, 1);
  assert.deepEqual(started.runtime.modules, ['target', 'walker', 'healer']);
  assert.equal(started.runtime.paused, false);
  assert.notEqual(started.runtime.phase, 'Executando');
  await item.runtime.tick();
  assert.equal(item.commands.length, 2);
  assert.equal((await controller.invoke('pka:pause')).runtime.paused, true);
  assert.equal((await controller.invoke('pka:pause')).runtime.paused, false);
  const stopped = await controller.invoke('pka:runtime', 'all', false, 10, item.config, 1);
  assert.deepEqual(stopped.runtime.modules, []);
  assert.equal(stopped.runtime.paused, true);
  await item.runtime.close();
});

test('profile changes pause execution before saving the profile', async () => {
  const item = fixture();
  const state = { activeProfile: 'Default', profiles: [{ name: 'Default', config: item.config }] };
  const store = { snapshot: () => structuredClone(state), save: async () => {
    assert.equal(item.runtime.state.paused, true);
  } };
  const controller = new Controller(store, { runtime: item.runtime });
  await controller.invoke('pka:runtime', 'target', true, 10, item.config, 1);
  await controller.invoke('pka:autosave', 'Default', item.config, 1);
  assert.equal(item.runtime.state.paused, true);
  await item.runtime.close();
});

test('stream failure stops a previously commanded walker before closing the channel', async () => {
  let fail = false;
  const item = fixture({ creatureSource: () => {
    if (fail) throw Error('Stream expirado');
    return { schema: 2, pid: 10, generatedAt: new Date(10000).toISOString(), creatures: [] };
  } });
  await item.runtime.setModules('walker', true, 10, item.config);
  await item.runtime.tick();
  fail = true;
  assert.match((await item.runtime.tick()).error, /Stream expirado/);
  assert.deepEqual(item.pauses, [true]);
});

test('native adapter combines state HP and telemetry and rejects nonzero ACK status', async () => {
  const transport = Object.assign(new EventEmitter(), {
    connect: async () => {}, close: () => {}, sendCommand: async () => ({ status: 5 }),
  });
  let now = 10000;
  const adapter = await open({ pid: 10 }, { transport, now: () => now });
  assert.equal(adapter.getSnapshot(), null);
  /* Sem declaracao no transporte, nenhum comando e' habilitado. */
  assert.deepEqual(adapter.supportedCommands, []);
  await assert.rejects(adapter.command('attack', 12), /Comando sem suporte/);
  transport.emit('declaration', { contract: 'pka-capabilities', version: 1,
    commands: ['walk', 'attack', 'stop', 'talk', 'combo', 'switchPokemon', 'potion', 'hotkey'] });
  assert.ok(adapter.supportedCommands.includes('attack'));
  transport.emit('state', { online: true, healthPercent: 37 });
  transport.emit('telemetry', telemetry());
  assert.equal(adapter.getSnapshot().telemetry.healthPercent, 37);
  now = 11001;
  assert.equal(adapter.getSnapshot().stale, true);
  await assert.rejects(adapter.command('attack', 12), /status 5/);
  await assert.rejects(adapter.command('attack', 12, { pid: 20 }), /PID/);
  await adapter.close();
});

test('capabilities do not survive a reconnection', async () => {
  const transport = Object.assign(new EventEmitter(), {
    connect: async () => {}, close: () => {}, sendCommand: async () => ({ status: 0 }),
  });
  const first = await open({ pid: 10 }, { transport, now: () => 10000 });
  transport.emit('declaration', { contract: 'pka-capabilities', version: 1,
    commands: ['walk', 'attack', 'stop', 'talk', 'combo', 'switchPokemon', 'potion', 'hotkey'] });
  assert.equal(first.supportedCommands.length, 8);
  await first.close();
  const second = await open({ pid: 10 }, { transport, now: () => 10000 });
  assert.deepEqual(second.supportedCommands, [], 'sessao nova nao herda capacidades');
  await second.close();
});

test('a declaration received after connect is not lost', async () => {
  /* kind 6 pode chegar DEPOIS do welcome. O adapter espera de forma limitada
   * e passa a habilitar o que foi declarado. */
  const transport = Object.assign(new EventEmitter(), {
    connect: async () => {}, close: () => {}, sendCommand: async () => ({ status: 0 }),
  });
  const pending = open({ pid: 10 }, { transport, now: () => 10000, capabilityTimeoutMs: 500 });
  setImmediate(() => transport.emit('declaration', { contract: 'pka-capabilities', version: 1,
    commands: ['walk', 'attack'] }));
  const adapter = await pending;
  assert.deepEqual(adapter.supportedCommands, ['walk', 'attack']);
  await adapter.close();
});

test('an unknown contract declaration grants no command', async () => {
  const transport = Object.assign(new EventEmitter(), {
    connect: async () => {}, close: () => {}, sendCommand: async () => ({ status: 0 }),
  });
  const adapter = await open({ pid: 10 }, { transport, now: () => 10000 });
  transport.emit('declaration', { contract: 'fornecedor-x', version: 9, commands: ['walk', 'chase'] });
  assert.deepEqual(adapter.supportedCommands, []);
  assert.equal(adapter.capabilities().state, 'unknown');
  await assert.rejects(adapter.command('walk', 0), /Comando sem suporte/);
  await adapter.close();
});

test('ack status 4 of our contract is diagnosed as unsupported', async () => {
  const transport = Object.assign(new EventEmitter(), {
    connect: async () => {}, close: () => {}, sendCommand: async () => ({ status: 4 }),
  });
  const adapter = await open({ pid: 10 }, { transport, now: () => 10000 });
  transport.emit('declaration', { contract: 'pka-capabilities', version: 1,
    commands: ['walk', 'attack', 'stop', 'talk', 'combo', 'switchPokemon', 'potion', 'hotkey'] });
  const error = await adapter.command('attack', 12).then(() => null, value => value);
  assert.ok(error instanceof Error);
  assert.equal(error.statusCode, 4);
  assert.equal(error.statusInterpreted, true);
  assert.match(error.message, /nao suportada/, 'nao deve dizer "identidade do Pokemon mudou"');
  await adapter.close();
});

test('an unknown contract keeps the raw ack code with a neutral message', async () => {
  const transport = Object.assign(new EventEmitter(), {
    connect: async () => {}, close: () => {}, sendCommand: async () => ({ status: 4 }),
  });
  const adapter = await open({ pid: 10 }, { transport, now: () => 10000 });
  transport.emit('declaration', { contract: 'desconhecido', version: 1, commands: ['attack'] });
  /* Contrato desconhecido nao habilita nada; forcamos a lista para exercitar
   * apenas a MENSAGEM do ACK. */
  adapter.supportedCommands.push('attack');
  const error = await adapter.command('attack', 12).then(() => null, value => value);
  assert.equal(error.statusCode, 4);
  assert.equal(error.statusInterpreted, false);
  assert.match(error.message, /codigo 4/);
  await adapter.close();
});

test('integrated engine exchanges actual protocol frames and positive ACKs with a local fixture server', async () => {
  const pid = 52000 + (process.pid % 1000);
  const key = 'engine-runtime-test-fixture';
  /* Fixture de TRANSPORTE (auto-ACK generico): prova framing e ACK, nao
   * implementacao de comando. A declaracao existe para o adapter habilitar os
   * comandos que o motor emite. */
  const declaration = { contract: 'pka-capabilities', version: 1, server: 'fixture',
    commands: ['walk', 'attack', 'stop', 'talk', 'combo', 'switchPokemon', 'potion', 'hotkey'] };
  const server = new RuntimeServer({ pid, key, declaration });
  const transport = new Transport({ pid, key });
  const runtime = new EngineRuntime({ automatic: false,
    openAdapter: context => open(context, { transport, capabilityTimeoutMs: 2000 }) });
  await server.start();
  try {
    await runtime.setModules('target', true, pid, configuration());
    const received = once(transport, 'telemetry');
    const state = Buffer.alloc(48);
    state.writeUInt32LE(1, 0);
    state.writeUInt32LE(1, 4);
    state.writeUInt32LE(100, 8);
    server.publishState(state);
    server.publishTelemetry(telemetry());
    await received;
    assert.equal((await runtime.tick()).status, 'combat');
    assert.deepEqual(server.commands.map(command => command.payload.readUInt32LE(4)), [COMMANDS.attack, COMMANDS.hotkey]);
    await runtime.pause();
    assert.equal(server.commands.at(-1).payload.readUInt32LE(4), COMMANDS.stop);
  } finally {
    await runtime.close();
    await server.close();
  }
});


test('runtime dispatches native fallback through the actual protocol encoder', async () => {
  const item = fixture();
  delete item.config.target.skills;
  item.config.target.combo = { enabled: true, useNativeSequence: true };
  item.adapter.command = async (name, parameter, context) => {
    encodeCommand(1, name, parameter, context.extra);
    item.commands.push({ name, parameter });
    return true;
  };
  await item.runtime.setModules('target', true, 10, item.config);
  assert.equal((await item.runtime.tick()).status, 'combat');
  assert.deepEqual(item.commands.map(event => [event.name, event.parameter]), [['attack', 12], ['combo', '!autocombo']]);
  await item.runtime.close();
});

test('native sequence sends Medicine, AutoCombo and Revive once before yielding remaining targets', async context => {
  const item = fixture();
  context.after(() => item.runtime.close());
  const { target } = item.config;
  delete target.skills;
  target.combo = { enabled: true, useNativeSequence: true, nativeHotkey: 'C',
    useMedicineBeforeCombo: true, medicineHotkey: 'E', medicineDelayMs: 500,
    stepDelay: 250, finishRemainingCount: 1 };
  target.autoRevive = { enabled: true, hotkey: 'F', interval: 500, waitForPokemon: true };
  item.config.hoenn.comboFallbackMs = 500;
  await item.runtime.setModules('all', true, 10, item.config);
  const hotkeys = () => item.commands.filter(event => event.name === 'hotkey').map(event => event.parameter);
  await item.runtime.tick();
  assert.deepEqual(hotkeys(), ['E']);
  item.time(10499);
  await item.runtime.tick();
  assert.deepEqual(hotkeys(), ['E']);
  item.time(10500);
  await item.runtime.tick();
  assert.deepEqual(hotkeys(), ['E', 'C']);
  item.time(11000);
  await item.runtime.tick();
  assert.deepEqual(hotkeys(), ['E', 'C', 'F']);
  item.time(11300);
  assert.equal((await item.runtime.tick()).reason, 'await-active-pokemon', 'same sample cannot confirm Revive');
  item.sessionValue.telemetry.tick += 1;
  item.time(11400);
  const resumed = await item.runtime.tick();
  assert.equal(resumed.status, 'walking');
  assert.equal(resumed.reason, 'finish-remaining');
  assert.deepEqual(hotkeys(), ['E', 'C', 'F']);
});

test('runtime runs combo to revive with enemies visible and records timeout', async () => {
  const item = fixture();
  delete item.config.target.skills;
  item.config.target.combo = { enabled: true, sequenceText: 'm1, m2', stepDelay: 250 };
  item.config.target.autoRevive = { enabled: true, hotkey: 'F9', interval: 1500, waitForPokemon: true };
  await item.runtime.setModules('all', true, 10, item.config);
  await item.runtime.tick();
  item.time(10250);
  assert.equal((await item.runtime.tick()).status, 'revive');
  item.time(11749);
  await item.runtime.tick();
  assert.ok(!item.commands.some(event => event.parameter === 'F9'));
  item.time(11750);
  await item.runtime.tick();
  assert.equal(item.commands.filter(event => event.parameter === 'F9').length, 1);
  item.time(15000);
  Object.assign(item.sessionValue.telemetry, { pokemonName: '', activeSlot: 0, roster: [], creatures: [] });
  assert.equal((await item.runtime.tick()).reason, 'revive-timeout');
  item.time(15001);
  assert.equal((await item.runtime.tick()).status, 'walking');
  assert.equal(item.commands.filter(event => event.parameter === 'F9').length, 1);
  await item.runtime.close();
});

/* ============================================================================
 * G04-R2 — interromper acoes apos retirada de capacidade
 * ========================================================================= */

/* Declaracao mutavel: os testes trocam a lista para simular retirada. */
function capabilityFixture(commands = [...FIXTURE_DECLARATION.commands]) {
  const item = fixture();
  const capabilities = require('../reconstruction/capabilities.cjs');
  let list = [...commands];
  item.setCommands = next => {
    list = [...next];
    item.adapter.supportedCommands.length = 0;
    item.adapter.supportedCommands.push(...list);
  };
  item.adapter.capabilities = () => capabilities.parseDeclaration({
    contract: 'pka-capabilities', version: 1, server: 'engine-runtime-fixture', commands: list });
  item.setCommands(list);
  return item;
}

const WALKER_ONLY = () => ({ ...configuration(),
  walker: { waypoints: [{ action: 'walk', pos: { x: 105, y: 100, z: 7 } }] } });

test('an attack already dispatched is interrupted once when attack is withdrawn', async () => {
  const item = capabilityFixture();
  await item.runtime.setModules('target', true, 10, item.config);
  await item.runtime.tick();                     // entrega attack
  const attacks = item.commands.filter(entry => entry.name === 'attack').length;
  assert.equal(attacks, 1, 'ataque entregue antes da retirada');

  /* `attack` sai da declaracao; `stop` continua disponivel. */
  item.setCommands([...FIXTURE_DECLARATION.commands].filter(name => name !== 'attack'));
  const result = await item.runtime.tick();

  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'capability-lost');
  assert.equal(item.commands.filter(entry => entry.name === 'attack').length, attacks,
    'nenhum ataque novo');
  assert.equal(item.pauses.length, 1,
    'uma parada solicitada');
  assert.equal(result.interruption.stop, 'acked');
  assert.equal(result.interruption.physicalProof, false,
    'ACK do stop nao e prova de parada fisica');
  assert.equal(result.interruption.localPaused, true);
  assert.match(result.error, /attack/, 'motivo original preservado');
});

test('movement already dispatched is interrupted once when a required capability is withdrawn', async () => {
  const item = capabilityFixture();
  await item.runtime.setModules('walker', true, 10, WALKER_ONLY());
  await item.runtime.tick();
  assert.ok(item.commands.some(entry => entry.name === 'walk'), 'andou antes');

  /* `stop` continua; `talk` sai (o Walker so' o usa com waypoint `say`, mas a
   * retirada de `walk` e' o caso mais direto). */
  item.setCommands([...FIXTURE_DECLARATION.commands].filter(name => name !== 'walk'));
  const result = await item.runtime.tick();

  assert.equal(result.status, 'blocked');
  assert.equal(item.commands.filter(entry => entry.name === 'walk').length, 1,
    'nenhum walk novo');
  assert.equal(item.pauses.length, 1);
  assert.equal(result.interruption.stop, 'acked');
  assert.match(result.error, /walk/);
});

test('without stop nothing impossible is sent and the stop stays unconfirmed', async () => {
  const item = capabilityFixture();
  await item.runtime.setModules('target', true, 10, item.config);
  await item.runtime.tick();

  /* `stop` e `attack` saem juntos. */
  item.setCommands(['talk', 'combo', 'switchPokemon', 'potion', 'hotkey']);
  const result = await item.runtime.tick();

  assert.equal(result.status, 'blocked');
  assert.equal(item.pauses.length, 0,
    'nao envia stop que o servidor nao declara');
  assert.equal(result.interruption.stop, 'not-attempted');
  assert.equal(result.interruption.physicalProof, false);
  assert.equal(item.runtime.state.interrupt, 'unconfirmed-no-stop');
});

test('a rejected stop keeps both causes: capability loss and stop failure', async () => {
  const item = capabilityFixture();
  await item.runtime.setModules('target', true, 10, item.config);
  await item.runtime.tick();
  /* stop declarado mas a execucao recusa. */
  item.adapter.pauseWalker = async () => false;
  item.setCommands([...FIXTURE_DECLARATION.commands].filter(name => name !== 'attack'));
  const result = await item.runtime.tick();

  assert.equal(result.reason, 'capability-lost');
  assert.match(result.error, /attack/, 'primeira causa');
  assert.equal(result.interruption.stop, 'rejected');
  assert.ok(result.interruption.stopError, 'segunda causa registrada');
  assert.equal(result.interruption.physicalProof, false);
  assert.equal(item.runtime.state.interrupt, 'unconfirmed-error');
});

test('a stop timeout also preserves both causes', async () => {
  const item = capabilityFixture();
  item.runtime.timeoutMs = 10;
  await item.runtime.setModules('target', true, 10, item.config);
  await item.runtime.tick();
  item.adapter.pauseWalker = () => new Promise(() => {}); // nunca resolve
  item.setCommands([...FIXTURE_DECLARATION.commands].filter(name => name !== 'attack'));
  const result = await item.runtime.tick();

  assert.match(result.error, /attack/, 'motivo original preservado');
  assert.equal(result.interruption.stop, 'timeout');
  assert.match(result.interruption.stopError, /Timeout/);
});

test('a restored capability leaves the runtime paused', async () => {
  const item = capabilityFixture();
  await item.runtime.setModules('target', true, 10, item.config);
  await item.runtime.tick();
  item.setCommands([...FIXTURE_DECLARATION.commands].filter(name => name !== 'attack'));
  await item.runtime.tick();
  assert.equal(item.runtime.state.paused, true);

  /* Capacidade volta. */
  item.setCommands([...FIXTURE_DECLARATION.commands]);
  assert.equal(await item.runtime.tick(), null, 'nao roda o motor');
  assert.equal(item.runtime.state.paused, true, 'continua pausado');
  await assert.rejects(item.runtime.togglePause(), /reative o modulo/);
});

test('concurrent pause and capability loss do not duplicate the stop', async () => {
  const item = capabilityFixture();
  await item.runtime.setModules('target', true, 10, item.config);
  await item.runtime.tick();

  /* Conta as chamadas reais a pauseWalker: o fixture grava em `pauses`, mas
   * aqui trocamos a funcao e contamos a invocacao, liberando a promessa. */
  let stopCalls = 0;
  let releaseStop;
  item.adapter.pauseWalker = () => {
    stopCalls += 1;
    return new Promise(resolve => { releaseStop = resolve; });
  };
  item.setCommands([...FIXTURE_DECLARATION.commands].filter(name => name !== 'attack'));

  const loss = item.runtime.tick();      // dispara a interrupcao
  const pausing = item.runtime.pause();  // concorrente
  await Promise.resolve();
  await Promise.resolve();
  if (releaseStop) releaseStop(true);
  await Promise.allSettled([loss, pausing]);
  /* Se a segunda chamada ficou pendurada, libera de novo. */
  if (releaseStop) releaseStop(true);

  assert.equal(stopCalls, 1, 'uma unica tentativa de parada');
});

test('close after a capability loss does not send a second stop', async () => {
  const item = capabilityFixture();
  await item.runtime.setModules('target', true, 10, item.config);
  await item.runtime.tick();
  item.setCommands([...FIXTURE_DECLARATION.commands].filter(name => name !== 'attack'));
  await item.runtime.tick();
  assert.equal(item.pauses.length, 1);
  await item.runtime.close();
  assert.equal(item.pauses.length, 1,
    'close nao repete a parada');
});
/* ============================================================================
 * G04-R3 — renovar o episodio de parada apos retomada explicita
 * ========================================================================= */

test('each explicit resume starts a new stop episode (one stop per pause)', async () => {
  const item = capabilityFixture();
  await item.runtime.setModules('walker', true, 10, WALKER_ONLY());

  /* 1. despacha movimento */
  await item.runtime.tick();
  assert.ok(item.commands.some(entry => entry.name === 'walk'), 'movimento despachado');

  /* 2. pausa: exatamente um stop */
  await item.runtime.pause();
  assert.equal(item.pauses.length, 1, 'primeira pausa: um stop');

  /* 3. retoma explicitamente e despacha novo movimento */
  await item.runtime.togglePause();
  assert.equal(item.runtime.state.paused, false);
  /* O walker exige (a) amostra de tick MAIOR e (b) cadencia minima entre
   * passos. Avancamos relogio e telemetria como o jogo faria. */
  item.time(11000);
  item.sessionValue.telemetry.tick = 2;
  item.sessionValue.telemetry.position = { x: 101, y: 100, z: 7 };
  await item.runtime.tick();
  const walks = item.commands.filter(entry => entry.name === 'walk').length;
  assert.ok(walks >= 2, 'novo movimento despachado depois da retomada');

  /* 4. pausa de novo: dois stops no total */
  await item.runtime.pause();
  assert.equal(item.pauses.length, 2, 'segunda pausa precisa enviar stop novo');

  /* 5. fechar ainda pausado nao repete */
  await item.runtime.close();
  assert.equal(item.pauses.length, 2, 'close nao duplica a parada');
});

test('resume is refused while a stop is still pending', async () => {
  const item = capabilityFixture();
  await item.runtime.setModules('walker', true, 10, WALKER_ONLY());
  await item.runtime.tick();

  /* stop que nunca resolve: fica pendente. */
  item.adapter.pauseWalker = () => new Promise(() => {});
  item.runtime.timeoutMs = 500;
  const pausing = item.runtime.pause();
  await Promise.resolve();
  await assert.rejects(item.runtime.togglePause(), /parada ainda pendente/);
  /* A pausa vai estourar por timeout; absorvemos para nao vazar no teste. */
  await pausing.catch(() => {});
});

test('resume revalidates capabilities before restarting', async () => {
  const item = capabilityFixture();
  await item.runtime.setModules('walker', true, 10, WALKER_ONLY());
  await item.runtime.tick();
  await item.runtime.pause();
  assert.equal(item.pauses.length, 1);

  /* Capacidade exigida some enquanto esta pausado. */
  item.setCommands([...FIXTURE_DECLARATION.commands].filter(name => name !== 'walk'));
  await assert.rejects(item.runtime.togglePause(), /capacidade ausente|Capacidade ausente/i);
  assert.equal(item.runtime.state.paused, true, 'continuou pausado');
  assert.equal(item.pauses.length, 1, 'nenhum stop extra');
});

test('a stale stop promise does not overwrite the new episode record', async () => {
  const item = capabilityFixture();
  await item.runtime.setModules('walker', true, 10, WALKER_ONLY());
  await item.runtime.tick();

  /* Primeira tentativa de parada fica pendente, capturada com a epoca VELHA. */
  const oldEpoch = item.runtime.stopEpoch;
  let releaseFirst;
  item.adapter.pauseWalker = () => new Promise(resolve => { releaseFirst = resolve; });
  const inFlight = item.runtime.performStop('pause', oldEpoch);
  await Promise.resolve();

  /* Um episodio NOVO comeca enquanto a promessa antiga ainda esta em voo. */
  item.runtime.beginStopEpisode();
  assert.notEqual(item.runtime.stopEpoch, oldEpoch);

  /* A promessa antiga resolve DEPOIS. Nao pode escrever no episodio novo. */
  releaseFirst(true);
  const stale = await inFlight;
  assert.equal(stale.stop, 'acked', 'a tentativa antiga terminou como acked');
  assert.equal(item.runtime.stopOutcome, null,
    'promessa antiga nao escreve no registro do episodio novo');
  assert.equal(item.runtime.state.interrupt, null);
});
