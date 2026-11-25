const { app, BrowserWindow, ipcMain, protocol, net, clipboard, dialog, session, globalShortcut } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { discoverProcesses, selectPid, providerOptions, useKeyboardWalker } = require('../live-client.cjs');
const { Controller, nativeUnavailable } = require('../controller.cjs');
const { EngineRuntime } = require('../engine-runtime.cjs');
const { RpmCombatRuntime } = require('../rpm-combat-runtime.cjs');
const { rpmSession } = require('../live-session.cjs');
const nativeAdapter = require('../native-adapter.cjs');
const chainAdapter = require('../telemetry/chain-adapter.cjs');
const replayAdapter = require('../telemetry/replay-adapter.cjs');
const { ensureChannel } = require('../channel-bootstrap.cjs');
const { createSimulation } = require('../local-runtime.cjs');
const { createMonitorRuntime } = require('../monitor-runtime.cjs');
const { createRouteStore, loadWalkerProfile } = require('../route-store.cjs');
const { createCreatureSource } = require('../../tools/creature_bridge.cjs');
const { createItemSource } = require('../item-source.cjs');
const { SettingsStore, validateConfig, normalizeTelemetry, migrateTelemetry, MAX_BYTES } = require('../settings.cjs');
const { verifyExecutableForPid } = require('../executable-identity.cjs');
const { chainRvaFor } = require('../executable-profile.cjs');
const {
  shouldSpawnLegacy,
  killTree,
  createTracker,
  reapStale,
  inspectReaderDescendants,
  inspectPythonDescendants,
  validateGameProcessPid,
  bootProviders,
} = require('./provider-guard.cjs');
const os = require('node:os');
const { OtmmReader } = require('../otmm.cjs');
const root = path.resolve(__dirname, '../..');
require(path.join(root, 'extracted_v3.3.1/bytecode-runtime.cjs'));
const configSharing = require(path.join(root, 'extracted_v3.3.1/lib/config-sharing.jsc'));
const smoke = process.argv.includes('--smoke');
const audit = process.argv.includes('--audit');
const hasSingleInstanceLock = (smoke || audit || process.env.PKA_ALLOW_MULTI_INSTANCE === '1')
  ? true
  : app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}
// Diagnostics mode enables the separate `pkaDiag` surface (local simulation).
// It is off in a normal launch; use --dev, --audit/--smoke or PKA_DIAGNOSTICS=1.
const diagnostics = audit || smoke || process.argv.includes('--dev') || process.env.PKA_DIAGNOSTICS === '1';
const dataRoot = path.join(root, smoke ? 'smoke-data' : audit ? 'audit-data' : 'local-data');
app.setPath('userData', path.join(dataRoot, 'electron'));
protocol.registerSchemesAsPrivileged([{ scheme: 'pka', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
let window;
let closing = false;
const failures = [];
const liveAudit = process.argv.includes('--live-ui-audit');
// Auditoria ao vivo pelo CANAL NATIVO (o caminho de producao), nao pela simulacao.
const liveChannelAudit = process.argv.includes('--live-channel-audit');
const liveAuditErrors = [];
const SNAPSHOT_FILE = path.resolve(root, process.env.PKA_SESSION_FILE || 'live-snapshot.json');
const PROVIDER = path.join(root, 'tools', 'pka_live_session.py');
let liveProvider = null;
let creatureProvider = null;
let itemProvider = null;
let itemProviderAttempt = null;
let creatureProviderAttempt = null;
const CREATURES_FILE = path.resolve(root, process.env.PKA_CREATURES_FILE || path.join(dataRoot, 'live-creatures.json'));
const ITEMS_FILE = path.resolve(root, process.env.PKA_ITEMS_FILE || path.join(dataRoot, 'live-items.json'));
const PIDFILE = path.join(dataRoot, 'providers.pid');
const providerTracker = createTracker({ pidFile: PIDFILE, spawnImpl: spawn });
let livePid = null;
let channelBackend = false;
let lastProviderState = null;
let engineRuntime = null;
let simulation = null;
let monitor = null;
let lookWindow = null;
let simEnabled = process.env.PKA_SIMULATE === '1' || process.argv.includes('--simulate');
let keyboardBackend = false;
let activeStore = null;
let activeController = null;
const verifiedBuilds = new Map();
let savingBuildSha = false;
let chainConnecting = false;
let lastChainConnectAttempt = 0;
let chainSessionStartedAt = 0;
let chainCooldownUntil = 0;

function isChainConfig(config) {
  return config?.tools?.telemetry?.mode === 'chain' || config?.telemetry?.mode === 'chain';
}

function activeNormalizedConfig() {
  if (!activeStore) return null;
  const snap = activeStore.snapshot();
  const active = snap.profiles.find(profile => profile.name === snap.activeProfile);
  return migrateTelemetry(active?.config || {});
}

function isChainModeActive() {
  if (simEnabled || smoke || audit || !activeStore) return false;
  return isChainConfig(activeNormalizedConfig());
}

function legacySpawnAllowed(configOverride) {
  const cfg = configOverride ? migrateTelemetry(configOverride) : activeNormalizedConfig();
  return shouldSpawnLegacy(cfg, { simEnabled, smoke, keyboardBackend, env: process.env });
}

function ensurePidBuildVerified(pid) {
  if (simEnabled || smoke || audit || !Number.isInteger(pid) || pid <= 0) return null;
  const cached = verifiedBuilds.get(pid);
  if (cached && (cached.path || Date.now() - cached.checkedAt < 15000)) return cached;
  const info = { ...verifyExecutableForPid(pid), checkedAt: Date.now() };
  verifiedBuilds.set(pid, info);
  if (info.supported && info.sha256 && activeStore && !savingBuildSha) {
    const snap = activeStore.snapshot();
    const active = snap.profiles.find(profile => profile.name === snap.activeProfile);
    if (active) {
      const nextConfig = normalizeTelemetry(active.config);
      if (nextConfig.tools.telemetry.executableSha256 !== info.sha256
          || nextConfig.telemetry?.executableSha256 !== info.sha256) {
        nextConfig.tools.telemetry.executableSha256 = info.sha256;
        nextConfig.telemetry.executableSha256 = info.sha256;
        savingBuildSha = true;
        activeStore.save(active.name, nextConfig).then(() => {
          if (window && !window.isDestroyed() && activeController) {
            window.webContents.send('pka:settings', activeController.settings());
          }
        }).catch(() => {}).finally(() => { savingBuildSha = false; });
      }
    }
  }
  return info;
}

function applyBuildSessionState(session) {
  if (!session || simEnabled || smoke || audit) return session;
  const build = ensurePidBuildVerified(session.pid);
  if (build && build.path && !build.supported) {
    return { ...session, online: false, error: 'unsupported-build' };
  }
  return session;
}

// Diagnostics-only: (re)builds the simulation and stops the engines. Never part
// of the recovered IPC surface; only reachable through `pka-diag:simulate`.
async function toggleSimulation(enabled, options) {
  const next = enabled === true;
  // The keyboard/RPM backend is selected at startup and is the only backend
  // wired to the real client. Switching it to the local simulation at runtime
  // would leave the menu pointing at a runtime that cannot read the game, so
  // the diagnostic toggle refuses instead of silently killing automation.
  if (keyboardBackend) {
    if (next) throw Error('Simulacao local indisponivel no backend keyboard-rpm. Inicie com PKA_SIMULATE=1 para usar a simulacao.');
    return { enabled: false };
  }
  simEnabled = next;
  simulation = createSimulation({ pid: 777,
    creatures: options && Array.isArray(options.creatures) ? options.creatures : undefined,
    health: options && Number.isFinite(options.health) ? options.health : undefined,
    activeSlot: options && Number.isInteger(options.activeSlot) ? options.activeSlot : undefined });
  // Close the runtime so the next module start reconnects to THIS simulation.
  if (engineRuntime && next) engineRuntime.frameAutomation = null;
  await engineRuntime?.close().catch(() => {});
  return { enabled: simEnabled };
}

function ensureLookWindow() {
  if (lookWindow && !lookWindow.isDestroyed()) return lookWindow;
  lookWindow = new BrowserWindow({ width: 340, height: 220, show: false, resizable: false,
    minimizable: false, maximizable: false, fullscreenable: false, frame: false, skipTaskbar: true,
    webPreferences: { preload: path.join(__dirname, 'ui', 'look-preload.cjs'), sandbox: true,
      contextIsolation: true, nodeIntegration: false, webSecurity: true } });
  lookWindow.on('closed', () => { lookWindow = null; });
  lookWindow.loadURL('pka://app/look.html');
  return lookWindow;
}

// Opens/updates the small item-ID overlay in front of the game (look feature).
function showLook(look, pinned) {
  const value = look && typeof look === 'object' ? look : {};
  const win = ensureLookWindow();
  const payload = { title: String(value.title ?? '').slice(0, 200), id: value.id,
    detail: String(value.detail ?? '').slice(0, 500), note: String(value.note ?? '').slice(0, 500) };
  const push = () => { if (!win.isDestroyed()) win.webContents.send('pka-look:show', payload); };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', push); else push();
  win.setAlwaysOnTop(pinned === true);
  win.showInactive();
  return { shown: true };
}

// Walker routes: one file per route (wk_<name>.lua), shared across profiles.
const routeStore = createRouteStore(path.join(dataRoot, 'routes'));

function registerShortcuts(tools = {}) {
  globalShortcut.unregisterAll();
  const result = { registered: false, menu: false, pause: false };
  const menuKey = typeof tools.menuHotkey === 'string' ? tools.menuHotkey.trim() : '';
  const pauseKey = typeof tools.pauseHotkey === 'string' ? tools.pauseHotkey.trim() : '';
  try {
    if (menuKey) result.menu = globalShortcut.register(menuKey, () => {
      if (!window || window.isDestroyed()) return;
      if (window.isVisible()) window.hide(); else { window.show(); window.focus(); }
    });
  } catch { result.menu = false; }
  try {
    if (pauseKey) result.pause = globalShortcut.register(pauseKey, () => {
      void engineRuntime?.togglePause().catch(() => {});
    });
  } catch { result.pause = false; }
  result.registered = result.menu || result.pause;
  return result;
}

function providerStatus(value) {
  const previousError = lastProviderState?.error;
  lastProviderState = { ...lastProviderState, ...value, error: Object.hasOwn(value, 'error') ? value.error : previousError || null };
  try {
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.writeFileSync(path.join(dataRoot, 'live-provider-status.json'), JSON.stringify({
      generatedAt: new Date().toISOString(), pid: livePid, ...lastProviderState,
    }, null, 2));
  } catch {}
  if (lastProviderState.error && previousError !== lastProviderState.error && window && !window.isDestroyed()
      && !window.webContents.isLoading()) {
    window.webContents.send('pka:notice', { kind: 'error', message: lastProviderState.error });
  }
}

function startCreatureProvider(python, pid, playerName, normalizedConfig) {
  if (typeof legacySpawnAllowed === 'function' && !legacySpawnAllowed(normalizedConfig)) return;
  if (process.env.PKA_CREATURES_FILE || creatureProvider
      || typeof playerName !== 'string' || !playerName.trim()
      || !Number.isInteger(pid) || pid <= 0) return;
  const identity = JSON.stringify([pid, playerName.trim()]);
  if (creatureProviderAttempt === identity) return;
  creatureProviderAttempt = identity;
  const spawner = typeof providerTracker !== 'undefined' ? providerTracker.spawnTracked : spawn;
  const child = spawner(python, [path.join(root, 'tools/scan_creatures.py'), '--pid', String(pid),
    '--player-name', playerName.trim(), '--stream', '--interval-ms', '300',
    '--output', CREATURES_FILE], { cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  creatureProvider = child;
  child.stderr.on('data', value => console.error('creature scanner:', value.toString().trim()));
  child.on('error', error => {
    console.error('creature scanner:', error.message);
    if (creatureProvider === child) { creatureProvider = null; creatureProviderAttempt = null; }
  });
  child.on('exit', code => {
    console.error('creature scanner exit:', code);
    if (creatureProvider === child) {
      creatureProvider = null;
      setTimeout(() => { if (creatureProviderAttempt === identity) creatureProviderAttempt = null; }, 10000);
    }
  });
}

function startItemProvider(python, pid, playerName, normalizedConfig) {
  if (typeof legacySpawnAllowed === 'function' && !legacySpawnAllowed(normalizedConfig)) return;
  if (!keyboardBackend || process.env.PKA_ITEMS_FILE || itemProvider
      || typeof playerName !== 'string' || !playerName.trim()) return;
  const identity = JSON.stringify([pid, playerName.trim()]);
  if (itemProviderAttempt === identity) return;
  itemProviderAttempt = identity;
  const spawner = typeof providerTracker !== 'undefined' ? providerTracker.spawnTracked : spawn;
  const child = spawner(python, [path.join(root, 'tools/scan_items.py'), '--pid', String(pid),
    '--player', playerName.trim(), '--output', ITEMS_FILE, '--interval', '0.2'],
  { cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  itemProvider = child;
  child.stderr.on('data', value => console.error('item scanner:', value.toString().trim()));
  child.on('error', error => console.error('item scanner:', error.message));
  child.on('exit', code => {
    console.error('item scanner exit:', code);
    if (itemProvider === child) {
      itemProvider = null;
      setTimeout(() => { if (itemProviderAttempt === identity) itemProviderAttempt = null; }, 60000);
    }
  });
}

function startLiveProvider(normalizedConfig) {
  if (smoke || audit || liveProvider || !fs.existsSync(PROVIDER)) return;
  if (typeof legacySpawnAllowed === 'function' && !legacySpawnAllowed(normalizedConfig)) return;
  if (typeof isChainModeActive === 'function' && isChainModeActive()) return;
  const python = process.env.PKA_PYTHON || 'python';
  try {
    const options = providerOptions(root, process.env, discoverProcesses());
    livePid = options.pid;
    const build = typeof ensurePidBuildVerified === 'function' ? ensurePidBuildVerified(livePid) : null;
    const chainRva = typeof chainRvaFor === 'function'
      ? (chainRvaFor(normalizedConfig?.telemetry?.executableSha256 || build?.sha256) || '0x3A03598')
      : null;
    const extraArgs = chainRva ? ['--chain-rva', chainRva, '--no-scan', '--creatures-interval-s', '5'] : ['--creatures-interval-s', '5'];
    const spawner = typeof providerTracker !== 'undefined' ? providerTracker.spawnTracked : spawn;
    liveProvider = spawner(python, [PROVIDER, ...options.args, ...extraArgs],
      { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    startCreatureProvider(python, livePid, process.env.PKA_PLAYER_NAME, normalizedConfig);
    startItemProvider(python, livePid, process.env.PKA_PLAYER_NAME, normalizedConfig);
    providerStatus({ status: 'starting' });
    createInterface({ input: liveProvider.stdout }).on('line', line => {
      try {
        const status = JSON.parse(line);
        if (status.ok && status.pid === livePid) {
          startCreatureProvider(python, livePid, status.player?.name, normalizedConfig);
          startItemProvider(python, livePid, status.player?.name, normalizedConfig);
        }
        providerStatus({ status: status.ok ? 'observing' : status.errorCode === 'process-access-denied' ? 'blocked' : 'waiting',
          error: status.error || null, errorCode: status.errorCode || null, win32Error: status.win32Error ?? null });
      } catch {}
    });
    createInterface({ input: liveProvider.stderr }).on('line', line => {
      providerStatus({ status: 'error', error: line.slice(0, 2000) });
    });
    liveProvider.on('error', error => { providerStatus({ status: 'error', error: error.message }); liveProvider = null; });
    liveProvider.on('exit', code => {
      providerStatus({ status: 'stopped', exitCode: code });
      liveProvider = null;
      livePid = null;
      creatureProviderAttempt = null;
      itemProviderAttempt = null;
    });
  } catch (error) {
    providerStatus({ status: 'waiting', error: error.message });
    liveProvider = null;
    livePid = null;
  }
}


const roamingDir = path.join(os.homedir(), 'AppData', 'Roaming', 'PokeAlliance', 'PokeAllianceV3');
const defaultMapFile = path.join(roamingDir, 'minimap854.otmm');
let activeMap = null;
let activeMapMtime = 0;
let activeMapSource = 'default';
let mapError = null;

function mapStat() {
  try { return fs.statSync(defaultMapFile); } catch { return null; }
}

function loadDefaultMap(force = false) {
  const stat = mapStat();
  if (!force && activeMapSource === 'custom' && activeMap) return activeMap;
  if (!force && activeMap && stat && activeMapMtime === stat.mtimeMs) return activeMap;
  if (!stat) {
    mapError = 'Mapa padrao nao encontrado em ' + defaultMapFile + '. Abra um arquivo OTMM valido.';
    if (force) activeMap = null;
    return activeMap;
  }
  try {
    activeMap = new OtmmReader(defaultMapFile);
    activeMapMtime = stat.mtimeMs;
    activeMapSource = 'default';
    mapError = null;
  } catch (error) {
    mapError = error.message;
    if (force) activeMap = null;
  }
  return activeMap;
}

function mapInfo(controller) {
  const map = loadDefaultMap();
  const sessionPos = controller.sessions?.[0]?.telemetry?.position || controller.sessions?.[0]?.position;
  return {
    custom: activeMapSource === 'custom',
    filename: map ? map.filename : 'minimap854.otmm',
    first: sessionPos || (map && map.first) || { x: 3299, y: 2219, z: 7 },
    blocks: map ? map.index.size : 0,
    floors: map ? [...map.floors].sort((a, b) => a - b) : [],
    atlas: false,
    error: map ? null : mapError,
  };
}

function stopLiveProvider() {
  itemProviderAttempt = null;
  creatureProviderAttempt = null;
  providerTracker.stopAll();
  if (itemProvider) { killTree(itemProvider.pid); try { itemProvider.kill(); } catch {} itemProvider = null; }
  if (creatureProvider) { killTree(creatureProvider.pid); try { creatureProvider.kill(); } catch {} creatureProvider = null; }
  if (!liveProvider) return;
  killTree(liveProvider.pid);
  try { liveProvider.kill(); } catch (_) { /* ignore */ }
  liveProvider = null;
}

function getLiveSessions() {
  if (smoke) return [];
  if (simEnabled && simulation) return [simulation.snapshot()];
  if (!fs.existsSync(SNAPSHOT_FILE)) {
    if (livePid) {
      const build = ensurePidBuildVerified(livePid);
      if (build && build.path && !build.supported) {
        return [{ pid: livePid, online: false, stale: false, ageMs: 0, error: 'unsupported-build', telemetry: {} }];
      }
    }
    return [];
  }
  try {
    const raw = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
    if (raw.pid !== livePid) return [];
    const session = rpmSession(raw);
    return session ? [applyBuildSessionState(session)] : [];
  } catch (_) {
    return [];
  }
}

const ready = app.whenReady().then(async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'asset-manifest.json')));
  const resources = new Map(manifest.files.map(file => ['/' + file.path, path.join(__dirname, 'ui', file.path)]));
  protocol.handle('pka', request => {
    const url = new URL(request.url);
    const file = url.hostname === 'app' && resources.get(url.pathname);
    if (!file) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).href);
  });
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  const store = new SettingsStore(path.join(dataRoot, 'profiles'));
  await store.load();
  const loadedSnap = store.snapshot();
  if (loadedSnap.profiles.some(p => !p.config?.tools?.telemetry || !p.config?.telemetry)) {
    await store.transact(data => ({
      ...data,
      profiles: data.profiles.map(p => ({ ...p, config: migrateTelemetry(p.config) })),
    }));
  }
  activeStore = store;
  const reaped = reapStale({ pidFile: PIDFILE, rootDir: root, reconcileLive: true });
  if (reaped.length) console.warn('[reaper] encerrou processos orfaos:', reaped.join(', '));
  if (!smoke && !audit) {
    const preBoot = inspectReaderDescendants(process.pid);
    if (preBoot.readers.length || preBoot.python.length) {
      console.error('[guard] leitores residuais antes do boot:', preBoot.readers.map(p => p.ProcessId));
    }
  }
  simulation = createSimulation({ pid: 777 });
  // Only the audit/smoke harnesses force the non-keyboard runtime; the separate
  // diagnostics surface (--dev, PKA_DIAGNOSTICS=1) must keep the real
  // keyboard-rpm backend so Iniciar actually reaches the game. Simulation still
  // selects the native/simulation runtime through simEnabled/--simulate.
  /* Sem PKA_CHANNEL_KEY(_FILE) a UI cairia no teclado. Como a interface ja
   * injeta sozinha, exponha a chave do arquivo padrao antes de decidir. */
  if (!process.env.PKA_CHANNEL_KEY && !process.env.PKA_CHANNEL_KEY_FILE) {
    try {
      const key = fs.readFileSync(path.join(root, 'native', 'pka_channel_key.txt'), 'utf8').trim();
      if (key) process.env.PKA_CHANNEL_KEY = key;
    } catch { /* sem arquivo: segue o backend keyboard */ }
  }
  const startupSnap = store.snapshot();
  const startupProfile = startupSnap.profiles.find(profile => profile.name === startupSnap.activeProfile);
  const startupChain = !simEnabled && !audit && !smoke && isChainConfig(startupProfile?.config);
  const keyboardWalker = startupChain ? false : useKeyboardWalker(process.env, audit || smoke, simEnabled);
  keyboardBackend = keyboardWalker && !smoke;
  engineRuntime = smoke ? null : keyboardWalker ? new RpmCombatRuntime({
    mapProvider: () => loadDefaultMap(),
    getSession: () => getLiveSessions()[0] || null,
    playerName: process.env.PKA_PLAYER_NAME,
    creatureSource: createCreatureSource(CREATURES_FILE),
    itemSource: createItemSource(ITEMS_FILE),
    transportFile: path.resolve(root, process.env.PKA_COMBAT_CONFIG || 'local-data/keyboard-combat.json'),
    onDispatch: record => fs.appendFileSync(path.join(dataRoot, 'combat-dispatch.jsonl'), JSON.stringify(record) + '\n'),
  }) : new EngineRuntime({
    creatureSource: process.env.PKA_CREATURES_FILE ? createCreatureSource(process.env.PKA_CREATURES_FILE) : undefined,
    /* Mapa para o pathfinding do walker. `activeMap` e' o mapa carregado na
     * aba do menu; sem ele, tenta o padrao. Falha de leitura nao derruba a
     * automacao: o walker so' cai no guloso. */
    mapProvider: simEnabled ? undefined : () => loadDefaultMap(),
    openAdapter: async options => {
      if (simEnabled) return simulation.open(options);
      const cfg = migrateTelemetry(options?.config || {});
      const mode = cfg.telemetry.mode;
      if (mode === 'replay') return replayAdapter.open({ ...options, config: cfg });
      if (mode === 'chain') return chainAdapter.open({ ...options, pidFile: PIDFILE, config: cfg });
      /* A interface injeta sozinha (modulo neutro) quando o canal nao existe.
       * Falha aqui nao impede o keyboard backend: ele so' conecta depois. */
      const channel = await ensureChannel(options?.pid || Number(process.env.PKA_PID) || 0, { root,
        inject: process.env.PKA_NO_INJECT !== '1' });
      if (!channel.injected && channel.reason && channel.reason !== 'pipe-present' && channel.reason !== 'pipe-ready') {
        console.warn('[channel] ' + channel.reason);
      }
      return nativeAdapter.open(options);
    },
  });
  channelBackend = !simEnabled && !keyboardWalker && !smoke && !audit;
  const bootLegacyIfAllowed = cfg => {
    const res = bootProviders(cfg, {
      simEnabled,
      smoke,
      keyboardBackend,
      startLegacy: legacyCfg => startLiveProvider(legacyCfg),
    });
    if (res.legacySpawned) {
      lastProviderState = {
        status: 'legacy',
        legacy: true,
        error: 'Modo legado Python ativo' + (process.env.PKA_LEGACY_PYTHON === '1' ? ' (PKA_LEGACY_PYTHON=1).' : '.'),
      };
    }
    return res;
  };
  const reconnectToPid = async newPid => {
    if (Date.now() < chainCooldownUntil) return false;
    const pidCheck = validateGameProcessPid(newPid);
    if (!pidCheck.valid) return false;
    const build = ensurePidBuildVerified(newPid);
    if (build && build.path && !build.supported) return false;
    await engineRuntime?.close().catch(() => {});
    stopLiveProvider();
    reapStale({ pidFile: PIDFILE, rootDir: root, reconcileLive: true });
    const activeCfg = activeNormalizedConfig();
    await engineRuntime.connect(newPid, activeCfg || undefined);
    chainSessionStartedAt = Date.now();
    bootLegacyIfAllowed(activeCfg);
    console.log('[chain] conectado pid=' + newPid);
    return true;
  };
  if (channelBackend) {
    try {
      const pids = discoverProcesses();
      const pid = selectPid(pids, process.env.PKA_PID);
      const ok = await reconnectToPid(pid);
      if (!ok) throw Error('unsupported-or-invalid-pid');
    } catch (error) {
      console.warn('[channel] auto-connect: ' + error.message);
    }
  }
  const bootCfg = activeNormalizedConfig();
  bootLegacyIfAllowed(bootCfg);
  monitor = createMonitorRuntime({
    // A sessao tem que vir do backend ATIVO: no canal nativo ela esta no adapter
    // (EngineRuntime.sessions); no backend keyboard, no provider RPM. Ler sempre
    // o provider deixava o monitor sem sessao quando o canal nativo esta em uso.
    getSession: () => {
      const own = keyboardBackend ? null : engineRuntime?.sessions?.[0];
      return own || controller?.sessions?.[0] || null;
    },
    send: (channel, value) => { if (window && !window.isDestroyed()) window.webContents.send(channel, value); },
    onPause: () => { void engineRuntime?.pause().catch(() => {}); },
  });
  const runtimeConfig = config => {
    if (!config) return config;
    const normalized = normalizeTelemetry(config);
    if (!simEnabled) return normalized;
    const { telemetry: _ignored, ...rest } = normalized;
    return rest;
  };
  const runtimePort = !engineRuntime ? null : {
    get sessions() { return (engineRuntime.sessions || []).map(applyBuildSessionState); },
    get state() {
      const state = engineRuntime.state;
      const build = !simEnabled && state?.pid ? verifiedBuilds.get(state.pid) : null;
      return build && build.path && !build.supported ? { ...state, error: 'unsupported-build' } : state;
    },
    togglePause: () => engineRuntime.togglePause(),
    updateConfig: config => engineRuntime.updateConfig?.(runtimeConfig(config)),
    setModules: async (module, enabled, pid, config) => {
      if (enabled && !simEnabled && Number.isInteger(pid) && pid > 0) {
        const build = ensurePidBuildVerified(pid);
        if (build && build.path && !build.supported) throw Error('unsupported-build');
      }
      return engineRuntime.setModules(module, enabled, pid, runtimeConfig(config));
    },
  };
  const controller = new Controller(store, {
    copyText: text => clipboard.writeText(text),
    quit: async () => {
      try { lookWindow?.destroy(); monitor?.close(); await engineRuntime?.close(); } finally { stopLiveProvider(); window?.destroy(); app.quit(); }
    },
    runtime: runtimePort,
    getSessions: getLiveSessions,
    command: async (pid, name, parameter) => {
      if (!engineRuntime) throw Error(nativeUnavailable);
      const build = ensurePidBuildVerified(pid);
      if (build && build.path && !build.supported) throw Error('unsupported-build');
      if (!engineRuntime.connected) {
        const current = store.snapshot();
        const active = current.profiles.find(profile => profile.name === current.activeProfile);
        await engineRuntime.connect(pid, active ? runtimeConfig(active.config) : undefined);
      }
      return engineRuntime.manualCommand(pid, name, parameter);
    },
    monitor: (enabled, pid, config) => { monitor.set(enabled, pid, config); return controller.snapshot(); },
    monitorState: () => monitor.state(),
    showLook: (look, pinned) => showLook(look, pinned),
    performance: async () => { if (window && !window.isDestroyed()) window.minimize(); return { accepted: true }; },
    mapInfo: () => mapInfo(controller),
    mapRegion: viewport => {
      const map = loadDefaultMap();
      const width = Math.max(1, Math.min(2048, viewport && viewport.width ? viewport.width : 64));
      const height = Math.max(1, Math.min(2048, viewport && viewport.height ? viewport.height : 64));
      const curPos = controller.sessions?.[0]?.telemetry?.position || controller.sessions?.[0]?.position;
      const z = viewport && Number.isInteger(viewport.z) ? Math.max(0, Math.min(15, viewport.z)) : (curPos?.z ?? map?.first?.z ?? 7);
      let x = viewport && Number.isInteger(viewport.x) ? viewport.x : (curPos ? curPos.x - Math.floor(width / 2) : (map?.first?.x || 3299) - Math.floor(width / 2));
      let y = viewport && Number.isInteger(viewport.y) ? viewport.y : (curPos ? curPos.y - Math.floor(height / 2) : (map?.first?.y || 2219) - Math.floor(height / 2));
      x = Math.max(0, Math.min(65535 - width, x));
      y = Math.max(0, Math.min(65535 - height, y));
      if (!map) throw Error(mapError || 'Mapa padrao indisponivel.');
      return map.getRegion(x, y, z, width, height);
    },
    openMap: async () => {
      const result = await dialog.showOpenDialog(window, {
        defaultPath: fs.existsSync(roamingDir) ? roamingDir : undefined,
        properties: ['openFile'],
        filters: [{ name: 'Mapa OTMM/OTM', extensions: ['otmm', 'otm'] }, { name: 'Todos os arquivos', extensions: ['*'] }]
      });
      if (result.canceled || !result.filePaths.length) return false;
      const filename = result.filePaths[0];
      try {
        const map = new OtmmReader(filename);
        activeMap = map;
        activeMapMtime = 0;
        activeMapSource = 'custom';
        mapError = null;
        return {
          custom: true,
          filename: map.filename,
          first: controller.sessions?.[0]?.telemetry?.position || map.first,
          blocks: map.index.size,
          floors: [...map.floors].sort((a, b) => a - b),
          error: null,
        };
      } catch (error) {
        return {
          custom: activeMapSource === 'custom',
          filename: activeMap ? activeMap.filename : path.basename(filename),
          first: controller.sessions?.[0]?.telemetry?.position || (activeMap && activeMap.first) || { x: 3299, y: 2219, z: 7 },
          error: 'Nao foi possivel abrir esse mapa. Use um arquivo OTMM valido, como minimap854.otmm.',
        };
      }
    },
    resetMap: () => {
      activeMapSource = 'default';
      loadDefaultMap(true);
      return mapInfo(controller);
    },
    walkerProfiles: () => routeStore.list(),
    loadWalkerProfile: (id, config) => loadWalkerProfile(routeStore, id, config),
    saveRoute: (id, config, options) => routeStore.save(id, config, options),
    shortcuts: tools => registerShortcuts(tools),
    importProfile: async () => {
      const result = await dialog.showOpenDialog(window, { properties: ['openFile'], filters: [{ name: 'Perfil JSON', extensions: ['json'] }] });
      if (result.canceled) return false;
      const filename = result.filePaths[0];
      if (fs.statSync(filename).size > MAX_BYTES) throw Error('Perfil excedeu o limite de tamanho.');
      const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
      return { filename: path.basename(filename), config: validateConfig(value.config || value), warnings: [] };
    },
    exportProfile: async config => {
      const normalized = validateConfig(config);
      const result = await dialog.showSaveDialog(window, { defaultPath: 'perfil-pka.json', filters: [{ name: 'Perfil JSON', extensions: ['json'] }] });
      if (result.canceled) return false;
      fs.writeFileSync(result.filePath, JSON.stringify({ format: 'pka-reconstruction-1', config: normalized }, null, 2) + '\n', 'utf8');
      return true;
    },
    exportSharedProfile: async (config, options, profileName) => {
      const active = store.snapshot().profiles.find(p => p.name === (profileName || store.snapshot().activeProfile));
      const conf = config || active?.config;
      const res = await configSharing.exportSharedConfig(conf, options, routeStore);
      if (res?.text) {
        clipboard.writeText(res.text);
        res.copied = true;
      }
      return res;
    },
    inspectSharedProfile: (text, profileName) => {
      const decoded = configSharing.decodeSharedConfig(text);
      return configSharing.shareSummary(decoded);
    },
    importSharedProfile: async (text, profileName) => {
      const active = store.snapshot().profiles.find(p => p.name === (profileName || store.snapshot().activeProfile));
      const baseConf = active?.config || validateConfig({});
      const merged = configSharing.mergeSharedConfig(text, baseConf);
      if (merged?.route && routeStore) {
        const routeName = merged.route.name || 'Importado';
        await routeStore.save(routeName, merged.config, { waypoints: merged.route.waypoints });
      }
      return merged.config;
    },
    clearAlertHistory: () => true,
    copyAlertHistory: () => true,
    guildDailyReset: () => ({ accepted: true }),
  });
  activeController = controller;
  window = new BrowserWindow({ width: 1180, height: 880, show: !smoke && !audit,
    title: 'PKA Tools - reconstrucao local',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true,
      contextIsolation: true, nodeIntegration: false, webSecurity: true,
      additionalArguments: diagnostics ? ['--pka-diagnostics'] : [] } });
  engineRuntime?.on('change', () => {
    if (window && !window.isDestroyed()) window.webContents.send('pka:snapshot', controller.snapshot());
    const state = engineRuntime.state;
    if (state.status === 'error' && state.error && window && !window.isDestroyed()) {
      window.webContents.send('pka:notice', { kind: 'error', message: state.error });
    }
  });
  window.on('closed', () => { monitor?.close(); void engineRuntime?.close().catch(error => failures.push({ kind: 'runtime-close', message: error.message })); });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.once('did-finish-load', () => {
    if (lastProviderState?.error && window && !window.isDestroyed()) {
      window.webContents.send('pka:notice', {
        kind: lastProviderState.legacy ? 'warning' : 'error',
        message: lastProviderState.error,
      });
    }
  });
  window.on('page-title-updated', event => event.preventDefault());
  window.on('close', event => {
    if (closing || smoke) return;
    event.preventDefault();
    closing = true;
    window.webContents.send('pka:closing');
  });
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('render-process-gone', (event, details) => failures.push({ kind: 'renderer', reason: details.reason }));
  window.webContents.on('console-message', (event, ...args) => {
    const details = typeof args[0] === 'object' ? args[0] : { level: args[0], message: args[1] };
    if (details.level === 'error' || details.level === 3) failures.push({ kind: 'console', message: details.message });
  });
  for (const channel of controller.channels()) {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!window || window.isDestroyed()) return undefined;
      if (event.sender !== window.webContents ||
          event.senderFrame !== window.webContents.mainFrame ||
          event.senderFrame.url !== 'pka://app/index.html') throw Error('Origem IPC nao permitida.');
      try { return await controller.invoke(channel, ...args); }
      catch (error) {
        if (liveAudit) liveAuditErrors.push({ at: new Date().toISOString(), channel, error: error.message });
        throw error;
      }
    });
  }
  controller.on('settings', settings => window.webContents.send('pka:settings', settings));
  if (diagnostics) {
    const diagGuard = event => {
      if (!window || window.isDestroyed()) return false;
      if (event.sender !== window.webContents ||
          event.senderFrame !== window.webContents.mainFrame ||
          event.senderFrame.url !== 'pka://app/index.html') throw Error('Origem IPC nao permitida.');
      return true;
    };
    ipcMain.handle('pka-diag:simulate', (event, enabled, options) =>
      diagGuard(event) ? toggleSimulation(enabled, options) : undefined);
    ipcMain.handle('pka-diag:status', event => {
      if (!diagGuard(event) || !simulation) return null;
      const state = simulation.state;
      return { enabled: simEnabled, pid: simulation.pid, tick: state.tick,
        position: { ...state.position }, activeSlot: state.activeSlot,
        pokemonName: state.pokemonName, targetId: state.targetId,
        health: state.health, lastCommand: state.lastCommand || null };
    });
  }
  ipcMain.handle('pka-look:copy', (event, text) => {
    if (!lookWindow || lookWindow.isDestroyed() || event.sender !== lookWindow.webContents) return false;
    clipboard.writeText(String(text));
    return true;
  });
  ipcMain.on('pka-look:close', event => {
    if (lookWindow && !lookWindow.isDestroyed() && event.sender === lookWindow.webContents) lookWindow.hide();
  });
  await window.loadURL('pka://app/index.html');
  const showStatus = () => {
    if (smoke) {
      window.webContents.send('pka:notice', { kind: 'warning', message: 'Reconstru\u00e7\u00e3o parcial: perfis locais dispon\u00edveis. A automa\u00e7\u00e3o no jogo est\u00e1 desativada nesta vers\u00e3o.' });
    }
  };
  showStatus();
  if (!smoke) {
    const checkReaderInvariant = () => {
      if (simEnabled || audit) return;
      const cfg = activeNormalizedConfig();
      const mode = cfg?.telemetry?.mode || 'chain';
      if (mode === 'native' || legacySpawnAllowed(cfg)) return;
      const seen = inspectReaderDescendants(process.pid);
      if (seen.python.length > 0 || seen.readerRoots.length > 1) {
        const msg = '[invariant] leitores fora do esperado (' + mode + '): python='
          + seen.python.length + ', readers=' + seen.readerRoots.length;
        console.error(msg);
        if (seen.readerRoots.length > 1) {
          for (const extra of seen.readerRoots.slice(1)) killTree(Number(extra.ProcessId));
        }
        if (window && !window.isDestroyed() && !window.webContents.isLoading()) {
          window.webContents.send('pka:notice', { kind: 'error', message: msg });
        }
      }
    };
    const invariantTimers = [5000, 30000, 120000].map(ms => {
      const t = setTimeout(checkReaderInvariant, ms);
      t.unref?.();
      return t;
    });
    const invariantInterval = setInterval(checkReaderInvariant, 60000);
    invariantInterval.unref?.();

    const liveTimer = setInterval(() => {
      if (!window || window.isDestroyed()) {
        clearInterval(liveTimer);
        return;
      }
      if (!liveProvider && !simEnabled && legacySpawnAllowed()) {
        startLiveProvider(activeNormalizedConfig());
      }
      if (!audit && !simEnabled && engineRuntime && isChainModeActive()) {
        const cfg = activeNormalizedConfig();
        const maxMin = Number(cfg?.telemetry?.maxSessionMin) || 20;
        const cooldownMin = Number(cfg?.telemetry?.cooldownMin ?? 5);
        if (engineRuntime.connected && chainSessionStartedAt > 0
            && Date.now() - chainSessionStartedAt >= maxMin * 60000) {
          chainSessionStartedAt = 0;
          chainCooldownUntil = Date.now() + cooldownMin * 60000;
          chainConnecting = true;
          Promise.resolve().then(async () => {
            await engineRuntime.close();
            stopLiveProvider();
            const msg = 'Sessao chain encerrada (teto ' + maxMin + ' min). Cooldown de ' + cooldownMin + ' min.';
            console.warn('[chain] ' + msg);
            if (window && !window.isDestroyed()) {
              window.webContents.send('pka:notice', { kind: 'warning', message: msg });
            }
          }).catch(() => {}).finally(() => { chainConnecting = false; });
        } else if (!chainConnecting && Date.now() >= chainCooldownUntil
            && Date.now() - lastChainConnectAttempt >= 5000) {
          lastChainConnectAttempt = Date.now();
          chainConnecting = true;
          Promise.resolve().then(async () => {
            if (engineRuntime.connected && engineRuntime.pid) {
              const alive = validateGameProcessPid(engineRuntime.pid);
              if (alive.valid) return;
              console.warn('[chain] PID do jogo encerrado (' + engineRuntime.pid + '); limpando sessao');
              chainSessionStartedAt = 0;
              await engineRuntime.close();
              stopLiveProvider();
            }
            const pids = discoverProcesses();
            if (!pids.length) return;
            const pid = selectPid(pids, process.env.PKA_PID);
            await reconnectToPid(pid);
          }).catch(() => {}).finally(() => { chainConnecting = false; });
        }
      }
      window.webContents.send('pka:snapshot', controller.snapshot());
    }, 1000);
    window.on('closed', () => {
      clearInterval(liveTimer);
      clearInterval(invariantInterval);
      for (const t of invariantTimers) clearTimeout(t);
    });
  }
  if (liveAudit) {
    if (!keyboardWalker || diagnostics || simEnabled) throw Error('Live audit requires the real keyboard/RPM backend.');
    const report = await require('./live-audit.cjs').runLiveAudit(window, engineRuntime, getLiveSessions);
    report.ipcErrors = liveAuditErrors;
    report.failures = failures;
    fs.writeFileSync(path.join(root, 'live-ui-audit.json'), JSON.stringify(report, null, 2) + '\n');
    monitor.close();
    await engineRuntime.close();
    stopLiveProvider();
    window.destroy();
    app.quit();
    return;
  }
  if (liveChannelAudit) {
    // Exige o canal nativo: sem PKA_CHANNEL_KEY(_FILE) o runtime seria o keyboard
    // e a medicao nao seria do caminho de producao.
    if (keyboardWalker || simEnabled) {
      throw Error('Live channel audit requires the native channel (PKA_CHANNEL_KEY_FILE).');
    }
    let report;
    try {
      report = await require('./live-channel-audit.cjs').runLiveChannelAudit(window, engineRuntime,
        { pid: livePid || Number(process.env.PKA_PID) || 0 });
    } catch (error) {
      report = { ok: false, crash: error.message, checks: [], required: [] };
    }
    if (!report || typeof report !== 'object') {
      report = { ok: false, crash: 'auditoria nao devolveu relatorio', checks: [], required: [] };
    }
    report.ipcErrors = liveAuditErrors;
    report.failures = failures;
    fs.writeFileSync(path.join(root, 'live-channel-audit.json'), JSON.stringify(report, null, 2) + '\n');
    monitor.close();
    await engineRuntime.close();
    stopLiveProvider();
    window.destroy();
    app.exit(report.ok === true && failures.length === 0 && liveAuditErrors.length === 0 ? 0 : 1);
    return;
  }
  if (smoke) {
    await new Promise(resolve => setTimeout(resolve, 1400));
    const checks = await require('./smoke.cjs').runSmoke(window, store, showStatus);
    await new Promise(resolve => setTimeout(resolve, 120));
    const state = await window.webContents.executeJavaScript("({title:document.title,tabs:[...document.querySelectorAll('#tabs button')].map(node=>node.textContent),profile:document.getElementById('profile-current').textContent,formFields:document.querySelectorAll('#settings input,#settings select,#settings textarea').length,body:document.body.innerText.slice(0,4000)})");
    const image = await window.webContents.capturePage();
    fs.writeFileSync(path.join(root, 'app-smoke.png'), image.toPNG());
    fs.writeFileSync(path.join(root, 'app-smoke.json'), JSON.stringify({ state, checks, failures }, null, 2) + '\n');
    console.log(JSON.stringify({ state, checks, failures }));
    app.exit(failures.length || state.tabs.length !== 8 || state.profile !== 'Default' ? 1 : 0);
  }
  if (audit) {
    await new Promise(resolve => setTimeout(resolve, 1200));
    const report = await require('./audit.cjs').runAudit(window);
    await new Promise(resolve => setTimeout(resolve, 120));
    const image = await window.webContents.capturePage();
    fs.writeFileSync(path.join(root, 'app-audit.png'), image.toPNG());
    fs.writeFileSync(path.join(root, 'app-audit.json'), JSON.stringify({ report, failures }, null, 2) + '\n');
    console.log(JSON.stringify({ report, failures }));
    app.exit(report.ok && failures.length === 0 ? 0 : 1);
  }
});
ready.catch(error => { console.error(error.stack); app.exit(1); });
app.on('before-quit', stopLiveProvider);
app.on('will-quit', () => { stopLiveProvider(); globalShortcut.unregisterAll(); });
app.on('window-all-closed', () => { stopLiveProvider(); app.quit(); });
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { stopLiveProvider(); app.quit(); });
}
