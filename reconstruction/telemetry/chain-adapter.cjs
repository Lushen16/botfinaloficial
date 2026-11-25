'use strict';
const { EventEmitter } = require('node:events');
const { createLiveProvider } = require('./chain-provider.cjs');
const { createLiveSink } = require('./input-sink.cjs');
const profile = require('../executable-profile.cjs');

const CHAIN_RVA = '0x39F8E08';
function chainRvaFor(wanted = {}) {
  return wanted.executableSha256 ? profile.chainRvaFor(wanted.executableSha256) : null;
}

const SUPPORTED_SHA256 = '0ec61b0e401396660988943701c0417e7fce87d46a32f0dd641e7c0cf9b1f29e';

async function openChainAdapter({ pid, config, signal, provider: givenProvider, sink: givenSink, now = Date.now, pidFile = null } = {}) {
  const wanted = config?.telemetry || {};
  const intervalMs = Math.max(2000, Number(wanted.intervalMs) || 5000);
  const maxSessionMin = Number.isFinite(Number(wanted.maxSessionMin)) && Number(wanted.maxSessionMin) > 0
    ? Number(wanted.maxSessionMin) : 20;
  const name = wanted.playerName || config?.playerName || null;
  const creatureRva = wanted.creatureChainRva || profile.creatureChainRvaFor(wanted.executableSha256);
  const wantItems = wanted.items === true || (wanted.items !== false && config?.looting?.captureEnabled === true);
  const tileBlocksRva = wanted.mapTileBlocksRva || wanted.tileBlocksRva
    || (wantItems && wanted.executableSha256 ? profile.mapTileBlocksRvaFor(wanted.executableSha256) : null);
  const tileRadius = wanted.tileRadius;
  const provider = givenProvider || createLiveProvider({
    pid,
    name,
    chainRva: wanted.chainRva || chainRvaFor(wanted) || CHAIN_RVA,
    creatureChainRva: creatureRva,
    mapTileBlocksRva: tileBlocksRva,
    tileRadius,
    intervalMs,
    maxSessionMin,
    pidFile: pidFile || wanted.pidFile || null,
  });
  const sink = givenSink || createLiveSink({ pid });
  const events = new EventEmitter();
  let latest = null;
  const BASE_COMMANDS = ['walk', 'attack', 'talk', 'potion', 'stop'];
  const itemsAvailable = () => latest?.itemsAvailable === true && Array.isArray(latest.items);
  const currentCommands = () => (itemsAvailable() ? [...BASE_COMMANDS, 'useWith'] : [...BASE_COMMANDS]);

  provider.start((frame) => {
    latest = frame;
    events.emit('frame', frame);
  });
  if (signal) signal.addEventListener('abort', () => provider.stop(), { once: true });

  const adapter = {
    get supportedCommands() { return currentCommands(); },
    capabilities: () => ({ state: 'valid', contract: 'pka-capabilities', version: 1, server: 'chain', serverValid: true, commands: currentCommands(), effects: [], unrecognised: [], reason: null }),
    on: (event, handler) => { events.on(event, handler); return adapter; },
    getSnapshot() {
      const player = latest ? latest.player : null;
      const creaturesAvailable = latest?.creaturesAvailable === true
        && Array.isArray(latest.creatures);
      const creatures = creaturesAvailable ? latest.creatures.map((c) => {
        const own = c.ownPokemon === true || ((c.id & 0xF0000000) === 0x80000000);
        return own ? { ...structuredClone(c), ownPokemon: true } : structuredClone(c);
      }) : [];
      const hasItems = itemsAvailable();
      const items = hasItems ? structuredClone(latest.items) : [];
      const ageMs = latest?.sampledAtMs ? Math.max(0, now() - latest.sampledAtMs) : 100000;
      const maxAgeMs = Math.max(2000, intervalMs * 2 + 1000);
      const stale = !latest?.sampledAtMs || ageMs > maxAgeMs;
      const pos = player ? player.pos : null;
      return {
        pid,
        online: !!player,
        stale,
        paused: false,
        ageMs,
        runtimeReady: !!player,
        telemetry: {
          nativeVerified: true,
          pulseVersion: 3,
          mode: 'chain',
          intervalMs,
          position: pos,
          healthPercent: player ? player.hp : null,
          playerName: player ? player.name : null,
          captureVersion: null,
          itemInspectorAvailable: false,
          player,
          creaturesAvailable,
          creatures,
          itemsAvailable: hasItems,
          items,
          source: 'chain',
          sampledAtMs: latest?.sampledAtMs ?? null,
          seq: latest?.seq ?? 0,
        },
      };
    },
    async command(name, parameter) {
      if (name === 'stop') return { status: 0, delivered: true };
      if (name === 'walk') {
        const result = sink.step(Number(parameter));
        if (!result.accepted) {
          const error = Error(result.error || 'walk rejeitado');
          if (events.listenerCount('fault')) events.emit('fault', error);
          throw error;
        }
        return { status: 0, delivered: true, transport: 'PostMessageW' };
      }
      if (name === 'attack') {
        let x, y;
        const tile = parameter && typeof parameter === 'object' && (parameter.pos || parameter.tile);
        if (tile) {
          const player = latest?.player;
          if (!player) return { status: 0, delivered: false, error: 'sem posicao do player' };
          x = 960 + (Number(tile.x) - player.pos.x) * 32;
          y = 504 + (Number(tile.y) - player.pos.y) * 32;
        } else if (parameter && typeof parameter === 'object') {
          x = Number(parameter.x); y = Number(parameter.y);
        } else if (typeof parameter === 'string' && parameter.includes(',')) {
          const [a, b] = parameter.split(',');
          x = Number(a); y = Number(b);
        }
        if (!Number.isInteger(x) || !Number.isInteger(y)) {
          return { status: 0, delivered: false, error: 'attack exige {x,y} de cliente' };
        }
        const result = sink.clickClient(x, y);
        if (!result.accepted) {
          if (events.listenerCount('fault')) events.emit('fault', Error(result.error || 'attack rejeitado'));
          return { status: 0, delivered: false, error: result.error || 'click rejeitado' };
        }
        return { status: 0, delivered: true, transport: 'PostMessageW', queuedAtMs: result.queuedAtMs };
      }
      if (name === 'talk') {
        const text = typeof parameter === 'string' ? parameter : (parameter && parameter.text);
        if (typeof text !== 'string' || !text) {
          return { status: 0, delivered: false, error: 'talk exige texto' };
        }
        const result = sink.talk(text);
        if (!result.accepted) {
          if (events.listenerCount('fault')) events.emit('fault', Error(result.error || 'talk rejeitado'));
          return { status: 0, delivered: false, error: result.error || 'talk rejeitado' };
        }
        return { status: 0, delivered: true, transport: 'PostMessageW+WM_CHAR', queuedAtMs: result.queuedAtMs };
      }
      if (name === 'potion') {
        const hotkey = typeof parameter === 'string' ? parameter
          : (parameter && (parameter.hotkey || parameter.slot));
        if (hotkey === undefined || hotkey === null || hotkey === '') {
          return { status: 0, delivered: false, error: 'potion exige hotkey' };
        }
        const result = sink.potion(String(hotkey));
        if (!result.accepted) {
          if (events.listenerCount('fault')) events.emit('fault', Error(result.error || 'potion rejeitado'));
          return { status: 0, delivered: false, error: result.error || 'potion rejeitado' };
        }
        return { status: 0, delivered: true, transport: 'PostMessageW', queuedAtMs: result.queuedAtMs };
      }
      if (name === 'useWith') {
        if (!itemsAvailable()) {
          return { status: 0, delivered: false, unsupported: true };
        }
        if (typeof sink.useWith === 'function') {
          const result = sink.useWith(parameter);
          if (!result?.accepted) {
            if (events.listenerCount('fault')) events.emit('fault', Error(result?.error || 'useWith rejeitado'));
            return { status: 0, delivered: false, error: result?.error || 'useWith rejeitado' };
          }
          return { status: 0, delivered: true, transport: result.transport || 'PostMessageW', queuedAtMs: result.queuedAtMs };
        }
        const player = latest?.player;
        if (!player?.pos) return { status: 0, delivered: false, error: 'sem posicao do player' };
        const key = parameter && typeof parameter === 'object' ? (parameter.key || parameter.hotkey) : null;
        const wx = parameter && typeof parameter === 'object' ? Number(parameter.x) : NaN;
        const wy = parameter && typeof parameter === 'object' ? Number(parameter.y) : NaN;
        if (!key || !Number.isFinite(wx) || !Number.isFinite(wy)) {
          return { status: 0, delivered: false, error: 'useWith exige key e {x,y}' };
        }
        const keyResult = sink.potion(String(key));
        if (!keyResult.accepted) {
          if (events.listenerCount('fault')) events.emit('fault', Error(keyResult.error || 'useWith hotkey rejeitada'));
          return { status: 0, delivered: false, error: keyResult.error || 'useWith hotkey rejeitada' };
        }
        const cx = 960 + (wx - player.pos.x) * 32;
        const cy = 504 + (wy - player.pos.y) * 32;
        const clickResult = sink.clickClient(cx, cy);
        if (!clickResult.accepted) {
          if (events.listenerCount('fault')) events.emit('fault', Error(clickResult.error || 'useWith click rejeitado'));
          return { status: 0, delivered: false, error: clickResult.error || 'useWith click rejeitado' };
        }
        return { status: 0, delivered: true, transport: 'PostMessageW', queuedAtMs: clickResult.queuedAtMs };
      }
      return { status: 0, delivered: false, unsupported: true };
    },
    async pauseWalker(paused) { return paused ? true : true; },
    async close() { provider.stop(); events.removeAllListeners(); },
    get intervalMs() { return intervalMs; },
    get providerRunning() { return typeof provider.isRunning === 'function' ? provider.isRunning() : true; },
  };
  return adapter;
}

module.exports = { open: openChainAdapter, openChainAdapter, CHAIN_RVA, SUPPORTED_SHA256 };

