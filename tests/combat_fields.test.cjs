'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { matchesName } = require('../reconstruction/engines/shared.cjs');
const { createTargetEngine } = require('../reconstruction/engines/target-engine.cjs');
const { createRecorder } = require('../reconstruction/automation.cjs');
const { encodeCommand } = require('../reconstruction/protocol.cjs');
const { createLureEngine } = require('../reconstruction/engines/lure-engine.cjs');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function telemetry(patch = {}) {
  return {
    position: { x: 100, y: 100, z: 7 }, playerName: 'Player', healthPercent: 100,
    pokemonName: 'Charizard', activeSlot: 1, roster: [{ slot: 1, name: 'Charizard', uuid: 'uuid-1' }],
    creatures: [{ id: 7, name: 'Shiny Rat', pos: { x: 101, y: 100, z: 7 }, healthPercent: 100, canAttack: true }],
    ...patch,
  };
}

test('ignored creature patterns match whole names, case-insensitively, with literal punctuation', () => {
  for (const [name, pattern, expected] of [
    ['Shiny Rat', ' SHINY * ', true], ['Rat', '*', true], ['Rat', 'rat', true],
    ['Raticate', 'Rat', false], ['Shiny Rat', '* Rat', true], ['A+B[1].', 'A+B[1].', true],
    ['AAB1x', 'A+B[1].', false], ['', '*', false], ['Rat', '', false],
  ]) assert.equal(matchesName(name, pattern), expected, JSON.stringify({ name, pattern }));
});

test('target ignore field removes wildcard matches from inspection and combat', () => {
  for (const ignoredCreaturesText of ['Shiny *', '*', 'Other; SHINY RAT', 'Other\nShiny *']) {
    const engine = createTargetEngine({ target: { ignoredCreaturesText } });
    const recorder = createRecorder();
    assert.deepEqual(engine.inspect(telemetry()), []);
    assert.equal(engine.step(telemetry(), recorder, 0).action, 'idle');
    assert.deepEqual(recorder.events, []);
  }
});

test('Hoenn ignore patterns also exclude creatures from Target', () => {
  const engine = createTargetEngine({ target: {}, hoenn: { ignoredCreaturesText: 'Shiny *' } });
  assert.deepEqual(engine.inspect(telemetry()), []);
});

test('ignored wildcard creatures do not hold the Luring walker', () => {
  const engine = createLureEngine({ target: { ignoredCreaturesText: 'Shiny *', luring: { enabled: true, maxDistance: 1 } } });
  const result = engine.step(telemetry({ creatures: [
    { ...telemetry().creatures[0], pos: { x: 106, y: 100, z: 7 } },
  ] }), createRecorder(), 0);
  assert.equal(result.state, 'no-monsters');
  assert.equal(result.allowMovement, true);
});

test('native AutoCombo never executes the hidden manual sequence', () => {
  for (const nativeSequence of [undefined, [], ['invalid']]) {
    const engine = createTargetEngine({ target: {
      combo: { enabled: true, useNativeSequence: true, sequenceText: 'm5' },
    } });
    const recorder = createRecorder();
    engine.step(telemetry({ nativeSequence }), recorder, 0);
    assert.deepEqual(recorder.events.map(event => [event.name, event.parameter]),
      [['attack', 7], ['combo', '!autocombo']]);
    for (const [index, event] of recorder.events.entries()) {
      assert.doesNotThrow(() => encodeCommand(index + 1, event.name, event.parameter, event.extra));
    }
  }
});

test('native sequence takes precedence while manual mode ignores native sequence', () => {
  for (const [useNativeSequence, expected] of [[true, 'm2'], [false, 'm5']]) {
    const engine = createTargetEngine({ target: {
      combo: { enabled: true, useNativeSequence, sequenceText: 'm5' },
    } });
    const recorder = createRecorder();
    engine.step(telemetry({ nativeSequence: ['m2'] }), recorder, 0);
    assert.equal(recorder.events.find(event => event.name === 'talk').parameter, expected);
  }
});

test('blocked native hotkey waits for GCD instead of changing to talk or combo', () => {
  for (const nativeSequence of [[], ['m2']]) {
    const engine = createTargetEngine({ target: {
      combo: { enabled: true, useNativeSequence: true, nativeHotkey: 'F5', sequenceText: 'm5' },
    } });
    const recorder = createRecorder();
    const current = telemetry({ nativeSequence });
    engine.step(current, recorder, 0, { hotkeysBlocked: true });
    assert.deepEqual(recorder.events.map(event => [event.name, event.parameter]), [['attack', 7]]);
    engine.step(current, recorder, 250, { hotkeysBlocked: false });
    assert.deepEqual(recorder.events.map(event => [event.name, event.parameter]), [['attack', 7], ['hotkey', 'F5']]);
  }
});

function diagnostics() {
  const context = vm.createContext({});
  for (const filename of ['schema.js', 'messages.js', 'diagnostics.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../Extracted_Source/shared', filename), 'utf8'), context);
  }
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../reconstruction/combat-readiness.js'), 'utf8'), context);
  return context;
}

test('Target readiness explains keyboard-only capability and retains configuration issues', () => {
  const context = diagnostics();
  const config = context.PkaSchema.createConfig();
  config.target.monsters = [];
  const session = { source: 'rpm', capabilities: { walkerKeyboard: true }, online: true,
    stale: false, ageMs: 10, telemetry: { nativeVerified: false } };
  const issues = context.PkaDiagnostics.targetStartIssues(config, session);
  assert.match(issues[0].message, /Backend teclado\/RPM ativo/u);
  assert.ok(issues.some(issue => issue.path === 'target.monsters'));
  assert.equal(session.telemetry.nativeVerified, false);
});

test('Target readiness preserves offline, stale, profile and native diagnostics', () => {
  const context = diagnostics();
  const config = context.PkaSchema.createConfig();
  const base = { source: 'rpm', capabilities: { walkerKeyboard: true }, online: true,
    stale: false, ageMs: 10, telemetry: { nativeVerified: false } };
  for (const [patch, options] of [
    [{ online: false }, {}], [{ stale: true }, {}], [{ ageMs: 1001 }, {}],
    [{ source: 'native' }, {}], [{ error: 'test-error' }, {}], [{ authExpired: true }, {}],
    [{ telemetryError: 'Criaturas inválidas.' }, {}], [{}, { blocked: true }], [{}, { apiAvailable: false }],
  ]) {
    const issues = context.PkaDiagnostics.targetStartIssues(config, { ...base, ...patch }, options);
    assert.ok(!issues.some(issue => issue.message.includes('Backend teclado/RPM ativo')));
    assert.ok(issues.some(issue => issue.action === 'connection' || issue.action === 'profiles'));
  }
});

test('published diagnostics includes the keyboard-only Target explanation after build', () => {
  const model = require('../reconstruction/app/ui/diagnostics.js');
  const schema = require('../reconstruction/app/ui/schema.js');
  const session = { source: 'rpm', capabilities: { walkerKeyboard: true }, online: true,
    stale: false, ageMs: 0, telemetry: { nativeVerified: false } };
  assert.match(model.targetStartIssues(schema.createConfig(), session)[0].message, /Backend teclado\/RPM ativo/u);
});

test('RPM combat readiness removes only the connection blocker without claiming native verification', () => {
  const context = diagnostics();
  const config = context.PkaSchema.createConfig(); config.target.monsters = [];
  const session = { source: 'rpm', capabilities: { walkerKeyboard: true, targetKeyboard: true },
    online: true, stale: false, ageMs: 10, telemetry: { nativeVerified: false } };
  const issues = context.PkaDiagnostics.targetStartIssues(config, session);
  assert.equal(issues.some(issue => issue.action === 'connection'), false);
  assert.ok(issues.some(issue => issue.path === 'target.monsters'));
  assert.equal(session.telemetry.nativeVerified, false);
  const offline = context.PkaDiagnostics.targetStartIssues(config, { ...session, online: false });
  assert.ok(offline.some(issue => issue.action === 'connection'));
});

test('RPM combat readiness surfaces the real scanner error instead of missing native authentication', () => {
  const context = diagnostics();
  const session = { source: 'rpm', capabilities: { walkerKeyboard: true, targetKeyboard: false,
    targetKeyboardIssue: 'Initial discovery pending' }, online: true, stale: false, ageMs: 10,
    telemetry: { nativeVerified: false } };
  const issues = context.PkaDiagnostics.targetStartIssues(context.PkaSchema.createConfig(), session);
  assert.match(issues[0].message, /Initial discovery pending/u);
});

test('RPM combat readiness surfaces scanner identity errors even without a Walker position', () => {
  const context = diagnostics();
  const session = { source: 'rpm', capabilities: { walkerKeyboard: false, targetKeyboard: false,
    targetKeyboardIssue: 'Nome do jogador RPM divergente.' }, online: true, stale: false, ageMs: 10,
    telemetry: { nativeVerified: false } };
  const issues = context.PkaDiagnostics.targetStartIssues(context.PkaSchema.createConfig(), session);
  assert.match(issues[0].message, /divergente/u);
  assert.ok(!issues.some(issue => issue.message.includes('Backend teclado/RPM ativo')));
});

test('RPM combat readiness asks for Medicine and Revive hotkeys', () => {
  const context = diagnostics();
  const config = context.PkaSchema.createConfig();
  config.target.monsters = [];
  config.target.combo.enabled = true;
  config.target.combo.useMedicine = true;
  config.target.autoRevive.enabled = true;
  const base = { capabilities: { walkerKeyboard: true, targetKeyboard: true },
    online: true, stale: false, ageMs: 10, telemetry: { nativeVerified: false } };
  const rpmIssues = context.PkaDiagnostics.targetStartIssues(config, { ...base, source: 'rpm' });
  assert.ok(rpmIssues.some(issue => issue.path === 'target.monsters'));
  const nativeIssues = context.PkaDiagnostics.targetStartIssues(config, { ...base, source: 'native' });
  for (const issuePath of ['target.combo.medicineHotkey', 'target.autoRevive.hotkey']) {
    assert.ok(rpmIssues.some(issue => issue.path === issuePath));
    assert.ok(nativeIssues.some(issue => issue.path === issuePath));
  }
});

/**
 * PokeStop medido no Shiba (`native/pka_tap_572.jsonl`, 351,8 MB):
 *   ordem real: Best Tile -> Aguardando PokeStop -> Perfect lure -> AutoCombo
 *   `PokeStop sem confirmacao apos quatro tentativas` x336.531
 *   fase dura 1.375 ms de mediana
 * Ele NAO trava a hunt: 4 tentativas e segue.
 */
test('PokeStop is sent before the combo, up to 4 attempts, then the flow continues', () => {
  const engine = createTargetEngine({ target: {
    combo: { enabled: true, useNativeSequence: true, usePokeStop: true, sequenceText: 'm5' },
  } });
  const recorder = createRecorder();
  const t = telemetry();
  const pokeStops = () => recorder.events.filter(e => e.parameter === '!pokestop').length;

  engine.step(t, recorder, 0);
  assert.equal(recorder.events[0].name, 'attack', 'ataca antes de qualquer talk');
  assert.equal(pokeStops(), 1, 'manda !pokestop antes do combo');

  engine.step(t, recorder, 400);
  assert.equal(pokeStops(), 2, 'respeita o intervalo de retry');
  engine.step(t, recorder, 800);
  assert.equal(pokeStops(), 3);
  engine.step(t, recorder, 1200);
  assert.equal(pokeStops(), 4);

  engine.step(t, recorder, 1600);
  assert.equal(pokeStops(), 4, 'nao passa de 4 tentativas');
  assert.ok(recorder.events.some(e => e.parameter === '!autocombo'),
    'depois das 4 tentativas o combo sai normalmente');
});

test('PokeStop is skipped when usePokeStop is off', () => {
  const engine = createTargetEngine({ target: {
    combo: { enabled: true, useNativeSequence: true, usePokeStop: false, sequenceText: 'm5' },
  } });
  const recorder = createRecorder();
  engine.step(telemetry(), recorder, 0);
  assert.equal(recorder.events.filter(e => e.parameter === '!pokestop').length, 0);
  assert.ok(recorder.events.some(e => e.parameter === '!autocombo'));
});

/**
 * Best Tile medido no Shiba (`native/pka_tap_572.jsonl`, 351,8 MB):
 *   ordem real: Best Tile -> Aguardando PokeStop -> Perfect lure -> AutoCombo
 *   `Best Tile: limite de ajuste atingido; seguindo o fluxo de seguranca do Lua` x20.706
 *   prazos do default_config.json: bestTileMaxWaitMs 2500, bestTileRetryMs 700
 * Ele NAO trava a hunt: estoura o prazo e segue o fluxo.
 */
function bestTileFixture(hoenn) {
  const engine = createTargetEngine({
    target: { monsters: [{ name: 'Rat', range: 12 }],
      combo: { enabled: true, useNativeSequence: true, usePokeStop: false, sequenceText: 'm5' } },
    hoenn,
  });
  /* Alvo a 10 tiles do centro da box: fora de `bestTileRange` (4). */
  const t = telemetry({ ownPokemon: { pos: { x: 100, y: 100, z: 7 } },
    creatures: [{ id: 7, name: 'Rat', pos: { x: 110, y: 100, z: 7 }, healthPercent: 100, canAttack: true }] });
  const value = { engine, t, recorder: createRecorder() };
  value.combos = () => value.recorder.events.filter(e => e.parameter === '!autocombo').length;
  return value;
}

test('Best Tile waits for the target to reach the best tile and gives up after bestTileMaxWaitMs', () => {
  const { engine, t, recorder, combos } = bestTileFixture({ bestTile: true });
  assert.equal(engine.step(t, recorder, 0).reason, 'best-tile-wait');

  /* Nada de combo durante a espera: 700 ms e' so' o intervalo de reavaliacao. */
  assert.equal(engine.step(t, recorder, 700).reason, 'best-tile-wait');
  assert.equal(engine.step(t, recorder, 1400).reason, 'best-tile-wait');
  assert.equal(engine.step(t, recorder, 2100).reason, 'best-tile-wait');
  assert.equal(combos(), 0, 'nao comba antes do teto de ajuste');

  /* Teto de 2500 ms atingido: segue o fluxo de seguranca. */
  const timeout = engine.step(t, recorder, 2500);
  assert.equal(timeout.reason, 'best-tile-timeout');
  assert.equal(timeout.action, 'combat');
  assert.equal(combos(), 0, 'o proprio tick do estouro ainda nao comba');

  /* E o fluxo segue normalmente no tick seguinte, sem voltar a esperar. */
  assert.notEqual(engine.step(t, recorder, 2600).reason, 'best-tile-wait');
  assert.equal(combos(), 1, 'depois do teto o combo sai');
});

test('Best Tile does not wait at all when hoenn.bestTile is off', () => {
  const { engine, t, recorder, combos } = bestTileFixture({ bestTile: false });
  assert.notEqual(engine.step(t, recorder, 0).reason, 'best-tile-wait');
  assert.equal(combos(), 1, 'sem bestTile o alvo longe nao segura o combo');
});

/**
 * Pokemon ausente no meio do combo, medido no Shiba (`native/pka_tap_572.jsonl`,
 * 351,8 MB): `target: Pokemon ausente durante o combo; aguardando recuperacao`
 * x267.265. Ele espera e retoma do mesmo indice — nao reinicia a sequencia.
 */
test('missing Pokemon mid-combo waits for recovery and resumes from the same index', () => {
  const engine = createTargetEngine({ target: {
    combo: { enabled: true, useNativeSequence: false, sequenceText: 'm1 m2', stepDelay: 250 },
  } });
  const recorder = createRecorder();
  const t = telemetry();

  assert.equal(engine.step(t, recorder, 0).action, 'combo');
  assert.equal(recorder.events.at(-1).parameter, 'm1');

  /* A pokebar some: sem `roster` o `rosterUuid()` nao resolve o Pokemon ativo. */
  const waiting = engine.step({ ...t, roster: [] }, recorder, 250);
  assert.equal(waiting.reason, 'await-pokemon-recovery');
  assert.equal(waiting.action, 'combat');
  assert.equal(engine.state.comboIndex, 1, 'o indice do combo nao voltou a zero');
  assert.equal(recorder.events.filter(e => e.name === 'talk').length, 1, 'nada de talk na espera');

  /* Pokemon de volta: continua do indice atual, nao recomeca em m1. */
  const resumed = engine.step(t, recorder, 500);
  assert.equal(resumed.action, 'combo');
  assert.equal(recorder.events.at(-1).parameter, 'm2');
});

test('missing Pokemon before the combo still reports missing-uuid and keeps the index at zero', () => {
  const engine = createTargetEngine({ target: {
    combo: { enabled: true, useNativeSequence: false, sequenceText: 'm1 m2', stepDelay: 250 },
  } });
  const recorder = createRecorder();
  const result = engine.step({ ...telemetry(), roster: [] }, recorder, 0);
  assert.equal(result.reason, 'missing-uuid');
  assert.deepEqual(result.blocked, ['combo-without-uuid']);
  assert.equal(engine.state.comboIndex, 0);
  assert.equal(recorder.events.filter(e => e.name === 'talk').length, 0);
});

/**
 * `target.monsters[].movement` está no schema do fornecedor com 4 valores
 * (chase/stand/kite/random_move), mas só `stand` é honrado — e por acidente:
 * o combate devolve pauseWalker, então o treinador fica parado.
 *
 * Medido em 2026-11-16: `grep kiteRange` em reconstruction/ e botfinal/ não
 * acha consumo fora de UI e schema. Quem configurar `kite` espera manter
 * distância e recebe "parado". O aviso existe para não mentir.
 */
test('unhonoured movement is reported instead of silently ignored', () => {
  const context = diagnostics();
  const session = { source: 'rpm', capabilities: { targetKeyboard: true }, online: true,
    stale: false, ageMs: 10, telemetry: { nativeVerified: true } };

  for (const movement of ['kite', 'chase', 'random_move']) {
    const config = context.PkaSchema.createConfig();
    config.target.combo.enabled = false;
    config.target.monsters = [{ name: 'Rat*', movement, kiteRange: 2 }];
    const issues = context.PkaDiagnostics.targetStartIssues(config, session);
    const achou = issues.find(i => i.path === 'target.monsters.0.movement');
    assert.ok(achou, 'deve avisar sobre movement=' + movement);
    assert.match(achou.message, new RegExp(movement, 'u'));
    assert.match(achou.message, /stand/u, 'deve dizer qual é honrado');
  }
});

test('stand and combo-enabled movement produce no warning', () => {
  const context = diagnostics();
  const session = { source: 'rpm', capabilities: { targetKeyboard: true }, online: true,
    stale: false, ageMs: 10, telemetry: { nativeVerified: true } };

  /* `stand` é o valor honrado: nada a avisar. */
  const comStand = context.PkaSchema.createConfig();
  comStand.target.combo.enabled = false;
  comStand.target.monsters = [{ name: 'Rat*', movement: 'stand' }];
  assert.equal(context.PkaDiagnostics.targetStartIssues(comStand, session)
    .some(i => i.path === 'target.monsters.0.movement'), false);

  /* Com combo LIGADO o schema diz que `movement` não se aplica, então também
   * não avisamos — quem manda no posicionamento é o Best Tile / Perfect lure. */
  const comCombo = context.PkaSchema.createConfig();
  comCombo.target.combo.enabled = true;
  comCombo.target.monsters = [{ name: 'Rat*', movement: 'kite' }];
  assert.equal(context.PkaDiagnostics.targetStartIssues(comCombo, session)
    .some(i => i.path === 'target.monsters.0.movement'), false);
});


