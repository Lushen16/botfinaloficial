'use strict';

/**
 * Captura pelo canal nativo (`useWith`) quando o pulso publica corpos em
 * `items[]` (pka_native.dll >= 2026-11-19).
 *
 * Diferente do CaptureRuntime (transporte por teclado + identidade RPM), aqui a
 * unica fonte e' a telemetria do canal: `items[].corpseId` + `pos`. O comando
 * leva a tecla da bola (config) e o clique e' feito pela DLL.
 *
 * Config (`looting`):
 *   captureEnabled      liga/desliga
 *   maxCaptureDist      raio em tiles (default 3)
 *   captureAfterCombat  so' captura sem combate ativo
 *   ballSlot            slot da action bar que a DLL clica antes do corpo (0 = nao clicar)
 *   ballKey             tecla opcional da bola (Pokébar/action bar); vazio = sem tecla
 *   captureDelay        espera entre tentativas (ms)
 */

const MAX_ATTEMPTS_PER_CORPSE = 5;

const chebyshev = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

function validPosition(position) {
  return position && ['x', 'y', 'z'].every(axis => Number.isInteger(position[axis]))
    && position.x >= 0 && position.x <= 65534 && position.y >= 0 && position.y <= 65534
    && position.z >= 0 && position.z <= 15;
}

function channelCaptureConfig(config) {
  const looting = config?.looting || {};
  return {
    enabled: looting.captureEnabled === true,
    afterCombat: looting.captureAfterCombat === true,
    maxDistance: Number.isFinite(Number(looting.maxCaptureDist)) && Number(looting.maxCaptureDist) >= 1
      ? Math.floor(Number(looting.maxCaptureDist)) : 3,
    ballSlot: Number.isInteger(Number(looting.ballSlot)) ? Math.max(0, Math.min(20, Number(looting.ballSlot))) : 0,
    ballKey: typeof looting.ballKey === 'string' ? looting.ballKey.trim() : '',
    delayMs: Number.isFinite(Number(looting.captureDelay)) && Number(looting.captureDelay) >= 200
      ? Math.floor(Number(looting.captureDelay)) : 1000,
  };
}

class ChannelCaptureRuntime {
  constructor() { this.reset(); }

  reset() {
    this.history = new Map();
    this.last = { status: 'off', effectVerified: false };
    this.nextAttemptAt = 0;
  }

  plan(telemetry, config, now, options = {}) {
    const settings = channelCaptureConfig(config);
    if (!settings.enabled) { this.last = { status: 'off', effectVerified: false }; return null; }
    if (options.canCapture === false) { this.last = { status: 'blocked', reason: 'useWith-unavailable' }; return null; }
    if (settings.afterCombat && options.inCombat !== false) { this.last = { status: 'blocked', reason: 'capture-after-combat' }; return null; }
    if (!validPosition(telemetry?.position) || !Array.isArray(telemetry.items) || !telemetry.items.length) {
      this.last = { status: 'idle', reason: 'no-corpse', effectVerified: false };
      return null;
    }
    if (Number.isFinite(now) && now < this.nextAttemptAt) { this.last = { status: 'cooldown', effectVerified: false }; return null; }

    const nowMs = Number.isFinite(now) ? now : Date.now();
    const candidates = [];
    for (const item of telemetry.items) {
      if (!item || !Number.isInteger(item.id) || !validPosition(item.pos)) continue;
      if (item.pos.z !== telemetry.position.z) continue;
      const distance = chebyshev(item.pos, telemetry.position);
      if (distance > settings.maxDistance) continue;
      const key = String(item.corpseId ?? item.id);
      const history = this.history.get(key) || { attempts: 0, nextAt: 0 };
      if (history.attempts >= MAX_ATTEMPTS_PER_CORPSE) continue;
      if (Number.isFinite(history.nextAt) && nowMs < history.nextAt) continue;
      candidates.push({ key, item, distance, history });
    }
    if (!candidates.length) { this.last = { status: 'idle', reason: 'no-eligible-corpse', effectVerified: false }; return null; }
    candidates.sort((a, b) => a.distance - b.distance || String(a.key).localeCompare(String(b.key)));
    const candidate = candidates[0];
    this.last = { status: 'planned', corpseId: candidate.item.id, distance: candidate.distance, effectVerified: false };
    return {
      key: candidate.key,
      item: candidate.item,
      history: candidate.history,
      parameter: {
        x: candidate.item.pos.x,
        y: candidate.item.pos.y,
        z: candidate.item.pos.z,
        itemId: 1,
        targetId: candidate.item.corpseId ?? candidate.item.id,
        stack: settings.ballSlot,
        ...(settings.ballKey ? { key: settings.ballKey } : {}),
      },
      settings,
    };
  }

  record(candidate, config, now, accepted) {
    const settings = channelCaptureConfig(config);
    const nowMs = Number.isFinite(now) ? now : Date.now();
    const entry = candidate.history || { attempts: 0, nextAt: 0 };
    entry.attempts += 1;
    entry.nextAt = nowMs + settings.delayMs;
    this.history.set(candidate.key, entry);
    this.nextAttemptAt = entry.nextAt;
    this.last = { status: accepted ? 'dispatched' : 'rejected', corpseId: candidate.item.id,
      attempts: entry.attempts, inputAccepted: accepted, effectVerified: false };
    return this.last;
  }

  /** Corpo sumiu de `items[]` entre tentativas: a captura pode ter dado certo. */
  observedRemoval(telemetry) {
    const present = new Set((telemetry?.items || []).map(item => String(item.corpseId ?? item.id)));
    for (const key of [...this.history.keys()]) if (!present.has(key)) this.history.delete(key);
  }
}

module.exports = { ChannelCaptureRuntime, channelCaptureConfig, MAX_ATTEMPTS_PER_CORPSE };
