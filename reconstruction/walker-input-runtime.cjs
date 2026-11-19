'use strict';

const { EventEmitter } = require('node:events');
const { execFile } = require('node:child_process');
const path = require('node:path');
const { createWalkerEngine, STEP_INTERVAL_MS } = require('./engines/walker-engine.cjs');
const { createPathPlanner } = require('./pathfinder.cjs');

function positionIssue(session, pid, playerName, now = Date.now()) {
  const age = now - Date.parse(session?.generatedAt);
  const pos = session?.telemetry?.position;
  if (!session || session.pid !== pid || session.source !== 'rpm') return 'Sessao RPM de outro cliente ou ausente.';
  if (!session.online || session.stale || session.error || !Number.isFinite(age) || age < 0 || age > 1000) return 'Posicao RPM desatualizada.';
  const observedName = session.telemetry?.playerName;
  // O launcher nomeia a janela "PokeAlliance - <nome>"; cliente aberto direto
  // mantem "PokeAlliance". Nos dois casos o nome observado na telemetria vale.
  const titled = session.clientWindowTitle === 'PokeAlliance - ' + observedName
    || session.clientWindowTitle === 'PokeAlliance';
  const expectedName = playerName || (titled ? observedName : '');
  if (!expectedName || observedName?.trim().toLowerCase() !== expectedName.trim().toLowerCase()) return 'Nome do jogador RPM divergente; configure PKA_PLAYER_NAME.';
  if (!pos || ![pos.x, pos.y, pos.z].every(Number.isInteger) || pos.x < 0 || pos.x >= 65535
      || pos.y < 0 || pos.y >= 65535 || pos.z < 0 || pos.z > 15) return 'Posicao RPM invalida.';
  return null;
}

function createKeyboardInput(options = {}) {
  const run = options.execFile || execFile;
  const script = path.resolve(__dirname, '../tools/walker_input.py');
  return (pid, direction, focus = false) => new Promise((resolve, reject) => {
    if (!Number.isInteger(pid) || pid <= 0 || (direction !== null && (!Number.isInteger(direction) || direction < 0 || direction > 3))) {
      reject(Error('PID ou direcao de teclado invalida.'));
      return;
    }
    const args = [script, '--pid', String(pid)];
    if (direction === null) args.push(focus ? '--focus' : '--probe');
    else args.push('--direction', String(direction));
    run(options.python || process.env.PKA_PYTHON || 'python', args,
      { windowsHide: true, timeout: 2000, maxBuffer: 16384 }, (error, stdout) => {
        let result;
        try { result = JSON.parse(stdout); } catch {
          const failure = Error('Emissor de teclado sem resposta JSON valida.');
          failure.retrySafe = false;
          failure.uncertain = true;
          return reject(failure);
        }
        if (error || !result || result.success !== true || result.pid !== pid) {
          const failure = Error(result?.error || 'Emissor de teclado rejeitou a operacao.');
          failure.result = result;
          failure.retrySafe = false;
          if (result?.success === false && result.pid === pid && result.errorCode === 'WALKER_FOCUS_LOST' && result.eventsSent === 0) {
            failure.code = 'WALKER_FOCUS_LOST';
          }
          return reject(failure);
        }
        if (result.eventsSent !== (direction === null ? 0 : 2) || result.transport !== 'PostMessageW' || result.effectVerified !== false) {
          const failure = Error('Emissor sem confirmacao de mensagens background.');
          failure.result = result;
          failure.retrySafe = false;
          return reject(failure);
        }
        resolve(result);
      });
  });
}

class WalkerInputRuntime extends EventEmitter {
  constructor(options = {}) {
    super();
    this.getSession = options.getSession || (() => null);
    this.playerName = options.playerName || '';
    this.input = options.input || createKeyboardInput();
    this.now = options.now || Date.now;
    this.stepPlanner = typeof options.mapProvider === 'function'
      ? createPathPlanner({ getMap: options.mapProvider, now: this.now, cardinalOnly: true }) : null;
    this.automatic = options.automatic !== false;
    this.pid = null;
    this.modules = [];
    this.paused = true;
    this.last = null;
    this.engine = null;
    this.timer = null;
    this.inFlight = null;
    this.epoch = 0;
    this.lastKeyDispatch = -Infinity;
    this.lastMovementDispatch = -Infinity;
    this.lastSnapshotAt = null;
    this.allowedActions = options.allowedActions || ['walk', 'wait'];
  }

  get sessions() {
    const session = this.getSession();
    if (!session) return [];
    const issue = positionIssue(session, session.pid, this.playerName, this.now());
    return [{ ...session, capabilities: { ...session.capabilities, walkerKeyboard: !issue } }];
  }

  get state() {
    const index = this.engine?.state.index || 0;
    const waypoint = this.engine ? this.engine.waypoints()[index] : null;
    return { modules: [...this.modules], pid: this.pid, paused: this.paused, backend: 'keyboard-rpm',
      status: this.last?.status || 'idle', error: this.last?.error || null,
      phase: this.last?.error || (this.paused ? 'Walker teclado pausado' : 'Walker teclado: ' + (this.last?.action || 'aguardando')),
      phases: {}, walkerIndex: index, walkerAction: waypoint?.action || null,
      pausedModules: this.paused ? [...this.modules] : [] };
  }

  get connected() { return false; }

  changed() { this.emit('change', this.state); }

  async setModules(module, enabled, pid, config) {
    if (typeof enabled !== 'boolean') throw Error('Estado do Walker invalido.');
    if (!enabled && (module === 'all' || module === 'walker')) {
      await this.pause();
      this.modules = [];
      this.changed();
      return this.state;
    }
    if (module !== 'walker' || !enabled) throw Error('Target e Healer indisponíveis no modo teclado/RPM: este backend executa somente Walker; falta integrar o backend de combate.');
    await this.pause();
    const epoch = this.epoch;
    const lastDispatch = this.pid === pid ? this.lastKeyDispatch : -Infinity;
    const lastMovementDispatch = this.pid === pid ? this.lastMovementDispatch : -Infinity;    if (!Number.isInteger(pid) || pid <= 0) throw Error('Selecione o PID do cliente.');
    const session = this.getSession();
    const issue = positionIssue(session, pid, this.playerName, this.now());
    if (issue) throw Error(issue);
    const playerName = this.playerName || session.telemetry.playerName;
    const waypoints = config?.walker?.waypoints;
    if (!Array.isArray(waypoints) || !waypoints.length) throw Error('A rota precisa de waypoints.');
    if (waypoints.some(waypoint => !this.allowedActions.includes(waypoint.action))) throw Error('Walker teclado aceita somente ' + this.allowedActions.join(', ') + '; outras acoes precisam do backend correspondente.');
    const engine = createWalkerEngine({ ...config, walker: { ...config.walker, smartWalking: true } },
      { stepPlanner: this.stepPlanner });
    for (const waypoint of engine.waypoints()) {
      const pos = waypoint.pos;
      if (pos.x < 0 || pos.x >= 65535 || pos.y < 0 || pos.y >= 65535 || pos.z < 0 || pos.z > 15) throw Error('Waypoint fora dos limites.');
      if (waypoint.action === 'wait' && (!/^[0-9]+$/.test(String(waypoint.param)) || Number(waypoint.param) > 3600000)) throw Error('Wait invalido: use 0 a 3600000 ms.');
    }
    await this.input(pid, null, true);
    if (epoch !== this.epoch) throw Error('Inicio do Walker cancelado.');
    const afterProbe = positionIssue(this.getSession(), pid, playerName, this.now());
    if (afterProbe) throw Error(afterProbe);
    this.playerName = playerName;
    this.pid = pid;
    this.engine = engine;
    /* `lastDispatch` e `lastMovementDispatch` SOBREVIVEM ao re-inicio de
     * proposito (contrato original). O throttle de 250 ms e o piso de
     * cadencia valem entre passos do mesmo personagem, inclusive quando o
     * Target foi ligado antes do Walker no mesmo PID.
     *
     * Zerar aqui fazia o walker despachar no primeiro tick apos
     * `setModules('walker')` mesmo quando o relogio nao avancou — e o teste
     * "Adding Walker preserves combat GCD" exige que o GCD do combate seja
     * preservado nesse arranque. */
    this.lastKeyDispatch = lastDispatch;
    this.lastMovementDispatch = lastMovementDispatch;
    this.lastSnapshotAt = null;
    this.last = null;
    this.modules = ['walker'];
    this.paused = false;
    this.startTimer();
    this.changed();
    return this.state;
  }

  startTimer() {
    if (this.automatic) {
      this.timer = setInterval(() => { void this.tick(); }, 100);
      this.timer.unref?.();
    }
  }

  async pause() {
    this.paused = true;
    this.epoch++;
    clearInterval(this.timer);
    this.timer = null;
    await this.inFlight;
    this.changed();
    return this.state;
  }

  async togglePause() {
    if (!this.paused) return this.pause();
    if (!this.engine || !this.modules.length) throw Error('Inicie o Walker antes de continuar.');
    const epoch = this.epoch;
    const issue = positionIssue(this.getSession(), this.pid, this.playerName, this.now());
    if (issue) throw Error(issue);
    await this.input(this.pid, null, true);
    if (epoch !== this.epoch) return this.state;
    const afterProbe = positionIssue(this.getSession(), this.pid, this.playerName, this.now());
    if (afterProbe) throw Error(afterProbe);
    this.paused = false;
    this.last = null;
    this.startTimer();
    this.changed();
    return this.state;
  }

  async tick() {
    if (this.paused || this.inFlight || !this.engine) return null;
    const epoch = this.epoch;
    this.inFlight = this.runTick(epoch);
    try { return await this.inFlight; } finally { this.inFlight = null; }
  }

  async runTick(epoch) {
    try {
      const session = this.getSession();
      const issue = positionIssue(session, this.pid, this.playerName, this.now());
      if (issue) throw Error(issue);
      /* Piso de cadencia do backend teclado. Era 250 ms fixo, mais rapido que
       * o jogo: medido no cliente real, o Shiba anda 1 tile por ~406 ms
       * (`STEP_INTERVAL_MS`, ver engines/walker-engine.cjs). O motor aplica o
       * mesmo piso internamente; aqui ele evita ate' a chamada de `step` e o
       * spawn do emissor de teclado.
       *
       * O valor vem do MOTOR (`engine.stepIntervalMs`), nao da constante: e'
       * o mesmo numero que `walker.stepIntervalMs` ajustou, e 0 desliga os
       * dois pisos de uma vez. Usar a constante aqui deixaria o piso ligado
       * mesmo com a config pedindo 0. */
      /* DOIS PISOS, com papeis diferentes:
       *
       *   1. `lastDispatch` / 250 ms — throttle do BACKEND teclado. Evita
       *      reenviar a MESMA direcao quando o snapshot nao mudou
       *      (`lastSnapshotAt`) mas o relogio avancou. Contrato coberto por
       *      tests/walker_input_runtime.test.cjs ("identical snapshots and the
       *      250ms throttle").
       *
       *   2. `lastMovementDispatch` / `engine.stepIntervalMs` — piso de
       *      cadencia MEDIDO no cliente real: 406 ms por tile. E' o mesmo
       *      numero que `walker.stepIntervalMs` ajusta (0 desliga).
       *
       * Antes havia so' o (1). Quem removeu trocou por (2), e os testes que
       * dependem do throttle de 250 ms passaram a despachar. Os dois convivem:
       * o (1) protege contra amostra repetida, o (2) contra andar mais rapido
       * que o jogo. */
      if (this.now() - this.lastKeyDispatch < 250) return null;
      if (this.now() - this.lastMovementDispatch < this.engine.stepIntervalMs) return null;
      if (session.generatedAt === this.lastSnapshotAt) return null;
      this.lastSnapshotAt = session.generatedAt;
      const events = [];
      const result = this.engine.step(session.telemetry, { command: (name, value) => events.push({ name, value }) }, this.now());
      if (['stuck', 'floor-mismatch', 'stairs-timeout'].includes(result.reason)) throw Error('Rota interrompida: ' + result.reason);
      for (const event of events) {
        if (this.paused || epoch !== this.epoch) return null;
        if (event.name !== 'walk') throw Error('Comando fora do contrato do Walker teclado.');
        if (!Number.isInteger(event.value) || event.value < 0 || event.value > 3) throw Error('Walker teclado aceita somente setas cardinais.');
        const changed = positionIssue(this.getSession(), this.pid, this.playerName, this.now());
        if (changed) throw Error(changed);
        await this.input(this.pid, event.value);
        this.lastMovementDispatch = this.now();
        /* Só conta como dispatch quando SAI movimento. `wait`/`say`/`done`
         * nao emitem evento de walk, e nao podem consumir o throttle de
         * 250 ms — senao um `wait` de 500 ms bloqueia a retomada. */
        this.lastKeyDispatch = this.now();
      }
      if (epoch !== this.epoch) return null;
      this.last = { ...result, status: 'walking', inputAccepted: events.length > 0, effectVerified: false };
      if (result.action === 'done' || (result.action === 'idle' && this.engine.state.finished)) {
        this.modules = this.modules.filter(module => module !== 'walker');
        if (!this.modules.length) {
          this.paused = true;
          clearInterval(this.timer);
          this.timer = null;
        }
        this.last.status = 'done';
      }
      this.changed();
      return this.last;
    } catch (error) {
      this.paused = true;
      this.epoch++;
      clearInterval(this.timer);
      this.timer = null;
      if (error.code === 'WALKER_FOCUS_LOST') {
        this.last = { status: 'paused', action: 'focus-lost', inputAccepted: false, error: error.message };
        this.changed();
        return this.last;
      }
      this.last = { status: 'error', error: error.message, transportResult: error.result, effectVerified: false, retrySafe: false };
      this.engine = null;
      this.modules = [];
      this.changed();
      return this.last;
    }
  }

  async connect() { throw Error('Comandos manuais nativos nao pertencem ao backend Walker teclado.'); }
  async manualCommand() { return this.connect(); }
  async close() { await this.pause(); this.modules = []; this.engine = null; this.changed(); }
}

module.exports = { WalkerInputRuntime, positionIssue, createKeyboardInput };
