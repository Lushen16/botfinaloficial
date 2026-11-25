'use strict';

const { EventEmitter } = require('node:events');
const { createChainProvider } = require('./chain-provider.cjs');

/** Adaptador de replay: zero spawns, zero leitura de memoria. */
async function openReplayAdapter({ pid = 0, config = {}, signal, provider: givenProvider, now = Date.now } = {}) {
  const wanted = config?.telemetry || {};
  const intervalMs = Math.max(2000, Number(wanted.intervalMs) || 5000);
  const provider = givenProvider || createChainProvider({
    mode: 'replay',
    file: wanted.replayFile,
    frames: Array.isArray(wanted.replayFrames) ? wanted.replayFrames : [],
  });
  const events = new EventEmitter();
  let latest = null;
  const commands = ['walk', 'attack', 'talk', 'potion', 'stop'];

  provider.start(frame => {
    latest = frame;
    events.emit('frame', frame);
  });
  if (signal) signal.addEventListener('abort', () => provider.stop(), { once: true });

  const adapter = {
    get supportedCommands() { return [...commands]; },
    capabilities: () => ({
      state: 'valid',
      contract: 'pka-capabilities',
      version: 1,
      server: 'replay',
      serverValid: true,
      commands: [...commands],
      effects: [],
      unrecognised: [],
      reason: null,
    }),
    on: (event, handler) => { events.on(event, handler); return adapter; },
    getSnapshot() {
      const player = latest ? latest.player : null;
      const creaturesAvailable = latest?.creaturesAvailable === true && Array.isArray(latest.creatures);
      const creatures = creaturesAvailable ? structuredClone(latest.creatures) : [];
      const ageMs = latest?.sampledAtMs ? Math.max(0, now() - latest.sampledAtMs) : 0;
      const maxAgeMs = Math.max(2000, intervalMs * 2 + 1000);
      const stale = Boolean(latest?.sampledAtMs && ageMs > maxAgeMs);
      return {
        pid,
        online: !!player,
        stale,
        paused: false,
        ageMs,
        runtimeReady: !!player,
        telemetry: {
          nativeVerified: false,
          pulseVersion: 3,
          mode: 'replay',
          intervalMs,
          position: player ? player.pos : null,
          healthPercent: player ? player.hp : null,
          playerName: player ? player.name : null,
          captureVersion: null,
          itemInspectorAvailable: false,
          player,
          creaturesAvailable,
          creatures,
          itemsAvailable: false,
          items: [],
          source: 'replay',
          sampledAtMs: latest?.sampledAtMs ?? null,
          seq: latest?.seq ?? 0,
        },
      };
    },
    async command(name) {
      if (!commands.includes(name)) return { status: 0, delivered: false, unsupported: true };
      return { status: 0, delivered: true, transport: 'replay' };
    },
    async pauseWalker() { return true; },
    async close() { provider.stop(); events.removeAllListeners(); },
    get intervalMs() { return intervalMs; },
  };
  return adapter;
}

module.exports = { open: openReplayAdapter, openReplayAdapter };
