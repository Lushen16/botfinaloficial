'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { openChainAdapter } = require('../reconstruction/telemetry/chain-adapter.cjs');
const { createChainProvider } = require('../reconstruction/telemetry/chain-provider.cjs');
const { createSeededRandom } = require('../reconstruction/engines/seeded-random.cjs');

function fakeProvider() {
  let cb = null;
  return {
    stopped: false,
    start(fn) { cb = fn; },
    stop() { this.stopped = true; cb = null; },
    emit(frame) { if (cb) cb(frame); },
  };
}

function fakeSink(outcome = true) {
  return { calls: [], step(direction) { this.calls.push(direction); return { accepted: outcome, queuedAtMs: 1 }; } };
}

test('adapter publica jogador do frame e caminha pelo sink', async () => {
  const provider = fakeProvider();
  const sink = fakeSink();
  const adapter = await openChainAdapter({ pid: 7, config: { telemetry: { intervalMs: 2000 } }, provider, sink });
  assert.deepEqual(adapter.getSnapshot().telemetry.player, null);
  provider.emit({ seq: 1, sampledAtMs: 5, player: { name: 'Ash', id: 1, hp: 100, pos: { x: 1, y: 2, z: 7 } } });
  assert.equal(adapter.getSnapshot().telemetry.player.name, 'Ash');
  const result = await adapter.command('walk', 4);
  assert.equal(result.delivered, true);
  assert.deepEqual(sink.calls, [4]);
  await adapter.close();
  assert.equal(provider.stopped, true);
});

test('walk rejeitado emite fault e close limpa listeners', async () => {
  const provider = fakeProvider();
  const faults = [];
  const adapter = await openChainAdapter({ pid: 7, config: {}, provider, sink: fakeSink(false) });
  adapter.on('fault', error => faults.push(error.message));
  await assert.rejects(() => adapter.command('walk', 1), /walk rejeitado/);
  assert.equal(faults.length, 1);
  await adapter.close();
});

test('comando desconhecido nao chama o sink', async () => {
  const sink = fakeSink();
  const adapter = await openChainAdapter({ pid: 7, provider: fakeProvider(), sink });
  const result = await adapter.command('revive', 'x');
  assert.equal(result.unsupported, true);
  assert.deepEqual(sink.calls, []);
  await adapter.close();
});

test('prng com a mesma semente repete a sequencia', () => {
  const a = createSeededRandom(42);
  const b = createSeededRandom(42);
  const c = createSeededRandom(43);
  const first = [a(), a(), a()];
  assert.deepEqual(first, [b(), b(), b()]);
  assert.notDeepEqual(first, [c(), c(), c()]);
});

test('adapter propaga items[], itemsAvailable e habilita useWith somente quando itemsAvailable=true', async () => {
  const provider = fakeProvider();
  const sink = fakeSink();
  const adapter = await openChainAdapter({ pid: 7, config: {}, provider, sink });

  assert.equal(adapter.getSnapshot().telemetry.itemsAvailable, false);
  assert.deepEqual(adapter.getSnapshot().telemetry.items, []);
  assert.equal(adapter.capabilities().commands.includes('useWith'), false);
  assert.equal((await adapter.command('useWith', { x: 1, y: 2, key: 'F1' })).unsupported, true);

  const corpse = { id: 4007, pos: { x: 2963, y: 2268, z: 7 }, stack: 1, va: '0x28be5c294d0' };
  provider.emit({ seq: 1, sampledAtMs: 10, player: { name: 'Ash', id: 1, hp: 100, pos: { x: 2962, y: 2268, z: 7 } }, itemsAvailable: true, items: [corpse] });
  const snap1 = adapter.getSnapshot().telemetry;
  assert.equal(snap1.itemsAvailable, true);
  assert.deepEqual(snap1.items, [corpse]);
  assert.equal(adapter.capabilities().commands.includes('useWith'), true);
  assert.equal(adapter.supportedCommands.includes('useWith'), true);
  snap1.items[0].id = 0;
  assert.equal(adapter.getSnapshot().telemetry.items[0].id, 4007);

  provider.emit({ seq: 2, sampledAtMs: 20, player: { name: 'Ash', id: 1, hp: 100, pos: { x: 2962, y: 2268, z: 7 } }, itemsAvailable: true, items: [] });
  const snap2 = adapter.getSnapshot().telemetry;
  assert.equal(snap2.itemsAvailable, true);
  assert.deepEqual(snap2.items, []);
  assert.equal(adapter.capabilities().commands.includes('useWith'), true);

  provider.emit({ seq: 3, sampledAtMs: 30, player: { name: 'Ash', id: 1, hp: 100, pos: { x: 2962, y: 2268, z: 7 } }, itemsAvailable: false, items: [corpse] });
  assert.equal(adapter.getSnapshot().telemetry.itemsAvailable, false);
  assert.deepEqual(adapter.getSnapshot().telemetry.items, []);
  assert.equal(adapter.capabilities().commands.includes('useWith'), false);

  await adapter.close();
});

test('createChainProvider propaga --items e --tile-blocks-rva quando configurado', async () => {
  const spawned = [];
  const child = { stdout: { setEncoding() {}, on() {}, removeAllListeners() {} }, on() {}, removeAllListeners() {}, kill() {} };
  const provider = createChainProvider({
    mode: 'live',
    pid: 15280,
    chainRva: '0x3A03598',
    mapTileBlocksRva: '0x3a047d0',
    tileRadius: 2,
    spawnImpl: (cmd, args) => { spawned.push({ cmd, args }); return child; },
  });
  provider.start(() => {});
  assert.equal(spawned.length, 1);
  assert.ok(spawned[0].args.includes('--items'));
  assert.ok(spawned[0].args.includes('--tile-blocks-rva'));
  assert.ok(spawned[0].args.includes('0x3a047d0'));
  assert.ok(spawned[0].args.includes('--tile-radius'));
  assert.ok(spawned[0].args.includes('2'));
  provider.stop();
});

test('adapter tolera intervalo de 5000 ms sem marcar stale antes de 2*intervalMs+1000', async () => {
  let nowMs = 10_000;
  const provider = fakeProvider();
  const sink = fakeSink();
  const adapter = await openChainAdapter({
    pid: 7,
    config: { telemetry: { mode: 'chain', intervalMs: 5000 } },
    provider,
    sink,
    now: () => nowMs,
  });
  provider.emit({ seq: 1, sampledAtMs: 10_000, player: { name: 'Ash', id: 1, hp: 100, pos: { x: 100, y: 200, z: 7 } } });
  nowMs = 15_000;
  const fresh = adapter.getSnapshot();
  assert.equal(fresh.stale, false);
  assert.equal(fresh.ageMs, 5000);
  assert.equal(fresh.telemetry.mode, 'chain');
  assert.equal(fresh.telemetry.intervalMs, 5000);
  nowMs = 22_000;
  const expired = adapter.getSnapshot();
  assert.equal(expired.stale, true);
  await adapter.close();
});

test('EngineRuntime em modo chain executa walker e aceita ACK {status:0, delivered:true}', async () => {
  const { EngineRuntime } = require('../reconstruction/engine-runtime.cjs');
  let nowMs = 1_000;
  const provider = fakeProvider();
  const sink = fakeSink();
  const runtime = new EngineRuntime({
    now: () => nowMs,
    automatic: false,
    openAdapter: async options => openChainAdapter({ ...options, provider, sink, now: () => nowMs }),
  });
  const config = {
    telemetry: { mode: 'chain', intervalMs: 5000 },
    walker: {
      waypoints: [
        { action: 'walk', pos: { x: 100, y: 200, z: 7 } },
        { action: 'walk', pos: { x: 101, y: 200, z: 7 } },
      ],
    },
  };
  await runtime.setModules('walker', true, 7, config);
  provider.emit({ seq: 1, sampledAtMs: 2_000, player: { name: 'Ash', id: 42, hp: 100, pos: { x: 99, y: 200, z: 7 } }, creaturesAvailable: true, creatures: [] });
  nowMs = 2_100;
  const tick1 = await runtime.tick();
  assert.equal(tick1.status, 'walker');
  assert.deepEqual(tick1.faults, []);
  assert.equal(tick1.emitted.length, 1);
  assert.equal(tick1.emitted[0][0], 'walk');
  assert.equal(sink.calls.length, 1);
  await runtime.close();
});

test('walker-input-ui aceita sessao chain nao-stale com ageMs=4500', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const src = fs.readFileSync(path.join(__dirname, '..', 'reconstruction', 'walker-input-ui.js'), 'utf8');
  const model = {
    validPosition: pos => Boolean(pos && Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z)),
    currentPosition: () => null,
  };
  const win = { PkaWalker: model };
  vm.runInNewContext(src, { window: win });
  const pos = model.currentPosition({
    online: true,
    stale: false,
    ageMs: 4500,
    telemetry: { source: 'chain', nativeVerified: true, position: { x: 2970, y: 2265, z: 7 } },
  });
  assert.deepEqual(pos, { x: 2970, y: 2265, z: 7 });
});

test('T5: PROD_MIN_INTERVAL_MS >= 5000 e provider inclui --no-scan', () => {
  const { PROD_MIN_INTERVAL_MS } = require('../reconstruction/telemetry/chain-provider.cjs');
  assert.ok(PROD_MIN_INTERVAL_MS >= 5000);
  const spawned = [];
  const child = { stdout: { setEncoding() {}, on() {}, removeAllListeners() {} }, on() {}, removeAllListeners() {}, kill() {} };
  const provider = createChainProvider({
    mode: 'live',
    pid: 15280,
    chainRva: '0x3A03598',
    spawnImpl: (cmd, args) => { spawned.push({ cmd, args }); return child; },
  });
  provider.start(() => {});
  assert.ok(spawned[0].args.includes('--no-scan'));
  provider.stop();
});

test('T3: mode replay usa replayAdapter com zero spawns e adapterFor padrao e chain', async () => {
  const { EngineRuntime } = require('../reconstruction/engine-runtime.cjs');
  const { openReplayAdapter } = require('../reconstruction/telemetry/replay-adapter.cjs');
  const runtime = new EngineRuntime({ automatic: false });
  assert.equal(runtime.adapterFor({ telemetry: { mode: 'replay' } }), openReplayAdapter);
  assert.equal(runtime.adapterFor({}), openChainAdapter);
  const replay = await openReplayAdapter({
    pid: 0,
    config: {
      telemetry: {
        mode: 'replay',
        replayFrames: [{ seq: 1, sampledAtMs: Date.now(), player: { id: 1, name: 'Ash', hp: 100, pos: { x: 10, y: 20, z: 7 } }, creaturesAvailable: true, creatures: [] }],
      },
    },
  });
  const snap = replay.getSnapshot();
  assert.equal(snap.telemetry.mode, 'replay');
  assert.equal(snap.telemetry.nativeVerified, false);
  await replay.close();
});
