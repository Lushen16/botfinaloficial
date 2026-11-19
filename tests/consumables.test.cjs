'use strict';

/**
 * Consumiveis das Tools: quatro slots, hotkey + intervalo.
 *
 * Contrato de tempo da interface: usa na hora e repete apos 10, 20 e 30 s; a
 * proxima sequencia comeca no intervalo configurado, contado do primeiro uso.
 * Um hotkey por tick, so' `hotkey` (canal que a DLL executa).
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { createConsumablesEngine, normalizeConsumables } = require('../reconstruction/engines/consumables-engine.cjs');
const capabilities = require('../reconstruction/capabilities.cjs');
const { createAutomation, createRecorder } = require('../reconstruction/automation.cjs');
const defaults = require('../default_config.json');

function config(tools) { return { tools }; }

function sink() {
  const events = [];
  return { events, command: (name, parameter) => events.push([name, parameter]) };
}

test('normaliza so slots ligados e com hotkey', () => {
  const slots = normalizeConsumables(config({
    consumable1: { enabled: true, hotkey: 'F5', intervalMinutes: 5 },
    consumable2: { enabled: false, hotkey: 'F6', intervalMinutes: 5 },
    consumable3: { enabled: true, hotkey: '', intervalMinutes: 5 },
    consumable4: { enabled: true, hotkey: ' F8 ', intervalMinutes: 0 },
  }));
  assert.deepEqual(slots.map(entry => entry.hotkey), ['F5', 'F8']);
  assert.equal(slots[1].intervalMs, 60000, 'minimo de 1 minuto');
});

test('usa na hora, repete em 10/20/30 s e espera o intervalo', () => {
  const engine = createConsumablesEngine(config({
    consumable1: { enabled: true, hotkey: 'F5', intervalMinutes: 1 },
  }));
  const out = sink();
  assert.equal(engine.step(0, out).emitted.length, 1, 'primeiro uso imediato');
  assert.equal(engine.step(5000, out).emitted.length, 0);
  assert.equal(engine.step(10000, out).emitted.length, 1);
  assert.equal(engine.step(20000, out).emitted.length, 1);
  assert.equal(engine.step(30000, out).emitted.length, 1);
  assert.equal(engine.step(59999, out).emitted.length, 0, 'espera o intervalo');
  assert.equal(engine.step(60000, out).emitted.length, 1, 'novo ciclo no intervalo');
  assert.deepEqual(out.events.map(event => event[0]), ['hotkey', 'hotkey', 'hotkey', 'hotkey', 'hotkey']);
  assert.ok(out.events.every(event => event[1] === 'F5'));
});

test('um comando por tick mesmo com dois slots vencidos', () => {
  const engine = createConsumablesEngine(config({
    consumable1: { enabled: true, hotkey: 'F5', intervalMinutes: 5 },
    consumable2: { enabled: true, hotkey: 'F6', intervalMinutes: 5 },
  }));
  const out = sink();
  assert.equal(engine.step(0, out).emitted.length, 1);
  assert.equal(engine.step(0, out).emitted.length, 1, 'o segundo sai no tick seguinte');
  assert.equal(engine.step(0, out).emitted.length, 0);
});

test('reset volta a disparar na hora', () => {
  const engine = createConsumablesEngine(config({
    consumable1: { enabled: true, hotkey: 'F5', intervalMinutes: 5 },
  }));
  const out = sink();
  engine.step(0, out);
  assert.equal(engine.step(1000, out).emitted.length, 0);
  engine.reset();
  assert.equal(engine.step(2000, out).emitted.length, 1);
});

test('sem consumivel ligado o passo e vazio', () => {
  const engine = createConsumablesEngine(config({ consumable1: { enabled: false } }));
  assert.deepEqual(engine.step(0, sink()).emitted, []);
});

/* ---------------------------------------------------------- capacidades */

test('slot de consumivel ligado exige hotkey no start', () => {
  const result = capabilities.requirementsFor(['walker'], {
    walker: { waypoints: [] },
    tools: { consumable1: { enabled: true, hotkey: '' } },
  });
  assert.ok(result.commands.includes('hotkey'));
});

test('slot desligado nao exige nada', () => {
  const result = capabilities.requirementsFor(['walker'], {
    walker: { waypoints: [] },
    tools: { consumable1: { enabled: false, hotkey: 'F5' } },
  });
  assert.ok(!result.commands.includes('hotkey'));
});

/* ------------------------------------------------- integracao no tick */

function snap(patch = {}) {
  return {
    pid: 10, online: true, stale: false, error: null, authExpired: false, ageMs: 30, paused: false,
    runtime: { modules: [], pid: null, paused: false },
    telemetry: {
      schema: 2, nativeVerified: true, pulseVersion: 3, tick: 1, playerId: 1, fightMode: 0, chaseMode: 0,
      clockMs: 0, position: { x: 100, y: 100, z: 7 }, activeSlot: 1, moves: [], nativeSequence: [],
      pokemonName: 'Charizard', comboPokemonName: 'Charizard', conditionEvents: true, conditionsKnown: true,
      conditions: [], roster: [], creatures: [], items: [], tiles: [], healthPercent: 100,
      ...patch,
    },
  };
}

test('consumivel ocupa o tick do automation', () => {
  const cfg = structuredClone(defaults);
  cfg.tools = { ...cfg.tools, consumable1: { enabled: true, hotkey: 'F5', intervalMinutes: 5 } };
  const automation = createAutomation(cfg, { now: () => 0 });
  const recorder = createRecorder();
  const result = automation.tick(snap(), recorder);
  assert.equal(result.status, 'consumable');
  assert.deepEqual(recorder.events.map(event => [event.name, event.parameter]), [['hotkey', 'F5']]);
});

test('gate bloqueado nao dispara consumivel', () => {
  const cfg = structuredClone(defaults);
  cfg.tools = { ...cfg.tools, consumable1: { enabled: true, hotkey: 'F5', intervalMinutes: 5 } };
  const automation = createAutomation(cfg, { now: () => 0 });
  const recorder = createRecorder();
  const result = automation.tick({ ...snap(), online: false }, recorder);
  assert.equal(result.status, 'blocked');
  assert.deepEqual(recorder.events, []);
});
