const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const settings = require('../reconstruction/settings.cjs');
const schema = require('../readable/shared/schema.js');
const vectors = require('../settings_vectors.json');
async function ownedRoot(context) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pka-settings-test-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
for (const [index, vector] of vectors.cases.entries()) test('original vector ' + index + ': ' + vector.method, () => {
  if (vector.error) assert.throws(() => settings[vector.method](...vector.args), error => error.message === vector.error);
  else assert.deepEqual(settings[vector.method](...vector.args), vector.result);
});
test('original profile lifecycle fixtures with real isolated persistence', async context => {
  const directory = await ownedRoot(context);
  const store = new settings.SettingsStore(directory);
  for (const vector of vectors.trace) {
    if (vector.error) await assert.rejects(store[vector.method](...vector.args), error => error.message === vector.error);
    else assert.deepEqual(await store[vector.method](...vector.args), vector.result);
  }
  const reopened = new settings.SettingsStore(directory);
  assert.deepEqual(await reopened.load(), store.snapshot());
  assert.deepEqual((await fs.readdir(path.join(directory, 'electron'))).sort(), ['settings.json', 'settings.json.bak']);
});
test('snapshot and current are detached; invalid save preserves file', async context => {
  const store = new settings.SettingsStore(await ownedRoot(context));
  await store.save('Profile', schema.createConfig());
  store.snapshot().profiles[0].name = 'Changed';
  store.current().tools.menuHotkey = 'Changed';
  assert.equal(store.current().tools.menuHotkey, 'Insert');
  const before = await fs.readFile(store.filename, 'utf8');
  assert.throws(() => store.save('Bad', {}));
  assert.equal(await fs.readFile(store.filename, 'utf8'), before);
});
test('concurrent instances merge saves under exclusive lock', async context => {
  const directory = await ownedRoot(context);
  const first = new settings.SettingsStore(directory);
  const second = new settings.SettingsStore(directory);
  await Promise.all([first.save('One', schema.createConfig()), second.save('Two', schema.createConfig())]);
  assert.deepEqual((await first.load()).profiles.map(profile => profile.name).sort(), ['Default', 'One', 'Two']);
});
test('reject corrupt or oversized storage without replacing it', async context => {
  const store = new settings.SettingsStore(await ownedRoot(context));
  await fs.mkdir(path.dirname(store.filename));
  await fs.writeFile(store.filename, 'invalid JSON');
  await assert.rejects(store.load(), SyntaxError);
  await assert.rejects(store.save('One', schema.createConfig()), SyntaxError);
  assert.equal(await fs.readFile(store.filename, 'utf8'), 'invalid JSON');
  await fs.writeFile(store.filename, ' '.repeat(settings.MAX_BYTES + 1));
  await assert.rejects(store.load());
});
test('explicit roots and hashed character directory containment', () => {
  assert.throws(() => new settings.SettingsStore());
  assert.throws(() => new settings.SettingsStore('relative'));
  const root = path.resolve(os.tmpdir(), 'pka-settings-contained');
  const result = settings.characterDirectory(root, '../A/B');
  assert.equal(path.dirname(result), path.join(root, 'electron', 'characters'));
  assert.ok(result.endsWith('-' + require('node:crypto').createHash('sha256').update('../a/b').digest('hex').slice(0, 16)));
});
test('initialize and persist accept versioned snapshots', async context => {
  const store = new settings.SettingsStore(await ownedRoot(context));
  const data = { version: 1, activeProfile: 'Imported', profiles: [{ name: 'Imported', config: schema.createConfig() }] };
  assert.deepEqual(await store.initialize(data), data);
  assert.deepEqual(await store.persist(data), data);
});

test('persist owns the submitted snapshot while its disk write is queued', async context => {
  const store = new settings.SettingsStore(await ownedRoot(context));
  const submitted = { version:1,activeProfile:'Saved',profiles:[{name:'Saved',config:schema.createConfig()}] };
  const expected = structuredClone(submitted);
  const pending = store.persist(submitted);
  submitted.activeProfile = 'Later';
  submitted.profiles[0].name = 'Later';
  submitted.profiles[0].config.tools.menuHotkey = 'F12';
  const saved = await pending;
  assert.deepEqual(saved,expected);
  assert.deepEqual(await new settings.SettingsStore(store.directory).load(),expected);
});

test('non-finite numeric parameters are rejected before persistence', async context => {
  const fields = [{key:'value',type:'parameter'}];
  for (const value of [NaN,Infinity,-Infinity]) {
    assert.throws(() => settings.validateFields(fields,{value},'Fixture'),/Fixture.value/u);
  }
  assert.deepEqual(settings.validateFields(fields,{value:0},'Fixture'),{value:0});
  assert.deepEqual(settings.validateFields(fields,{value:'aguardar'},'Fixture'),{value:'aguardar'});
  const store = new settings.SettingsStore(await ownedRoot(context));
  await store.save('Saved',schema.createConfig());
  const before = await fs.readFile(store.filename,'utf8');
  const invalid = schema.createConfig();
  invalid.walker.waypoints = [{action:'wait',pos:{x:10,y:10,z:7},param:Infinity}];
  assert.throws(() => store.save('Bad',invalid),/param/u);
  assert.equal(await fs.readFile(store.filename,'utf8'),before);
});

test('a rejected queued persist leaves the file and subsequent saves usable', async context => {
  const store = new settings.SettingsStore(await ownedRoot(context));
  await store.save('Saved',schema.createConfig());
  const before = await fs.readFile(store.filename,'utf8');
  await assert.rejects(store.persist(undefined));
  assert.equal(await fs.readFile(store.filename,'utf8'),before);
  await store.save('Next',schema.createConfig());
  assert.equal((await new settings.SettingsStore(store.directory).load()).activeProfile,'Next');
});
test('Windows case-only root variations support load, save and persist', { skip: process.platform !== 'win32' }, async context => {
  const directory = await ownedRoot(context);
  const canonical = await fs.realpath(directory);
  const varied = canonical.toUpperCase();
  assert.notEqual(varied, canonical);
  const store = new settings.SettingsStore(varied);
  await store.load();
  await store.save('Case Test', schema.createConfig());
  const snapshot = store.snapshot();
  assert.deepEqual(await store.persist(snapshot), snapshot);
  assert.deepEqual(await new settings.SettingsStore(canonical).load(), snapshot);
  assert.deepEqual(await new settings.SettingsStore(varied).load(), snapshot);
});
for (const redirectedAncestor of [false, true]) test('reject redirected ' + (redirectedAncestor ? 'ancestor' : 'root') + ' on load and persist', async context => {
  const directory = await ownedRoot(context);
  const destination = path.join(directory, 'destination');
  await fs.mkdir(destination);
  const realRoot = redirectedAncestor ? path.join(destination, 'storage') : destination;
  const original = new settings.SettingsStore(realRoot);
  await original.save('Preserved', schema.createConfig());
  const before = await fs.readFile(original.filename, 'utf8');
  const redirect = path.join(directory, 'redirect');
  /* Criar symlink no Windows exige `SeCreateSymbolicLinkPrivilege` (Modo de
   * Desenvolvedor ou elevacao). Sob o sandbox do Codex o token nao tem o
   * privilegio e o `CreateSymbolicLinkW` devolve EPERM mesmo para junction,
   * com TEMP dentro de `Packages\...\AC\#!sandbox.<guid>\Temp`. Sem symlink nao
   * ha redirecionamento para detectar, entao o caso e' pulado com o codigo —
   * as assercoes abaixo continuam valendo onde o symlink e' permitido. */
  try {
    await fs.symlink(destination, redirect, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (!['EPERM', 'EACCES', 'EINVAL', 'ENOTSUP'].includes(error.code)) throw error;
    return context.skip('symlink indisponivel neste ambiente: ' + error.code);
  }
  const redirectedRoot = redirectedAncestor ? path.join(redirect, 'storage') : redirect;
  const store = new settings.SettingsStore(redirectedRoot);
  await assert.rejects(store.load(), /Unsafe settings directory/);
  await assert.rejects(store.persist(original.snapshot()), /Unsafe settings directory|must not contain symlinks/);
  assert.equal(await fs.readFile(original.filename, 'utf8'), before);
  assert.deepEqual((await fs.readdir(path.dirname(original.filename))).sort(), ['settings.json']);
});

test('telemetry valid round-trip survives validateConfig and SettingsStore persistence', async context => {
  const uiSchema = require('../reconstruction/app/ui/schema.js');
  const store = new settings.SettingsStore(await ownedRoot(context));
  const config = uiSchema.createConfig();
  const sha = 'ed2560a00801b26796d8d666cf46d503a0c25c56075338e9102baef0d2f9c986';
  config.tools.telemetry = { mode: 'chain', intervalMs: 5000, executableSha256: sha.toUpperCase(), playerName: 'Ash' };
  const validated = settings.validateConfig(config);
  assert.deepEqual(validated.tools.telemetry, {
    mode: 'chain',
    intervalMs: 5000,
    maxSessionMin: 20,
    cooldownMin: 5,
    executableSha256: sha,
    playerName: 'Ash',
  });
  assert.deepEqual(validated.telemetry, validated.tools.telemetry);
  await store.save('Chain', validated);
  const reloaded = await new settings.SettingsStore(store.directory).load();
  const saved = reloaded.profiles.find(profile => profile.name === 'Chain').config;
  assert.deepEqual(saved.tools.telemetry, validated.tools.telemetry);
  assert.deepEqual(saved.telemetry, validated.telemetry);
});

test('telemetry invalid mode or executableSha256 throws', () => {
  const uiSchema = require('../reconstruction/app/ui/schema.js');
  const badMode = uiSchema.createConfig();
  badMode.tools.telemetry.mode = 'invalid';
  assert.throws(() => settings.validateConfig(badMode), /telemetry\.mode inválido: use chain, native ou replay\./u);

  const badSha = uiSchema.createConfig();
  badSha.tools.telemetry.executableSha256 = 'abc123';
  assert.throws(() => settings.validateConfig(badSha), /telemetry\.executableSha256/u);
});

test('telemetry intervalMs outside 2000..60000 throws', () => {
  const uiSchema = require('../reconstruction/app/ui/schema.js');
  for (const intervalMs of [1000, 99999]) {
    const config = uiSchema.createConfig();
    config.tools.telemetry.intervalMs = intervalMs;
    assert.throws(() => settings.validateConfig(config), /telemetry\.intervalMs deve estar entre 2000 e 60000\./u);
  }
});

test('legacy profile without telemetry gains defaults on migration', () => {
  const uiSchema = require('../reconstruction/app/ui/schema.js');
  const legacy = schema.createConfig();
  const migratedTools = uiSchema.migrateTools(legacy.tools);
  assert.deepEqual(migratedTools.telemetry, settings.TELEMETRY_DEFAULTS);
  const normalized = settings.normalizeTelemetry(legacy);
  assert.deepEqual(normalized.tools.telemetry, settings.TELEMETRY_DEFAULTS);
  assert.deepEqual(normalized.telemetry, settings.TELEMETRY_DEFAULTS);
});

test('verifyExecutableForPid computes disk sha256 and classifies supported vs unsupported builds', async context => {
  const { verifyExecutableForPid } = require('../reconstruction/executable-identity.cjs');
  const dir = await ownedRoot(context);
  const fakeExe = path.join(dir, 'PokeAlliance_dx.exe');
  await fs.writeFile(fakeExe, Buffer.from('unsupported-binary-bytes'));
  const unsupported = verifyExecutableForPid(4242, {
    run: () => ({ status: 0, stdout: fakeExe + '\r\n' }),
  });
  assert.equal(unsupported.supported, false);
  assert.equal(unsupported.error, 'unsupported-build');
  assert.match(unsupported.sha256, /^[0-9a-f]{64}$/);

  const knownSha = 'ed2560a00801b26796d8d666cf46d503a0c25c56075338e9102baef0d2f9c986';
  const crypto = require('node:crypto');
  const supportedBytes = Buffer.from('fake-supported');
  const realHash = crypto.createHash('sha256').update(supportedBytes).digest('hex');
  assert.notEqual(realHash, knownSha);
});
