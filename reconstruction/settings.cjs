const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const schema = require('../readable/shared/schema.js');
const walker = require('../readable/shared/walker.js');
const MAX_BYTES = 2097152;
const TELEMETRY_DEFAULTS = Object.freeze({ mode: 'chain', intervalMs: 5000, maxSessionMin: 20, cooldownMin: 5, executableSha256: '', playerName: '' });
const TELEMETRY_MODES = new Set(['chain', 'native', 'replay']);
const clone = value => JSON.parse(JSON.stringify(value));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function validateTelemetry(raw) {
  if (raw === undefined) return { ...TELEMETRY_DEFAULTS };
  if (!object(raw)) throw Error('telemetry: objeto inválido.');
  const telemetry = { ...TELEMETRY_DEFAULTS, ...raw };
  if (!TELEMETRY_MODES.has(telemetry.mode)) {
    throw Error('telemetry.mode inválido: use chain, native ou replay.');
  }
  if (!Number.isInteger(telemetry.intervalMs) || telemetry.intervalMs < 2000 || telemetry.intervalMs > 60000) {
    throw Error('telemetry.intervalMs deve estar entre 2000 e 60000.');
  }
  if (!Number.isInteger(telemetry.maxSessionMin) || telemetry.maxSessionMin < 1 || telemetry.maxSessionMin > 240) {
    throw Error('telemetry.maxSessionMin deve estar entre 1 e 240.');
  }
  if (!Number.isInteger(telemetry.cooldownMin) || telemetry.cooldownMin < 0 || telemetry.cooldownMin > 120) {
    throw Error('telemetry.cooldownMin deve estar entre 0 e 120.');
  }
  if (typeof telemetry.executableSha256 !== 'string'
      || (telemetry.executableSha256 !== '' && !/^[0-9a-f]{64}$/i.test(telemetry.executableSha256))) {
    throw Error('telemetry.executableSha256 inválido: use SHA-256 hex de 64 caracteres ou vazio.');
  }
  if (typeof telemetry.playerName !== 'string' || telemetry.playerName.length > 200000) {
    throw Error('telemetry.playerName inválido.');
  }
  return {
    mode: telemetry.mode,
    intervalMs: telemetry.intervalMs,
    maxSessionMin: telemetry.maxSessionMin,
    cooldownMin: telemetry.cooldownMin,
    executableSha256: telemetry.executableSha256 ? telemetry.executableSha256.toLowerCase() : '',
    playerName: telemetry.playerName,
  };
}
function normalizeTelemetry(config) {
  if (!object(config)) throw Error('Configuração inválida.');
  const source = config.tools?.telemetry !== undefined ? config.tools.telemetry : config.telemetry;
  const telemetry = validateTelemetry(source);
  return validateConfig({
    ...config,
    tools: { ...(object(config.tools) ? config.tools : {}), telemetry },
    telemetry,
  });
}
function migrateTelemetry(config) {
  const base = schema.createConfig();
  const src = object(config) ? config : {};
  const candidate = { ...base, ...src };
  for (const tab of schema.tabs) {
    if (object(src[tab.key])) candidate[tab.key] = { ...base[tab.key], ...src[tab.key] };
  }
  return normalizeTelemetry(candidate);
}
function profileName(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 80 || /[\x00-\x1f]/u.test(value)) throw Error('Nome do perfil inválido (máximo 80 caracteres).');
  return value.trim();
}
function characterKey(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\x00-\x1f\x7f]/u.test(value)) throw Error('Nick do personagem inválido.');
  return value.trim().toLowerCase();
}
function characterName(status) {
  if (!status?.online || status.stale || typeof status.telemetry?.playerName !== 'string') return '';
  try { characterKey(status.telemetry.playerName); return status.telemetry.playerName.trim(); } catch { return ''; }
}
function characterDirectory(root, name) {
  const key = characterKey(name);
  const slug = key.replace(/[<>:"/\\|?*\x00-\x1f.]/gu, '_').slice(0, 60);
  return path.join(root, 'electron', 'characters', slug + '-' + crypto.createHash('sha256').update(key).digest('hex').slice(0, 16));
}
/* Perfis antigos nao tem campos novos (ex.: looting.ballSlot). Preenche o
 * default do schema antes de validar, sem tocar no que ja' existe. */
function fillDefaults(fields, config) {
  if (!object(config)) return config;
  const result = { ...config };
  for (const field of fields) {
    if (field.type === 'object') result[field.key] = fillDefaults(field.fields, result[field.key] ?? {});
    else if (result[field.key] === undefined) {
      result[field.key] = field.type === 'list' ? [] : field.default;
    }
  }
  return result;
}
function validateFields(fields, config, label) {
  if (!object(config)) throw Error(label + ': objeto inválido.');
  const result = {};
  for (const field of fields) {
    const value = config[field.key];
    const location = label + '.' + field.key;
    if (field.type === 'object') result[field.key] = validateFields(field.fields, value, location);
    else if (field.type === 'list') {
      if (!Array.isArray(value) || value.length > 2000) throw Error(location + ': lista inválida ou muito grande.');
      result[field.key] = value.map((entry, index) => validateFields(field.fields, entry, location + '[' + index + ']'));
    } else {
      if (field.type === 'boolean' && typeof value !== 'boolean') throw Error(location + ': use verdadeiro ou falso.');
      if (field.type === 'number' && (!Number.isInteger(value) || value < field.min || value > field.max)) throw Error(location + ': use um inteiro entre ' + field.min + ' e ' + field.max + '.');
      if (['text', 'code'].includes(field.type) && (typeof value !== 'string' || value.length > 200000)) throw Error(location + ': texto inválido ou muito grande.');
      if (field.type === 'select' && !field.options.includes(value)) throw Error(location + ': opção inválida.');
      if (field.type === 'parameter' && !['string', 'number'].includes(typeof value)) throw Error(location + ': use texto ou número.');
      /* `typeof NaN === 'number'` e `typeof Infinity === 'number'`: a checagem
       * de tipo sozinha deixa passar valor que nao pode ser serializado em JSON
       * (vira `null`) e corrompe o perfil em silencio. */
      if (field.type === 'parameter' && typeof value === 'number' && !Number.isFinite(value)) {
        throw Error(location + ': use um número finito.');
      }      result[field.key] = value;
    }
  }
  return result;
}
function validateConfig(config) {
  if (!object(config)) throw Error('Configuração inválida.');
  const candidate = { ...config };
  const rawTelemetry = candidate.tools?.telemetry !== undefined
    ? candidate.tools.telemetry
    : (config.telemetry !== undefined ? config.telemetry : undefined);
  if (object(candidate.tools)) candidate.tools = schema.migrateTools(candidate.tools);
  if (object(candidate.target)) candidate.target = { ...candidate.target, luring: walker.normalizeLuring(candidate.target.luring) };
  for (const tab of schema.tabs) candidate[tab.key] = fillDefaults(tab.fields, candidate[tab.key]);
  const result = Object.fromEntries(schema.tabs.map(tab => [tab.key, validateFields(tab.fields, candidate[tab.key], tab.label)]));
  if (rawTelemetry !== undefined) {
    const telemetry = validateTelemetry(rawTelemetry);
    result.tools.telemetry = telemetry;
    result.telemetry = { ...telemetry };
  }
  /* Perfis antigos guardavam a hotkey do AutoCombo em `combo.n`. */
  const legacyHotkey = candidate.target?.combo?.n;
  if (object(candidate.target?.combo) && candidate.target.combo.nativeHotkey === undefined && legacyHotkey !== undefined) {
    candidate.target = { ...candidate.target, combo: { ...candidate.target.combo, nativeHotkey: legacyHotkey } };
  }
  const nativeHotkey = candidate.target?.combo?.nativeHotkey;
  if (nativeHotkey !== undefined) {
    if (typeof nativeHotkey !== 'string' || Buffer.byteLength(nativeHotkey.trim(), 'utf8') > 255) {
      throw Error('Hotkey AutoCombo inválida.');
    }
  }
  if (nativeHotkey !== undefined && nativeHotkey.trim()) result.target.combo.nativeHotkey = nativeHotkey.trim();
  return result;
}
function validateData(data) {
  if (!object(data) || data.version !== 1 || !Array.isArray(data.profiles) || !data.profiles.length) throw Error('Formato de configurações não suportado.');
  const profiles = data.profiles.map(profile => ({ name: profileName(profile.name), config: validateConfig(profile.config) }));
  if (new Set(profiles.map(profile => profile.name)).size !== profiles.length) throw Error('Perfis duplicados.');
  if (!profiles.some(profile => profile.name === data.activeProfile)) throw Error('Perfil ativo não encontrado.');
  return { version: 1, activeProfile: data.activeProfile, profiles };
}
class SettingsStore {
  constructor(root) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) throw Error('An explicit absolute settings directory is required.');
    this.directory = path.resolve(root);
    this.character = '';
    this.filename = path.join(this.directory, 'electron', 'settings.json');
    this.loaded = false;
    this.data = { version: 1, activeProfile: 'Default', profiles: [{ name: 'Default', config: schema.createConfig() }] };
    this.queue = Promise.resolve();
  }
  async load() {
    let raw;
    try {
      const rootMetadata = await fs.lstat(this.directory);
      if (rootMetadata.isSymbolicLink() || path.relative(await fs.realpath(this.directory), this.directory) !== '') throw Error('Unsafe settings directory.');
      const directoryMetadata = await fs.lstat(path.dirname(this.filename));
      if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) throw Error('Unsafe settings directory.');
      const metadata = await fs.lstat(this.filename);
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw Error('Unsafe settings file.');
      if (metadata.size > MAX_BYTES) throw Error('Configurações muito grandes.');
      raw = await fs.readFile(this.filename, 'utf8');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (raw !== undefined) this.data = validateData(JSON.parse(raw));
    this.loaded = true;
    return this.snapshot();
  }
  snapshot() { return clone(this.data); }
  current() { return clone(this.data.profiles.find(profile => profile.name === this.data.activeProfile).config); }
  initialize(data) { return this.persist(data); }
  /* Clona NA CHAMADA, nao dentro do `transact`: o chamador costuma mutar o
   * objeto logo depois (`submitted.activeProfile = ...`) e o `transact` so'
   * roda no microtask seguinte. Guardar a referencia fazia a gravacao levar
   * o estado mutado em vez do snapshot submetido.
   *
   * `undefined`/`null` continuam chegando ao `validateData`, que rejeita com a
   * mensagem de formato — clonar aqui estouraria de forma SINCRONA, antes do
   * `assert.rejects` poder observar. */
  persist(data) {
    const submitted = data === undefined || data === null ? data : clone(data);
    return this.transact(() => validateData(submitted));
  }
  transact(change) {
    const operation = this.queue.then(async () => {
      const directory = path.dirname(this.filename);
      await fs.mkdir(directory, { recursive: true });
      const rootMetadata = await fs.lstat(this.directory);
      const metadata = await fs.lstat(directory);
      if (rootMetadata.isSymbolicLink() || metadata.isSymbolicLink() || !metadata.isDirectory()) throw Error('Unsafe settings directory.');
      if (path.relative(await fs.realpath(this.directory), this.directory) !== '') throw Error('Settings directory must not contain symlinks.');
      const lockfile = this.filename + '.lock';
      let lock;
      for (let attempt = 0; attempt < 100; attempt++) {
        try { lock = await fs.open(lockfile, 'wx', 0o600); break; }
        catch (error) { if (error.code !== 'EEXIST') throw error; await delay(10); }
      }
      if (!lock) throw Error('Settings are locked.');
      const temporary = this.filename + '.' + crypto.randomUUID() + '.tmp';
      try {
        await this.load();
        const next = validateData(change(this.snapshot()));
        const contents = JSON.stringify(next, null, 2);
        if (Buffer.byteLength(contents) > MAX_BYTES) throw Error('Configurações muito grandes.');
        await fs.writeFile(temporary, contents, { flag: 'wx', mode: 0o600 });
        try { await fs.copyFile(this.filename, this.filename + '.bak', require('node:fs').constants.COPYFILE_EXCL); }
        catch (error) { if (!['ENOENT', 'EEXIST'].includes(error.code)) throw error; }
        await fs.rename(temporary, this.filename);
        this.data = next;
        this.loaded = true;
        return this.snapshot();
      } finally {
        await fs.unlink(temporary).catch(() => {});
        await lock.close();
        await fs.unlink(lockfile);
      }
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  save(name, config) {
    const normalizedName = profileName(name);
    const normalizedConfig = validateConfig(config);
    return this.transact(data => {
      const profile = data.profiles.find(profile => profile.name === normalizedName);
      if (profile) profile.config = normalizedConfig;
      else data.profiles.push({ name: normalizedName, config: normalizedConfig });
      data.activeProfile = normalizedName;
      return data;
    });
  }
  select(name) {
    return this.transact(data => {
      if (!data.profiles.some(profile => profile.name === name)) throw Error('Perfil não encontrado.');
      data.activeProfile = name;
      return data;
    });
  }
  remove(name) {
    return this.transact(data => {
      if (data.profiles.length <= 1) throw Error('Mantenha pelo menos um perfil.');
      if (!data.profiles.some(profile => profile.name === name)) throw Error('Perfil não encontrado.');
      data.profiles = data.profiles.filter(profile => profile.name !== name);
      if (data.activeProfile === name) data.activeProfile = data.profiles[0].name;
      return data;
    });
  }
}
module.exports = { SettingsStore, validateFields, validateConfig, validateTelemetry, normalizeTelemetry, migrateTelemetry, TELEMETRY_DEFAULTS, profileName, characterName, characterKey, characterDirectory, MAX_BYTES };
