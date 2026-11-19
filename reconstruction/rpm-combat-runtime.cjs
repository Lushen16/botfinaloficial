function findMatchingRule(name, rules) {
  if (!name || !Array.isArray(rules) || !rules.length) return null;
  const cleanName = String(name).trim().toLowerCase();
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') continue;
    const pattern = (rule.name || '*').trim().toLowerCase();
    if (pattern === '*' || pattern === cleanName) return rule;
    if (pattern.startsWith('*') && cleanName.endsWith(pattern.slice(1))) return rule;
    if (pattern.endsWith('*') && cleanName.startsWith(pattern.slice(0, -1))) return rule;
  }
  return null;
}

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { WalkerInputRuntime, positionIssue } = require('./walker-input-runtime.cjs');
const { createTargetEngine, ATTACK_RETRY_MS } = require('./engines/target-engine.cjs');
const { normalizeName } = require('./engines/shared.cjs');
const { createHealerEngine } = require('./engines/healer-engine.cjs');
const { mergeCreatureSnapshot } = require('../tools/creature_bridge.cjs');
const { readBindings, projectTarget, createCombatInput } = require('./keyboard-combat.cjs');
const { CaptureRuntime } = require('./capture-runtime.cjs');
const { captureRequest } = require('./capture-input.cjs');
const { mergeItemSnapshot } = require('./item-source.cjs');
const { isSupportedExecutable, layoutFor } = require('./executable-profile.cjs');
const { DEFAULT_GLOBAL_COOLDOWN_MS } = require('../target-engine.cjs');

function targetHoennSettings(hoenn) {
  return [hoenn?.ignoredCreaturesText, hoenn?.minWildsToEngage, hoenn?.perfectLure, hoenn?.forceBox];
}

class RpmCombatRuntime extends WalkerInputRuntime {
  constructor(options = {}) {
    super({ ...options, allowedActions: ['walk', 'wait', 'box', 'safespot'] });
    this.creatureSource = options.creatureSource;
    this.itemSource = options.itemSource;
    this.capture = new CaptureRuntime();
    this.loadTransport = options.loadTransport || (() => {
      const transport = JSON.parse(fs.readFileSync(options.transportFile, 'utf8'));
      const clientConfig = transport.clientConfig || (process.env.APPDATA
        && path.join(process.env.APPDATA, 'PokeAlliance', 'PokeAllianceV3', 'config.otml'));
      if (!clientConfig) throw Error('Caminho da configuracao de hotkeys do cliente ausente.');
      return { ...transport, bindings: readBindings(clientConfig) };
    });
    this.combatInput = options.combatInput || createCombatInput();
    this.combat = null;
    this.healer = null;
    this.config = null;
    this.transport = null;
    this.queue = [];
    this.targetView = null;
    this.lastCombatSnapshot = null;
    this.retryCombatSnapshot = null;
    this.retryCombatAt = -Infinity;
    this.dispatchLog = [];
    this.onDispatch = options.onDispatch || (() => {});
    this.keyUsedAt = new Map();
    this.revivePending = null;
    this.walkerFlight = null;
    this.captureInFlight = false;
    this.maxAgeMs = options.maxAgeMs ?? (options.now ? 500 : (Number(process.env.PKA_MAX_AGE_MS) || 1500));
  }

  get sessions() {
    const maxAge = this.maxAgeMs;
    return super.sessions.map(session => {
      let merged = session;
      let issue = null;
      let issueCode = null;
      try {
        if (this.creatureSource) merged = mergeCreatureSnapshot(session, this.creatureSource(), this.now(), maxAge);
        else if (session.telemetry.creaturesStale !== false) throw Error('Lista RPM de criaturas desatualizada.');
        const transport = this.loadTransport();
        const age = this.now() - Date.parse(merged.telemetry.creaturesGeneratedAt);
        const playerAge = this.now() - Date.parse(merged.generatedAt);
        const profile = merged.telemetry.creatureIdentityProfile;
        if (!Number.isFinite(age) || age < 0 || age > maxAge) throw Error('Identidade de criaturas expirada (limite ' + maxAge + 'ms).');
        if (!Number.isFinite(playerAge) || playerAge < 0 || playerAge > maxAge) throw Error('Sessao RPM expirada para combate (limite ' + maxAge + 'ms).');
        if (!profile?.executableSha256) {
          throw Object.assign(Error('A leitura de criaturas não informou um perfil do cliente. Veja o estado do scanner em Conexão.'),
            { code: 'COMBAT_PROFILE_MISSING' });
        }
        const layout = layoutFor(profile.executableSha256);
        if (!isSupportedExecutable(profile.executableSha256) || !layout) {
          throw Object.assign(Error('A versão do cliente detectada pela leitura de criaturas não tem perfil de compatibilidade confirmado.'),
            { code: 'COMBAT_PROFILE_UNSUPPORTED' });
        }
        if (profile.typeOffset !== layout.typeOffset) {
          throw Object.assign(Error('O perfil informado pela leitura de criaturas não corresponde à versão do cliente.'),
            { code: 'COMBAT_PROFILE_MISMATCH' });
        }
        const player = merged.telemetry.creaturePlayer;
        if (player?.ownershipVerified !== true || player.creatureType !== 0 || !Number.isInteger(player.id)
            || player.name?.toLowerCase() !== merged.telemetry.playerName?.toLowerCase()) {
          throw Error('Identidade RPM do jogador ausente ou divergente.');
        }
        if (!isDeepStrictEqual(player.pos, merged.telemetry.position)) {
          throw Object.assign(Error('Posicoes RPM divergentes; aguardando sincronizacao antes de enviar comandos.'),
            { code: 'COMBAT_SNAPSHOT_DESYNC' });
        }
        const entities = new Map();
        const ambiguous = new Set();
        for (const creature of merged.telemetry.creatures) {
          if (!creature || !Number.isInteger(creature.id)) continue;
          if (creature.ownershipVerified !== true || !Number.isInteger(creature.creatureType)) continue;
          const normalized = { id: creature.id, name: creature.name, pos: creature.pos,
            healthPercent: creature.healthPercent, canAttack: creature.canAttack,
            is_player: creature.is_player === true || creature.creatureType === 0
              || (creature.id >= 0x10000000 && creature.id < 0x20000000),
            creatureType: creature.creatureType, isOwnPokemon: creature.isOwnPokemon,
            is_owned: creature.is_owned, ownershipVerified: true, struct_va: creature.struct_va };
          if (entities.has(creature.id) && !isDeepStrictEqual(entities.get(creature.id), normalized)) ambiguous.add(creature.id);
          entities.set(creature.id, normalized);
        }
        const own = [...entities.values()].filter(creature => creature.creatureType === 3 && creature.healthPercent > 0);
        const ownPokemon = own.length === 1 && !ambiguous.has(own[0].id) ? own[0] : null;
        merged = { ...merged, telemetry: { ...merged.telemetry,
          ownPokemon,
          creatures: [...entities.values()].filter(creature => !ambiguous.has(creature.id) && creature.creatureType === 1
            && creature.is_owned !== true && creature.isOwnPokemon !== true
            && !own.some(pet => pet.pos?.z === creature.pos?.z
              && pet.pos?.x === creature.pos?.x && pet.pos?.y === creature.pos?.y)) } };
        if (!transport.viewport) throw Error('Calibracao do viewport pendente.');
      } catch (error) { issue = error.message; issueCode = error.code || null; }
      return { ...merged, capabilities: { ...merged.capabilities,
        targetKeyboard: !issue && merged.capabilities.walkerKeyboard === true,
        targetKeyboardWarning: !issue && !merged.telemetry.ownPokemon
          ? 'Pokemon proprio ausente, ambiguo ou em troca; cura do pet indisponivel.' : null,
        targetKeyboardIssue: issue, targetKeyboardIssueCode: issueCode, combatTransport: 'PostMessageW' } };
    });
  }

  get state() {
    const state = super.state;
    const target = this.targetView ? { ...this.targetView } : null;
    const walker = this.engine?.state || null;
    return { ...state, selectedTargetId: this.combat?.state.targetId ?? null,
      target, targetName: target?.name ?? null, targetDistance: target?.distance ?? null,
      targetHp: target?.healthPercent ?? null,
      walkerWaypoint: walker && Number.isInteger(walker.index) ? walker.index + 1 : null,
      walkerWaypoints: walker && Number.isInteger(walker.total) ? walker.total : null,
      phase: this.last?.error || (this.paused ? 'Teclado/RPM pausado'
        : this.modules.join(' + ') + ': ' + (this.last?.action || 'aguardando')),
      targetEffectVerified: false, lastCombatDispatch: this.dispatchLog.at(-1) || null,
      capture: { ...this.capture.last },
      healer: this.healer?.state || null,
      phases: { target: this.modules.includes('target') ? this.last?.status || 'aguardando' : 'off' } };
  }

  updateConfig(config) {
    if (this.healer && (!isDeepStrictEqual(this.config?.healer, config.healer)
        || !isDeepStrictEqual(this.config?.hoenn, config.hoenn))) {
      this.healer = this.createKeyboardHealer(config);
    }
    if (!this.combat || (isDeepStrictEqual(this.config?.target, config.target)
        && isDeepStrictEqual(targetHoennSettings(this.config?.hoenn), targetHoennSettings(config.hoenn)))) {
      this.config = structuredClone(config); return;
    }
    this.combat = createTargetEngine(config);
    this.retryCombatSnapshot = null; this.retryCombatAt = -Infinity;
    this.config = structuredClone(config); this.queue = []; this.lastCombatSnapshot = null; this.targetView = null;
    this.revivePending = null; this.combatActive = false;
  }

  async setModules(module, enabled, pid, config) {
    if (typeof enabled !== 'boolean') throw Error('Estado do modulo invalido.');
    if (module === 'healer') return this.setHealer(enabled, pid, config);
    if (!enabled && module === 'all') {
      await super.setModules('all', false);
      this.combat = null; this.healer = null; this.queue = []; this.config = null; this.targetView = null;
      this.revivePending = null;
      return this.state;
    }
    if (module === 'walker') {
      const otherModules = this.modules.filter(value => value !== 'walker');
      const wasPaused = this.paused;
      if (enabled) {
        if (otherModules.length && pid !== this.pid) throw Error('Pare os modulos antes de trocar o PID.');
        const transport = this.loadTransport();
        if (pid !== this.pid) this.capture.reset();
        const state = await super.setModules(module, enabled, pid, config);
        this.config = structuredClone(config);
        this.transport = transport;
        if (otherModules.length) { this.modules.push(...otherModules); this.changed(); }
        return { ...state, ...this.state };
      }
      await this.pause();
      this.engine = null;
      this.modules = otherModules;
      if (otherModules.length && !wasPaused) { this.paused = false; this.startTimer(); }
      this.changed(); return this.state;
    }
    if (module !== 'target') throw Error('Modulo indisponivel no backend RPM.');
    if (!enabled) {
      const wasPaused = this.paused;
      await this.pause();
      this.combat = null; this.queue = []; this.targetView = null; this.revivePending = null;
      this.modules = this.modules.filter(value => value !== 'target');
      if (this.modules.length && !wasPaused) { this.paused = false; this.startTimer(); }
      this.changed(); return this.state;
    }
    if (this.modules.length && pid !== this.pid) throw Error('Pare os modulos antes de trocar o PID.');
    const session = this.sessions.find(value => value.pid === pid);
    const issue = positionIssue(session, pid, this.playerName, this.now());
    if (issue) throw Error(issue);
    if (!session.capabilities.targetKeyboard) throw Error(session.capabilities.targetKeyboardIssue || 'Target RPM indisponivel.');
    const transport = this.loadTransport();
    const combo = config?.target?.combo;
    if (combo?.enabled && combo.useNativeSequence && !transport.bindings['!autocombo']) throw Error('AutoCombo sem hotkey simples configurada no cliente.');
    if (combo?.enabled && !combo.useNativeSequence) {
      const moves = require('./engines/shared.cjs').parseSequence(combo.sequenceText);
      if (!moves.length || moves.some(move => !transport.bindings[move])) throw Error('Sequencia sem hotkeys correspondentes no cliente.');
    }
    const healSkill = config?.target?.healSkill;
    if (healSkill?.enabled === true && Number.isFinite(Number(healSkill.hpPercent))
        && /^m[1-9]\d*$/u.test(String(healSkill.move)) && !transport.bindings[healSkill.move]) {
      throw Error('Cura sem hotkey correspondente no cliente: ' + healSkill.move);
    }
    await this.pause();
    const epoch = this.epoch;
    await this.input(pid, null, true);
    if (epoch !== this.epoch) throw Error('Inicio do Target cancelado.');
    const refreshed = this.sessions.find(value => value.pid === pid);
    const after = positionIssue(refreshed, pid, this.playerName, this.now())
      || (!refreshed.capabilities.targetKeyboard && (refreshed.capabilities.targetKeyboardIssue || 'Criaturas RPM indisponiveis.'));
    if (after) throw Error(after);
    if (pid !== this.pid) this.capture.reset();
    this.pid = pid; this.playerName ||= session.telemetry.playerName;
    if (typeof this.combatInput.prewarm === 'function') this.combatInput.prewarm().catch(() => {});
    this.transport = transport; this.config = structuredClone(config);
    this.combat = createTargetEngine(config);
    this.retryCombatSnapshot = null; this.retryCombatAt = -Infinity;
    this.queue = []; this.lastCombatSnapshot = null; this.revivePending = null; this.combatActive = false;
    if (!this.modules.includes('target')) this.modules.push('target');
    this.paused = false; this.last = null; this.startTimer(); this.changed();
    return this.state;
  }

  async togglePause() {
    if (this.engine || !this.paused) return super.togglePause();
    if (!this.combat && !this.healer) throw Error('Inicie o Target ou Healer antes de continuar.');
    const session = this.sessions.find(value => value.pid === this.pid);
    const issue = positionIssue(session, this.pid, this.playerName, this.now())
      || (!session.capabilities.targetKeyboard && (session.capabilities.targetKeyboardIssue || 'Criaturas RPM indisponiveis.'));
    if (issue) throw Error(issue);
    const epoch = this.epoch;
    await this.input(this.pid, null, true);
    if (epoch !== this.epoch) return this.state;
    const refreshed = this.sessions.find(value => value.pid === this.pid);
    const after = positionIssue(refreshed, this.pid, this.playerName, this.now())
      || (!refreshed.capabilities.targetKeyboard && (refreshed.capabilities.targetKeyboardIssue || 'Criaturas RPM indisponiveis.'));
    if (after) throw Error(after);
    this.paused = false; this.last = null; this.startTimer(); this.changed(); return this.state;
  }

  async setHealer(enabled, pid, config) {
    const wasPaused = this.paused;
    if (!enabled) {
      await this.pause();
      this.healer = null; this.modules = this.modules.filter(value => value !== 'healer');
      if (this.modules.length && !wasPaused) { this.paused = false; this.startTimer(); }
      this.changed(); return this.state;
    }
    if (this.modules.length && pid !== this.pid) throw Error('Pare os modulos antes de trocar o PID.');
    const validate = () => {
      const session = this.sessions.find(value => value.pid === pid);
      const issue = positionIssue(session, pid, this.playerName, this.now());
      if (issue || !session?.capabilities.targetKeyboard) throw Error(issue || session?.capabilities.targetKeyboardIssue);
      const health = session.telemetry.healthPercent;
      if (Number(config?.healer?.healHpPercent) > 0
          && (!Number.isFinite(health) || health < 0 || health > 100)) {
        throw Error('Healer exige telemetria real de HP para curar o treinador.');
      }
      return session;
    };
    const session = validate();
    const transport = this.loadTransport();
    for (const slot of [config?.healer?.healMoveSlot, config?.healer?.healResetSlot]) {
      if (Number(config?.healer?.healHpPercent) > 0 && slot && !transport.bindings['m' + slot]) {
        throw Error('Cura sem hotkey correspondente no cliente: m' + slot);
      }
    }
    await this.pause();
    const epoch = this.epoch;
    await this.input(pid, null, true);
    if (epoch !== this.epoch) throw Error('Inicio do Healer cancelado.');
    validate();
    this.pid = pid; this.playerName ||= session.telemetry.playerName;
    if (typeof this.combatInput.prewarm === 'function') this.combatInput.prewarm().catch(() => {});
    this.transport = transport;
    this.updateConfig(config);
    this.healer = this.createKeyboardHealer(config);
    if (!this.modules.includes('healer')) this.modules.push('healer');
    this.paused = false; this.last = null; this.startTimer(); this.changed(); return this.state;
  }

  async tick() {
    if (this.paused || (!this.engine && !this.combat && !this.healer)) return null;
    const epoch = this.epoch;
    // Each lane coalesces its own work. A slow combat process must not hold
    // subsequent Walker ticks, while pause() still drains both lanes.
    let combat = null;
    let walk = null;
    if (!this.inFlight) {
      combat = this.runTick(epoch).finally(() => { this.inFlight = null; });
      this.inFlight = combat;
    }
    if (!this.paused && !this.walkerFlight && !this.captureInFlight
        && this.modules.includes('walker') && this.engine) {
      walk = this.runWalkerTick(epoch).finally(() => { this.walkerFlight = null; });
      this.walkerFlight = walk;
    } else if (this.engine && this.modules.includes('walker')) {
      /* O Walker NAO foi consultado neste tick (captura em voo, pausa, ou
       * outro tick ainda em execucao). Avisar o motor descarta o passo
       * pendente: sem isso ele sobrevive ao periodo parado e a retomada
       * devolve `hold: await-position-sample` com a rota visualmente travada.
       * Ver skipWalker(). */
      this.skipWalker();
    }
    const [fight, movement] = await Promise.all([combat, walk]);
    if (epoch !== this.epoch) return this.last;
    const result = fight && !['idle', 'luring'].includes(fight.status) ? fight : movement || fight;
    if (result) { this.last = result; this.changed(); }
    return result;
  }

  async pause() {
    await super.pause();
    await this.walkerFlight;
    return this.state;
  }

  async runWalkerTick(epoch) {
    // Combat perception failures still fail closed before either input lane.
    if ((this.combat || this.healer) && !this.sessions.find(value => value.pid === this.pid)?.capabilities.targetKeyboard) return this.skipWalker();
    if (this.paused || epoch !== this.epoch) return this.skipWalker();

    if (this.revivePending) return this.skipWalker();
    if (this.captureInFlight) return this.skipWalker();

    if (this.combat && this.targetView && this.last?.status === 'combat') {
      const monsters = this.config?.target?.monsters;
      const rule = findMatchingRule(this.targetView.name, monsters);
      if (rule?.movement === 'stand') return this.skipWalker();
      if (this.last?.action === 'waiting-perfect-lure') return this.skipWalker();
    }

    return super.runTick(epoch);
  }

  /**
   * Registra que o Walker NAO foi consultado neste tick.
   *
   * Sem isso, um passo pendente de antes do combate sobrevive ao periodo
   * parado. Na retomada o motor compara a amostra com esse pendente velho e
   * devolve `hold: await-position-sample` — a rota parece travada por ate'
   * PROGRESS_TIMEOUT_MS (2500 ms) mesmo com tudo em ordem.
   *
   * Medido: 4 testes de RPM falhavam com `expected 'move', actual 'hold'`
   * exatamente nesta retomada apos o combate.
   *
   * O motor expoe `notifySkipped()` para o chamador avisar, em vez de o motor
   * adivinhar pela cadencia (que varia entre teste e runtime).
   */
  skipWalker() {
    this.engine?.notifySkipped?.();
    return null;
  }

  combatGcd() {
    const configured = this.config?.target?.globalCooldownMs;
    if (configured !== undefined && (!Number.isFinite(configured) || configured < 0)) throw Error('GCD configurado invalido.');
    return Math.max(DEFAULT_GLOBAL_COOLDOWN_MS, configured ?? DEFAULT_GLOBAL_COOLDOWN_MS);
  }

  createKeyboardHealer(config) {
    return createHealerEngine(config, { keyboardOnly: true, canSend: (name, parameter) => {
      const key = name === 'hotkey' ? parameter : this.transport?.bindings[parameter];
      return Boolean(key) && this.keyReady(key);
    } });
  }

  keyReady(key) {
    const cooldown = this.transport.cooldownsMs?.[key.toLowerCase()];
    if (cooldown !== undefined && (!Number.isFinite(cooldown) || cooldown < 0)) throw Error('Cooldown configurado invalido.');
    return this.now() - (this.keyUsedAt.get(key.toLowerCase()) ?? -Infinity) >= (cooldown ?? 0);
  }

  requireCombatPerception(session, fallback = 'Criaturas RPM indisponiveis.') {
    if (session?.capabilities.targetKeyboard) {
      this.perceptionDesyncAt = null;
      return;
    }
    throw Object.assign(Error(session?.capabilities.targetKeyboardIssue || fallback),
      { code: session?.capabilities.targetKeyboardIssueCode });
  }

  tryHealing(session, epoch) {
    if (!session.telemetry.ownPokemon) return null;
    const latest = this.sessions.find(value => value.pid === this.pid);
    this.requireCombatPerception(latest, 'Identidade expirou antes da cura.');
    if (latest.telemetry.ownPokemon?.id !== session.telemetry.ownPokemon.id) return null;
    if (this.paused || epoch !== this.epoch) return null;
    if (this.healingOwnId !== latest.telemetry.ownPokemon.id) {
      this.healer?.reset(); this.healingOwnId = latest.telemetry.ownPokemon.id;
    }
    const actions = [];
    if (this.healer) this.healer.step(latest.telemetry, { command: (name, parameter) => actions.push({ name, parameter }) }, this.now());
    const action = actions[0] || this.combat?.healingAction(latest.telemetry, this.now());
    if (!action) return null;
    if (this.now() - this.lastDispatch < this.combatGcd()) return 'waiting';
    const key = action.name === 'hotkey' ? action.parameter : this.transport.bindings[action.parameter];
    if (!key) throw Error('Cura sem hotkey correspondente no cliente: ' + action.parameter);
    if (!this.keyReady(key)) return 'waiting';
    return this.dispatchHealing(action, key, latest, epoch, !actions.length);
  }

  async dispatchHealing(action, key, latest, epoch, targetHealing) {
    const plannedCombat = this.combat;
    const plannedHealer = this.healer;
    const result = await this.combatInput(this.pid, { kind: 'key', key, playerName: this.playerName,
      ownGuard: { pid: this.pid, playerName: this.playerName, generatedAt: latest.telemetry.creaturesGeneratedAt,
        player: latest.telemetry.creaturePlayer, own: latest.telemetry.ownPokemon } });
    this.lastDispatch = this.now();
    this.keyUsedAt.set(key.toLowerCase(), this.lastDispatch);
    if (targetHealing) plannedCombat?.recordHealing(this.lastDispatch);
    else plannedHealer?.recordDispatch(this.lastDispatch);
    const record = { ...result, generatedAt: new Date(this.lastDispatch).toISOString(), command: action.name,
      parameter: action.parameter, priority: 'heal', inputAccepted: true, effectVerified: false };
    this.dispatchLog.push(record); this.dispatchLog = this.dispatchLog.slice(-100); this.onDispatch(record);
    if (epoch !== this.epoch) return null;
    this.last = { status: 'heal', action: action.name, inputAccepted: true, effectVerified: false };
    this.changed(); return this.last;
  }

  captureTelemetry(session) {
    if (!this.itemSource) throw Error('Capture: fonte RPM de itens indisponivel.');
    const telemetry = mergeItemSnapshot(session, this.itemSource(), this.now()).telemetry;
    const identity = JSON.stringify([telemetry.itemPid, telemetry.itemIdentityProfile.processStartedAt,
      telemetry.itemIdentityProfile.moduleBase]);
    if (this.captureSession !== identity) {
      this.capture.reset(); this.captureSession = identity;
    }
    return telemetry;
  }

  async tryCapture(session, epoch, inCombat) {
    if (this.config?.looting?.captureEnabled !== true) {
      this.capture.last = { status: 'off', effectVerified: false }; return null;
    }
    let telemetry;
    try { telemetry = this.captureTelemetry(session); }
    catch (error) {
      this.capture.last = { status: 'blocked', reason: error.message, effectVerified: false }; return null;
    }
    const candidate = this.capture.plan(telemetry, this.config, this.now(), { inCombat });
    if (!candidate || this.now() - this.lastDispatch < 250) return null;
    const latest = this.getSession();
    const issue = positionIssue(latest, this.pid, this.playerName, this.now());
    if (issue) throw Error(issue);
    if (this.config.looting.captureAfterCombat === true) {
      const perception = this.sessions.find(value => value.pid === this.pid);
      if (!perception?.capabilities.targetKeyboard
          || createTargetEngine(this.config).inspect(perception.telemetry).length > 0) {
        this.capture.last = { status: 'blocked', reason: 'capture-after-combat', effectVerified: false };
        return null;
      }
    }
    const current = this.captureTelemetry(latest);
    const plan = this.capture.revalidate(candidate, current, this.config);
    if (plan.state !== 'DISPATCH_PLANNED') {
      this.capture.last = { status: 'blocked', reason: plan.reason, effectVerified: false }; return null;
    }
    const request = captureRequest(this.loadTransport(), current, candidate, plan, this.config);
    if (epoch !== this.epoch || this.paused) return null;
    let result;
    this.captureInFlight = true;
    // A useWith sequence projects a corpse tile. Let an already submitted
    // movement finish, then re-plan capture on the next tick.
    if (this.walkerFlight) { this.captureInFlight = false; return null; }
    try { result = await this.combatInput(this.pid, request); }
    catch (error) {
      this.capture.last = { status: 'error', reason: error.message, effectVerified: false,
        outcome: 'unknown', retrySafe: false, transportResult: error.result };
      throw error;
    } finally { this.captureInFlight = false; }
    this.lastDispatch = this.now();
    this.capture.record(candidate, this.config, this.lastDispatch, true);
    const record = { ...result, generatedAt: new Date(this.lastDispatch).toISOString(), command: 'useWith',
      parameter: plan.parameter, inputAccepted: true, effectVerified: false };
    this.dispatchLog.push(record); this.dispatchLog = this.dispatchLog.slice(-100);
    this.onDispatch(record);
    if (epoch !== this.epoch) return null;
    this.last = { status: 'capture', action: 'useWith', inputAccepted: true, effectVerified: false };
    this.changed(); return this.last;
  }

  async runTick(epoch) {
    let attemptedSnapshot = null;
    try {
      if (!this.modules.includes('target') || !this.combat) {
        const session = this.healer ? this.sessions.find(value => value.pid === this.pid) : this.getSession();
        const issue = positionIssue(session, this.pid, this.playerName, this.now());
        if (issue) throw Error(issue);
        if (this.healer) {
          this.requireCombatPerception(session);
          const healing = this.tryHealing(session, epoch);
          if (healing === 'waiting') return null;
          if (healing) return await healing;
          if (epoch !== this.epoch || this.paused) return null;
        }
        let inCombat;
        if (this.config?.looting?.captureAfterCombat === true) {
          const perception = this.sessions.find(value => value.pid === this.pid);
          if (perception?.capabilities.targetKeyboard) {
            inCombat = createTargetEngine(this.config).inspect(perception.telemetry).length > 0;
          }
        } else inCombat = false;
        const capture = await this.tryCapture(session, epoch, inCombat);
        return capture;
      }
      const session = this.sessions.find(value => value.pid === this.pid);
      const issue = positionIssue(session, this.pid, this.playerName, this.now());
      if (issue) throw Error(issue);
      this.requireCombatPerception(session);
      const telemetry = session.telemetry;
      if (this.observedOwnId !== undefined && this.observedOwnId !== telemetry.ownPokemon?.id) {
        this.queue = []; this.combat.clearTarget(); this.lastCombatSnapshot = null; this.targetView = null;
      }
      this.observedOwnId = telemetry.ownPokemon?.id;
      if (this.healer || (this.combat && this.combat.healingAction(telemetry, this.now()))) {
        const healing = this.tryHealing(session, epoch);
        if (healing === 'waiting') return null;
        if (healing) return await healing;
      }
      if (epoch !== this.epoch || this.paused) return null;
      if (this.retryCombatSnapshot === telemetry.creaturesGeneratedAt || this.now() < this.retryCombatAt) return null;
      this.retryCombatSnapshot = null;

      const revive = this.config?.target?.autoRevive;
      if (this.revivePending) {
        if (revive?.enabled !== true || !revive.hotkey?.trim()) {
          this.revivePending = null;
        } else {
          const interval = Number.isFinite(revive.interval) && revive.interval >= 0 ? revive.interval : 1500;
          if (this.revivePending.sentAt === null) {
            if (this.now() - this.revivePending.lastSkillAt >= interval && this.now() - this.lastDispatch >= this.combatGcd()) {
              const key = revive.hotkey.trim();
              const pending = this.revivePending;
              const result = await this.combatInput(this.pid, { kind: 'key', key, playerName: this.playerName });
              if (epoch !== this.epoch || this.revivePending !== pending) return null;
              this.lastDispatch = this.now();
              this.keyUsedAt.set(key.toLowerCase(), this.lastDispatch);
              pending.sentAt = this.lastDispatch;
              pending.sentSnapshot = telemetry.creaturesGeneratedAt;
              const record = { ...result, generatedAt: new Date(this.lastDispatch).toISOString(),
                command: 'hotkey', parameter: key, priority: 'revive', inputAccepted: true, effectVerified: false };
              this.dispatchLog.push(record); this.dispatchLog = this.dispatchLog.slice(-100);
              this.onDispatch(record);
              if (epoch !== this.epoch) return null;
              this.last = { status: 'revive', action: 'hotkey', inputAccepted: true, effectVerified: false };
              this.changed(); return this.last;
            }
            this.last = { status: 'revive', action: 'waiting-interval', inputAccepted: false };
            this.changed(); return this.last;
          } else {
            const elapsedAfterSend = this.now() - this.revivePending.sentAt;
            const configuredTimeout = this.config?.hoenn?.pokeReadyTimeoutMs;
            const timeout = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 3000;
            const hp = telemetry.ownPokemon?.healthPercent;
            const confirmed = telemetry.creaturesGeneratedAt > this.revivePending.sentSnapshot
              && Number.isFinite(hp) && hp > 0 && hp <= 100
              && (!this.revivePending.pokemonName
                || normalizeName(telemetry.ownPokemon.name) === normalizeName(this.revivePending.pokemonName));
            const timedOut = revive.waitForPokemon === true && !confirmed && elapsedAfterSend >= timeout;
            const isFinished = elapsedAfterSend >= 300
              && (revive.waitForPokemon !== true || confirmed || timedOut);
            if (isFinished) {
              this.revivePending = null;
              if (this.combat.finishCombo(telemetry)) {
                this.combatActive = false;
                this.queue = [];
                this.targetView = null;
                this.lastCombatSnapshot = null;
                this.last = { status: 'idle', action: 'finish-remaining', inputAccepted: false,
                  reviveOutcome: timedOut ? 'timeout' : confirmed ? 'confirmed' : 'not-requested' };
                this.changed(); return this.last;
              } else {
                this.combatActive = true;
                this.queue = [];
                this.targetView = null;
                this.lastCombatSnapshot = null;
                this.last = { status: 'combat', action: 'restart-combo', inputAccepted: false,
                  reviveOutcome: timedOut ? 'timeout' : confirmed ? 'confirmed' : 'not-requested' };
                this.changed(); return this.last;
              }
            } else {
              this.last = { status: 'revive', action: 'waiting-pokemon', inputAccepted: false };
              this.changed(); return this.last;
            }
          }
        }
      }

      const candidates = this.combat.inspect(telemetry);
      const capture = await this.tryCapture(session, epoch, candidates.length > 0);
      if (capture) return capture;
      if (this.queue.length && !candidates.some(creature => creature.id === this.queue[0].targetId)) {
        this.queue = []; this.combat.clearTarget(); this.targetView = null;
      }
      if (this.now() - this.lastDispatch < this.combatGcd()) return null;
      if (!this.queue.length) {
        const events = [];
        const fight = this.combat.step(telemetry, { command: (name, parameter) => events.push({ name, parameter }) }, this.now(), {
          keyboardTransport: true,
          externalHealing: true,
          luring: this.config?.target?.luring?.enabled === true,
          boxMode: this.engine?.state?.walkerAction === 'box',
          inCombat: this.combatActive === true,
        });
        if (fight.action === 'idle' || fight.action === 'luring') {
          if (fight.action === 'idle') this.combatActive = false;
          this.queue = [];
          this.lastCombatSnapshot = null;
          this.targetView = null;
          this.last = { status: fight.action === 'luring' ? 'luring' : 'idle', action: fight.action, inputAccepted: false };
          this.changed(); return this.last;
        }
        this.combatActive = true;
        if (fight.targetId) {
          const chosen = candidates.find(creature => creature.id === fight.targetId);
          if (chosen) this.targetView = { id: chosen.id, name: chosen.name,
            distance: Math.max(Math.abs(chosen.pos.x - telemetry.position.x), Math.abs(chosen.pos.y - telemetry.position.y)),
            healthPercent: chosen.healthPercent };
        }
        if (fight.reason === 'combo-done') {
          if (revive?.enabled === true && revive.hotkey?.trim() && !this.revivePending) {
            this.revivePending = {
              lastSkillAt: this.combat.state.comboCompletedAt || this.now(),
              sentAt: null,
              pokemonName: this.combat.state.comboPokemonName || telemetry.ownPokemon?.name,
            };
            this.last = { status: 'revive', action: 'waiting-interval', inputAccepted: false };
            this.changed(); return this.last;
          }
          if (this.combat.finishCombo(telemetry)) {
            this.combatActive = false;
            this.queue = [];
            this.targetView = null;
            this.lastCombatSnapshot = null;
            this.last = { status: 'idle', action: 'finish-remaining', inputAccepted: false };
            this.changed(); return this.last;
          } else {
            this.queue = [];
            this.targetView = null;
            this.lastCombatSnapshot = null;
            this.last = { status: 'combat', action: 'restart-combo', inputAccepted: false };
            this.changed(); return this.last;
          }
        }
        const stamp = telemetry.creaturesGeneratedAt || session.generatedAt;
        // Freshness is a safety gate, not a rotation clock. Reusing a still
        // valid scan must not consume actions and discard them afterwards.
        this.lastCombatSnapshot = stamp;
        this.queue = events.map(event => ({ ...event, targetId: fight.targetId }));
        if (!this.queue.length) { this.last = { status: 'combat', action: fight.reason || 'hold', inputAccepted: false }; this.changed(); return this.last; }
      }
      if (epoch !== this.epoch || this.paused) return null;
      const event = this.queue[0];
      const creature = candidates.find(value => value.id === event.targetId);
      if (!creature) { this.queue = []; return null; }
      let request;
      if (event.name === 'attack') request = projectTarget(this.transport.viewport, telemetry.position, creature);
      else {
        const key = event.name === 'hotkey' ? event.parameter : this.transport.bindings[event.parameter];
        if (!key || !['hotkey', 'talk', 'combo'].includes(event.name)) throw Error('Comando sem mapeamento de teclado: ' + event.name + ' ' + event.parameter);
        if (!this.keyReady(key)) return null;
        request = { kind: 'key', key };
      }
      const latest = this.sessions.find(value => value.pid === this.pid);
      this.requireCombatPerception(latest, 'Identidade expirou antes do envio.');
      const current = this.combat.inspect(latest.telemetry).find(value => value.id === creature.id);
      if (!current || latest.telemetry.ownPokemon?.id !== telemetry.ownPokemon?.id) {
        this.queue = []; this.combat.clearTarget(); this.lastCombatSnapshot = null; this.targetView = null; return null;
      }
      if (event.name === 'attack') request = projectTarget(this.transport.viewport, latest.telemetry.position, current);
      this.targetView = { id: current.id, name: current.name,
        distance: Math.max(Math.abs(current.pos.x - latest.telemetry.position.x), Math.abs(current.pos.y - latest.telemetry.position.y)),
        healthPercent: current.healthPercent };
      attemptedSnapshot = latest.telemetry.creaturesGeneratedAt;
      const plannedCombat = this.combat;
      const plannedQueue = this.queue;
      const result = await this.combatInput(this.pid, { ...request, playerName: this.playerName,
        targetGuard: { pid: this.pid, playerName: this.playerName, generatedAt: latest.telemetry.creaturesGeneratedAt,
          player: latest.telemetry.creaturePlayer, own: latest.telemetry.ownPokemon,
          allowMissingOwn: !latest.telemetry.ownPokemon, target: current } });
      this.lastDispatch = this.now();
      plannedCombat.recordDispatch(event.name, event.parameter, this.lastDispatch);
      if (request.key) this.keyUsedAt.set(request.key.toLowerCase(), this.lastDispatch);
      if (this.queue === plannedQueue) this.queue.shift();
      const record = { ...result, generatedAt: new Date(this.lastDispatch).toISOString(), targetId: creature.id,
        targetName: creature.name, targetHp: creature.healthPercent, command: event.name, effectVerified: false };
      this.dispatchLog.push(record); this.dispatchLog = this.dispatchLog.slice(-100);
      this.onDispatch(record);
      if (epoch !== this.epoch) return null;
      this.last = { status: 'combat', action: event.name, inputAccepted: true, effectVerified: false };
      this.changed(); return this.last;
    } catch (error) {
      if (epoch !== this.epoch) return null;
      if (error.code === 'COMBAT_SNAPSHOT_DESYNC') {
        this.perceptionDesyncAt ??= this.now();
        if (this.now() - this.perceptionDesyncAt <= this.maxAgeMs) {
          this.last = { status: 'synchronizing', action: 'wait-perception', reason: error.message,
            inputAccepted: false, effectVerified: false };
          this.changed(); return this.last;
        }
      }
      if (error.code === 'COMBAT_TARGET_MOVED' && attemptedSnapshot && this.queue.length) {
        this.retryCombatSnapshot = attemptedSnapshot;
        this.retryCombatAt = this.now() + ATTACK_RETRY_MS;
        this.last = { status: 'retrying', action: this.queue[0].name === 'attack' ? 'reproject' : 'retry-key', reason: error.message, inputAccepted: false };
        this.changed(); return this.last;
      }
      this.paused = true; this.epoch++; clearInterval(this.timer); this.timer = null; this.queue = []; this.targetView = null;
      this.last = { status: error.code === 'WALKER_FOCUS_LOST' ? 'paused' : 'error', error: error.message,
        inputAccepted: false, transportResult: error.result, effectVerified: false, retrySafe: false };
      this.changed(); return this.last;
    }
  }

  async close() { await super.close(); this.combat = null; this.healer = null; this.queue = []; this.targetView = null; }
}

module.exports = { RpmCombatRuntime };
