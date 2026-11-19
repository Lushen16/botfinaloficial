'use strict';

const { EventEmitter } = require('node:events');
const { createAutomation, createRecorder, gateReason } = require('./automation.cjs');
const { encodeCommand } = require('./protocol.cjs');
const capabilities = require('./capabilities.cjs');
const { mergeCreatureSnapshot } = require('../tools/creature_bridge.cjs');
const nativeAdapter = require('./native-adapter.cjs');
const { CaptureRuntime } = require('./capture-runtime.cjs');
const { createTargetEngine } = require('./engines/target-engine.cjs');
const { createPathPlanner } = require('./pathfinder.cjs');

const MODULES = Object.freeze(['target', 'walker', 'healer']);

class EngineRuntime extends EventEmitter {
  constructor(options = {}) {
    super();
    this.now = options.now || Date.now;
    this.openAdapter = options.openAdapter || nativeAdapter.open;
    this.creatureSource = options.creatureSource;
    /* Mapa OTMM para o walker. Quem chama decide a fonte (aba do mapa, mapa
     * padrao); sem provider o motor segue guloso. */
    this.mapProvider = typeof options.mapProvider === 'function' ? options.mapProvider : null;
    this.stepPlanner = null;
    this.intervalMs = options.intervalMs ?? 50;
    this.timeoutMs = options.timeoutMs ?? 1500;
    this.automatic = options.automatic !== false;
    this.modules = [];
    this.paused = true;
    this.pid = null;
    this.adapter = null;
    this.automation = null;
    this.configSignature = null;
    this.timer = null;
    this.inFlight = null;
    this.epoch = 0;
    this.lastHotkeyAt = null;
    this.last = null;
    this.moving = false;
    this.engaged = false;
    this.capture = new CaptureRuntime();
    this.config = null;
    this.capabilityBlock = null;
    this.interruptState = null;
    this.interruption = null;
    this.stopOutcome = null;
    this.stopPromise = null;
    this.stopPromiseEpoch = null;
    /* Episodio de parada: renovado em cada retomada explicita (R3). */
    this.stopEpoch = 0;
  }

  get sessions() {
    const session = this.adapter?.getSnapshot();
    return session ? [session] : [];
  }

  /* Planejador reaproveitado entre automacoes: o cache dele vale por alguns
   * ticks e recriar a cada connect perderia a serie. */
  plannerFor() {
    if (!this.mapProvider) return undefined;
    this.stepPlanner ??= createPathPlanner({ getMap: this.mapProvider, now: this.now });
    return this.stepPlanner;
  }

  /* Declaracao do servidor. SOMENTE `adapter.capabilities()` conta.
   *
   * `supportedCommands` NAO vira declaracao implicita (R1): ele existe apenas
   * para o gate por comando, e no fluxo de producao vem da propria declaracao.
   * Um adaptador que so' exponha a lista — fixture antiga — nao recebe
   * validade: e' tratado como "sem declaracao", que nao habilita nada. */
  declaration() {
    if (typeof this.adapter?.capabilities === 'function') {
      const parsed = this.adapter.capabilities();
      return parsed || capabilities.parseDeclaration(undefined);
    }
    return capabilities.parseDeclaration(undefined);
  }

  /* Capacidades do servidor conectado + o que os modulos ativos exigem.
   * Sem declaracao reconhecida, `missing` lista tudo (nao presumimos nada). */
  compatibility(modules = this.modules, config = this.config) {
    const declaration = this.declaration();
    const { requirements } = capabilities.requirementsFor(modules, config || {});
    const result = capabilities.evaluate(requirements, declaration);
    return { declaration, requirements, ...result };
  }

  /* Decisao de partida. NAO remove modulo silenciosamente:
   *
   *   - todos compativeis      -> sobe o conjunto pedido;
   *   - algum incompativel     -> RECUSA a solicitacao inteira, com a lista do
   *                               que falta. Partida conjunta nao vira
   *                               execucao parcial por conta propria.
   *
   * Reativação de um modulo isolado compativel continua funcionando, porque a
   * solicitacao e' so' aquele modulo. */
  resolveModules(requested, config) {
    const compatibility = this.compatibility(requested, config);
    if (compatibility.ok) return { modules: [...requested], compatibility, blocked: [], refused: false };
    const blocked = [...new Set(compatibility.missing.map(entry => entry.module))];
    return { modules: [], compatibility, blocked, refused: true };
  }

  get state() {
    const phase = this.last?.status === 'error' ? this.last.error
      : this.paused ? 'Pausado' : !this.last ? 'Aguardando o jogo'
        : this.last.status === 'blocked' ? (this.last.reason === 'capability-missing'
          ? this.last.error : 'Aguardando: ' + this.last.reason) : this.last.status;
    return { modules: [...this.modules], pid: this.pid, paused: this.paused, phase,
      phases: {}, status: this.last?.status || 'idle', reason: this.last?.reason || null,
      error: this.last?.error || null, missing: this.last?.missing || null,
      interrupt: this.interruptState,
      /* Registro separado do motivo original: pausa local, ACK do stop e
       * efeito observado sao coisas diferentes. */
      interruption: this.interruption || null,
      capture: { ...this.capture.last } };
  }

  async bounded(operation, label) {
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(operation), new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(Error('Timeout em ' + label + '; resultado incerto, execucao interrompida.')), this.timeoutMs);
      })]);
    } finally {
      clearTimeout(timer);
    }
  }

  fault(error) {
    this.paused = true;
    this.epoch++;
    this.stopTimer();
    this.last = { status: 'error', error: error.message, emitted: [],
      /* Preserva o resultado da parada, quando houve tentativa. */
      interruption: this.interruption || null };
    const adapter = this.adapter;
    this.adapter = null;
    Promise.resolve().then(() => adapter?.close()).catch(() => {});
    this.emit('change', this.state);
  }

  async setModules(module, enabled, pid, config) {
    if (!MODULES.includes(module) && module !== 'all') throw Error('Modulo sem motor implementado: ' + module);
    if (typeof enabled !== 'boolean') throw Error('Estado do modulo invalido.');
    const next = module === 'all' ? (enabled ? [...MODULES] : []) : enabled
      ? [...new Set([...this.modules, module])] : this.modules.filter(value => value !== module);
    if (!next.length) {
      await this.pause();
      this.modules = [];
      return this.state;
    }
    if (!Number.isInteger(pid) || pid <= 0) throw Error('Selecione uma sessao com PID valido.');
    const signature = JSON.stringify(config);
    const changed = signature !== this.configSignature || pid !== this.pid;
    await this.pause();
    if (this.adapter && pid !== this.pid) {
      await this.adapter.close();
      this.adapter = null;
    }
    if (pid !== this.pid) this.capture.reset();
    this.pid = pid;
    if (changed || !this.automation) {
      this.config = structuredClone(config);
      this.automation = createAutomation(structuredClone(config), { now: this.now,
        isEnabled: name => this.modules.includes(name),
        stepPlanner: this.plannerFor(),
        hotkeysBlocked: () => this.lastHotkeyAt !== null && this.now() - this.lastHotkeyAt < 250 });
      this.configSignature = signature;
    }
    if (!this.adapter) {
      this.connection = new AbortController();
      try {
        this.adapter = await this.openAdapter({ pid, config, signal: this.connection.signal });
        if (!this.adapter || typeof this.adapter.getSnapshot !== 'function'
            || typeof this.adapter.command !== 'function' || typeof this.adapter.close !== 'function'
            || typeof this.adapter.pauseWalker !== 'function' || !Array.isArray(this.adapter.supportedCommands)) {
          throw Error('Adapter de execucao incompleto.');
        }
        const adapter = this.adapter;
        adapter.on?.('fault', error => { if (this.adapter === adapter) this.fault(error); });
      } catch (error) {
        this.connection.abort();
        this.fault(error);
        throw error;
      }
    }
    const resolved = this.resolveModules(next, config);
    if (resolved.refused) {
      /* Solicitacao recusada por inteiro: nada sobe, nenhum timer, nenhum
       * comando de automacao. A config do usuario nao e' tocada. */
      this.modules = [];
      this.paused = true;
      this.capabilityBlock = {
        at: this.now(),
        blocked: resolved.blocked,
        missing: resolved.compatibility.missing,
        declaration: resolved.compatibility.declaration,
      };
      this.last = { status: 'blocked', reason: 'capability-missing', emitted: [],
        error: 'Ativacao recusada: capacidade ausente no servidor conectado. '
          + capabilities.describeMissing(resolved.compatibility.missing),
        missing: resolved.compatibility.missing };
      this.emit('change', this.state);
      return this.state;
    }
    /* Nova automacao autorizada explicitamente: abre um episodio de parada
     * novo. Nao e' retomada automatica — e' uma solicitacao. */
    this.capabilityBlock = null;
    this.beginStopEpisode();
    this.modules = resolved.modules;
    this.paused = false;
    this.last = null;
    if (this.automatic) {
      this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
      this.timer.unref?.();
    }
    this.emit('change', this.state);
    return this.state;
  }

  stopTimer() {
    clearInterval(this.timer);
    this.timer = null;
  }

  /* Ha `stop` declarado? Sem ele, nao podemos afirmar parada confirmada. */
  canInterrupt() {
    return this.declaration().commands.includes(capabilities.INTERRUPT_COMMAND);
  }

  /* Abre um EPISODIO de parada novo.
   *
   * Um episodio comeca quando a automacao e' autorizada: `setModules` com
   * sucesso ou `togglePause` aceito. Enquanto ele dura, `pause`, o catch do
   * `runTick` e `close` compartilham UMA tentativa de `stop`.
   *
   * BUG CORRIGIDO (R3): `togglePause` nao renovava o episodio. Depois de
   * pausar -> retomar -> novas acoes, a segunda pausa encontrava
   * `stopOutcome` do episodio anterior e reutilizava o ACK antigo SEM enviar
   * `stop`. O `stopEpoch` invalida qualquer promessa antiga em voo, para que
   * ela nao sobrescreva o registro do episodio novo. */
  beginStopEpisode() {
    this.stopEpoch = (this.stopEpoch || 0) + 1;
    this.stopOutcome = null;
    this.interruption = null;
    this.interruptState = null;
    return this.stopEpoch;
  }

  /* Uma UNICA tentativa de parada por episodio.
   *
   * Single-flight: `tick` (retirada de capacidade), `pause`, o catch do
   * `runTick` e `close` podem pedir parada no mesmo instante. Todos
   * compartilham a mesma promessa em vez de mandarem dois `stop` — desde que
   * pertencam ao MESMO episodio. Uma promessa de episodio antigo nunca e'
   * reaproveitada para interromper acoes novas. */
  requestStop(reason) {
    if (!this.adapter) return Promise.resolve(this.stopOutcome || null);
    if (this.stopPromise && this.stopPromiseEpoch === this.stopEpoch) return this.stopPromise;
    if (this.stopOutcome) return Promise.resolve(this.stopOutcome);
    const epoch = this.stopEpoch;
    const promise = this.performStop(reason, epoch)
      .finally(() => {
        if (this.stopPromise === promise) {
          this.stopPromise = null;
          this.stopPromiseEpoch = null;
        }
      });
    this.stopPromise = promise;
    this.stopPromiseEpoch = epoch;
    return promise;
  }

  /* Executa a tentativa. Nunca lanca: o resultado vai para o registro, que
   * separa quatro coisas distintas:
   *
   *   localPaused     - os despachos locais pararam (sempre true aqui);
   *   stop === 'acked'- o ACK do `stop` voltou positivo. NAO e' prova de
   *                     parada fisica no jogo: e' "comando entregue";
   *   stop === 'no-stop' / 'absent-before-send'
   *                   - nao havia `stop` para enviar: nao confirmado;
   *   stop === 'rejected' / 'timeout'
   *                   - tentamos e falhou: nao confirmado, com a causa.
   */
  async performStop(reason, epoch = this.stopEpoch) {
    const record = {
      reason,
      epoch,
      attemptedAt: this.now(),
      localPaused: this.paused === true,
      stop: 'not-attempted',
      stopAckAt: null,
      stopError: null,
      /* ACK de `stop` diz "entregue ao executor", nunca "parou no jogo". */
      physicalProof: false,
    };
    const finish = (state, error) => {
      record.stopError = error || null;
      this.moving = false;
      this.engaged = false;
      /* Guarda de epoca: a promessa de um episodio anterior nao escreve no
       * registro do episodio atual. */
      if (epoch === this.stopEpoch) {
        this.interruptState = state;
        this.stopOutcome = record;
        this.interruption = record;
      }
      return record;
    };

    if (!this.canInterrupt()) {
      return finish('unconfirmed-no-stop',
        'Capacidade `stop` nao declarada; parada nao confirmada.');
    }
    /* Rechecagem imediatamente antes do envio: a declaracao pode ter mudado
     * entre a decisao e este ponto. */
    if (!this.canInterrupt()) {
      return finish('unconfirmed-no-stop',
        'Capacidade `stop` desapareceu antes do envio; parada nao confirmada.');
    }
    try {
      /* Uma unica tentativa, com prazo limitado por `bounded`. */
      const ack = await this.bounded(
        () => this.adapter.pauseWalker(true, { pid: this.pid }), 'stop');
      if (ack !== true) throw Error('stop sem ACK positivo.');
      record.stop = 'acked';
      record.stopAckAt = this.now();
      return finish('confirmed', null);
    } catch (error) {
      record.stop = /Timeout/.test(error.message) ? 'timeout' : 'rejected';
      return finish('unconfirmed-error', error.message);
    }
  }

  /* Interrupcao por retirada de capacidade. Marca o bloqueio, INVALIDA o ciclo
   * em curso (epoch++ faz o laco de despacho do `runTick` parar na proxima
   * verificacao), tenta a parada e PRESERVA o motivo original. */
  async handleCapabilityLoss(missing) {
    this.paused = true;
    this.epoch++;
    this.stopTimer();
    this.capabilityBlock = { at: this.now(), missing, declaration: this.declaration() };
    /* Motivo original fixado ANTES da tentativa de parada: o resultado do
     * `stop` nunca o substitui. */
    this.last = { status: 'blocked', reason: 'capability-lost', emitted: [],
      error: 'Execucao interrompida: capacidade retirada durante a sessao. '
        + capabilities.describeMissing(missing),
      missing };
    this.emit('change', this.state);
    const interruption = await this.requestStop('capability-lost');
    this.last.interruption = interruption;
    this.emit('change', this.state);
    return this.last;
  }

  async pause() {
    /* `wasActive` sozinho pulava a parada quando algo ja tinha marcado
     * `paused` (ex.: o ramo capability-lost). `pending` cobre esse caso: se
     * havia movimento/combate entregue, ainda precisamos interromper. */
    const wasActive = !this.paused;
    const pending = this.moving || this.engaged;
    this.paused = true;
    this.epoch++;
    this.stopTimer();
    await this.inFlight;
    if (this.adapter && (wasActive || pending)) {
      const record = await this.requestStop('pause');
      if (record && record.stop !== 'acked' && record.stop !== 'no-stop'
          && record.stop !== 'absent-before-send' && record.stop !== 'not-attempted') {
        /* Erro/timeout na pausa explicita: mantem o contrato anterior —
         * diagnostico preservado, execucao encerrada. */
        const error = Error('Pausa sem confirmacao do runtime: ' + record.stopError);
        this.fault(error);
        throw error;
      }
    }
    this.emit('change', this.state);
    return this.state;
  }

  async togglePause() {
    if (!this.paused) return this.pause();
    if (!this.modules.length || !this.adapter) throw Error('Ative um motor conectado antes de continuar.');
    /* Nao retoma depois de uma retirada de capacidade, mesmo que ela volte:
     * exige nova solicitacao explicita de modulos, que revalida tudo. */
    if (this.capabilityBlock) {
      throw Error('Ativacao recusada por capacidade ausente; reative o modulo para revalidar.');
    }
    /* Nao retoma com uma parada ainda em voo: a acao que ela interrompe pode
     * terminar depois da retomada, e o novo movimento nasceria sem `stop`. */
    if (this.stopPromise && this.stopPromiseEpoch === this.stopEpoch) {
      throw Error('Retomada recusada: parada ainda pendente.');
    }
    /* Revalida ANTES de retomar (R3): a configuracao e as capacidades podem ter
     * mudado enquanto estava pausado. Falhar aqui deixa tudo como esta. */
    const compatibility = this.compatibility(this.modules, this.config);
    if (!compatibility.ok) {
      this.capabilityBlock = { at: this.now(), blocked: [...new Set(compatibility.missing.map(entry => entry.module))],
        missing: compatibility.missing, declaration: compatibility.declaration };
      this.last = { status: 'blocked', reason: 'capability-missing', emitted: [],
        error: 'Retomada recusada: capacidade ausente. '
          + capabilities.describeMissing(compatibility.missing),
        missing: compatibility.missing };
      this.emit('change', this.state);
      throw Error(this.last.error);
    }
    /* Retomada aceita = episodio de parada NOVO. Sem isto, a proxima pausa
     * reutilizaria o ACK do episodio anterior sem enviar `stop` (bug R3). */
    this.beginStopEpisode();
    this.paused = false;
    this.last = null;
    if (this.automatic) {
      this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
      this.timer.unref?.();
    }
    this.emit('change', this.state);
    return this.state;
  }

  snapshot() {
    let snapshot = this.adapter?.getSnapshot();
    if (!snapshot) return null;
    if (snapshot.pid !== this.pid) throw Error('PID da sessao divergente.');
    snapshot = { ...snapshot, paused: false, runtime: { pid: this.pid, paused: false, modules: [...this.modules] } };
    if (this.creatureSource && this.modules.some(name => name === 'target' || name === 'walker')) {
      snapshot = mergeCreatureSnapshot(snapshot, this.creatureSource(), this.now());
    }
    return snapshot;
  }

  async tick() {
    if (this.paused || !this.adapter || this.inFlight) return null;
    /* Revalida ANTES de deixar o motor avancar estado (R1.4). Se a capacidade
     * sumiu durante a execucao, paramos aqui: `automation.tick` nao roda,
     * nenhum motor consome cooldown nem avanca `comboIndex`, e nao sai
     * comando. R2: tambem INTERROMPE uma acao ja entregue, com uma unica
     * tentativa de `stop` quando ele continua disponivel. */
    if (!this.canInterrupt() || !this.compatibility(this.modules, this.config).ok) {
      const missing = this.compatibility(this.modules, this.config).missing;
      return this.handleCapabilityLoss(missing);
    }
    const epoch = this.epoch;
    this.inFlight = this.runTick(epoch);
    try { return await this.inFlight; } finally { this.inFlight = null; }
  }

  async manualCommand(pid, name, parameter, extra) {
    if (!this.adapter) throw Error('Nenhum motor conectado. Ative um modulo antes de enviar comandos.');
    if (Number.isInteger(pid) && this.pid && pid !== this.pid) throw Error('PID da sessao divergente.');
    if (!this.adapter.supportedCommands.includes(name)) throw Error('Comando sem suporte: ' + name);
    encodeCommand(1, name, parameter, extra);
    const command = this.bounded(() => this.adapter.command(name, parameter, { pid: this.pid, extra }), name);
    if (await command !== true) throw Error('Comando sem ACK positivo: ' + name);
    return true;
  }

  get connected() {
    return Boolean(this.adapter);
  }

  // Opens the transport for manual control without enabling any engine. The
  // menu's direction pad / attack / follow must work before a module is started.
  async connect(pid, config) {
    if (this.adapter && this.pid === pid) return this.adapter;
    if (!Number.isInteger(pid) || pid <= 0) throw Error('Selecione uma sessao com PID valido.');
    await this.pause();
    if (this.adapter && pid !== this.pid) { await this.adapter.close(); this.adapter = null; }
    this.pid = pid;
    if (!this.automation) {
      this.config = structuredClone(config || {});
      this.automation = createAutomation(structuredClone(config || {}), { now: this.now,
        isEnabled: name => this.modules.includes(name),
        stepPlanner: this.plannerFor(),
        hotkeysBlocked: () => this.lastHotkeyAt !== null && this.now() - this.lastHotkeyAt < 250 });
      this.configSignature = JSON.stringify(config);
    }
    if (!this.adapter) {
      this.connection = new AbortController();
      try {
        this.adapter = await this.openAdapter({ pid, config, signal: this.connection.signal });
        if (!this.adapter || typeof this.adapter.getSnapshot !== 'function'
            || typeof this.adapter.command !== 'function' || typeof this.adapter.close !== 'function'
            || typeof this.adapter.pauseWalker !== 'function' || !Array.isArray(this.adapter.supportedCommands)) {
          throw Error('Adapter de execucao incompleto.');
        }
        const adapter = this.adapter;
        adapter.on?.('fault', error => { if (this.adapter === adapter) this.fault(error); });
      } catch (error) {
        this.connection.abort();
        this.fault(error);
        throw error;
      }
    }
    this.emit('change', this.state);
    return this.adapter;
  }

  async runTick(epoch) {
    try {
      const snapshot = this.snapshot();
      if (!snapshot) {
        this.last = { status: 'blocked', reason: 'no-telemetry', emitted: [] };
        return this.last;
      }
      const recorder = createRecorder();
      let captureCandidate = null;
      const result = this.automation.tick(snapshot, recorder, (telemetry, inCombat) => {
        const canCapture = this.declaration().commands.includes('useWith')
          && this.adapter.supportedCommands.includes('useWith');
        captureCandidate = this.capture.plan(telemetry, this.config, this.now(), { inCombat, canCapture });
        if (this.lastHotkeyAt !== null && this.now() - this.lastHotkeyAt < 250) return null;
        if (captureCandidate) {
          const latest = this.snapshot();
          const reason = gateReason(latest);
          if (reason) throw Error('Sessao mudou antes da captura: ' + reason);
          const plan = this.capture.revalidate(captureCandidate, latest.telemetry, this.config);
          if (plan.state !== 'DISPATCH_PLANNED') throw Error('Corpo mudou antes da captura: ' + plan.reason);
          recorder.command(plan.command, plan.parameter);
          return { status: 'capture', emitted: [['useWith', plan.parameter]], effectVerified: false };
        }
        return null;
      });
      for (const event of recorder.events) {
        if (!this.adapter.supportedCommands.includes(event.name)) throw Error('Comando sem suporte: ' + event.name);
        encodeCommand(1, event.name, event.parameter, event.extra);
      }
      if ((this.moving && ['blocked', 'combat', 'heal', 'revive', 'capture'].includes(result.status))
          || (this.engaged && result.status !== 'combat')) {
        if (await this.bounded(() => this.adapter.pauseWalker(true, { pid: this.pid }), 'stop') !== true) {
          throw Error('Walker sem confirmacao de parada.');
        }
        this.moving = false;
        this.engaged = false;
      }
      for (const event of recorder.events) {
        if (this.paused || epoch !== this.epoch) break;
        const current = this.snapshot();
        const reason = gateReason(current);
        if (reason) throw Error('Sessao mudou antes do envio: ' + reason);
        if (event.name === 'useWith' && captureCandidate) {
          if (this.config?.looting?.captureAfterCombat === true
              && createTargetEngine(this.config).inspect(current.telemetry).length > 0) {
            throw Error('Combate observado antes do envio da captura.');
          }
          const plan = this.capture.revalidate(captureCandidate, current.telemetry, this.config);
          if (plan.state !== 'DISPATCH_PLANNED') throw Error('Corpo mudou antes do envio: ' + plan.reason);
          event.parameter = plan.parameter;
        }
        if (['hotkey', 'useWith'].includes(event.name) && this.lastHotkeyAt !== null && this.now() - this.lastHotkeyAt < 250) {
          throw Error('Lote excedeu o Global Cooldown.');
        }
        const adapter = this.adapter;
        if (['hotkey', 'useWith'].includes(event.name)) this.lastHotkeyAt = this.now();
        this.automation.recordDispatch(event.name, event.parameter, this.now());
        const ack = await this.bounded(() => adapter.command(event.name, event.parameter,
          { pid: this.pid, extra: event.extra }), event.name);
        if (ack !== true) throw Error('Comando sem ACK positivo: ' + event.name);
        if (event.name === 'attack' && epoch === this.epoch) {
          this.automation.recordAttackDelivery(event.parameter, current.telemetry, this.now());
        }
        if (event.name === 'useWith' && captureCandidate) this.capture.record(captureCandidate, this.config, this.now(), true);
        if (event.name === 'walk') this.moving = true;
        if (event.name === 'attack') this.engaged = true;
      }
      if (epoch === this.epoch) this.last = result;
      return result;
    } catch (error) {
      if ((this.moving || this.engaged) && this.adapter) {
        /* Mesmo caminho de parada: single-flight com `pause`/`tick`. */
        const record = await this.requestStop('error');
        if (record && record.stopError && record.stop !== 'acked'
            && record.stop !== 'no-stop' && record.stop !== 'absent-before-send') {
          error = Error(error.message + ' Parada pendente: ' + record.stopError);
        }
      }
      this.fault(error);
      return this.last;
    }
  }

  async close() {
    try { await this.pause(); } finally {
      /* Se a pausa pulou a parada (ja estava pausado e sem pendencia), ainda
       * tentamos uma vez antes de fechar o canal — nunca duas. */
      if (this.adapter) await this.requestStop('close');
      this.connection?.abort();
      await this.adapter?.close();
      this.adapter = null;
      this.modules = [];
    }
  }
}

module.exports = { EngineRuntime, MODULES };
