'use strict';

/**
 * Consumíveis das Tools: quatro slots com hotkey e intervalo em minutos.
 *
 * CONTRATO DE TEMPO (o mesmo texto da interface): ao ativar com o bot rodando,
 * usa na hora e repete apos 10, 20 e 30 s; a proxima sequencia comeca no
 * intervalo configurado, contado do PRIMEIRO uso. Nao ha comando de item aqui:
 * o unico canal e' `hotkey`, que a DLL executa.
 *
 * Um comando por tick para nao competir com cura/ataque no mesmo instante.
 */

const RETRY_MS = [10000, 20000, 30000];
const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 10080;

function normalizeConsumables(config) {
  const tools = config?.tools || {};
  const slots = [];
  for (let slot = 1; slot <= 4; slot += 1) {
    const entry = tools['consumable' + slot];
    if (!entry || entry.enabled !== true) continue;
    const hotkey = typeof entry.hotkey === 'string' ? entry.hotkey.trim() : '';
    if (!hotkey) continue;
    const minutes = Math.min(MAX_INTERVAL_MINUTES,
      Math.max(MIN_INTERVAL_MINUTES, Math.ceil(Number(entry.intervalMinutes) || MIN_INTERVAL_MINUTES)));
    slots.push({ slot, hotkey, intervalMs: minutes * 60000 });
  }
  return slots;
}

function createConsumablesEngine(config) {
  let slots = normalizeConsumables(config);
  /* Por slot: null = nunca usado nesta ativacao; `attempt` 1..3 = repeticoes
   * rapidas ja feitas (10/20/30 s); `cycleStart` ancora o intervalo. */
  const state = new Map();

  function reset() {
    slots = normalizeConsumables(config);
    state.clear();
  }
  reset();

  function step(now, sink) {
    for (const entry of slots) {
      let current = state.get(entry.slot);
      if (!current) {
        current = { nextAt: null, cycleStart: null, attempt: 0 };
        state.set(entry.slot, current);
      }
      let fire = false;
      if (current.nextAt === null) {
        /* Primeiro uso desta ativacao: imediato. `attempt` conta as repeticoes
         * rapidas ja' feitas (0..3). */
        current.cycleStart = now;
        current.attempt = 0;
        current.nextAt = current.cycleStart + RETRY_MS[0];
        fire = true;
      } else if (current.attempt < RETRY_MS.length) {
        if (now >= current.nextAt) {
          current.attempt += 1;
          if (current.attempt < RETRY_MS.length) {
            current.nextAt = current.cycleStart + RETRY_MS[current.attempt];
          }
          fire = true;
        }
      } else if (now >= current.cycleStart + entry.intervalMs) {
        current.cycleStart = now;
        current.attempt = 0;
        current.nextAt = current.cycleStart + RETRY_MS[0];
        fire = true;
      }
      if (!fire) continue;
      sink.command('hotkey', entry.hotkey);
      return { emitted: [['hotkey', entry.hotkey]], slots: slots.length };
    }
    return { emitted: [], slots: slots.length };
  }

  return {
    step,
    reset,
    get state() { return { configured: slots.length }; },
  };
}

module.exports = { createConsumablesEngine, normalizeConsumables, RETRY_MS };
