'use strict';

const { normalizeName, activePokemon, Cooldown, textFits } = require('./shared.cjs');

const MEDICINE_RETRY_MS = 1500;
const HEAL_RETRY_MS = 1000;
const POTION_RETRY_MS = 1500;

function itemCommand(item, hotkey, slot, keyboardOnly = false) {
  const key = typeof hotkey === 'string' ? hotkey.trim() : '';
  if (key) return { name: 'hotkey', parameter: key };
  if (!keyboardOnly && item === 'potion' && Number.isInteger(slot) && slot >= 1 && slot <= 50) {
    return { name: 'potion', parameter: slot };
  }
  return null;
}

function rosterMatches(telemetry, name) {
  const wanted = normalizeName(name);
  if (!wanted) return null;
  const matches = (Array.isArray(telemetry?.roster) ? telemetry.roster : [])
    .filter(entry => normalizeName(entry.name) === wanted);
  return matches.length === 1 ? matches[0] : null;
}

function createHealerEngine(config, options = {}) {
  const healer = config?.healer || {};
  const hoenn = config?.hoenn || {};
  const state = { potionAt: new Cooldown(), medicineAt: new Cooldown(), healAt: new Cooldown(),
    resetAt: new Cooldown(), switchAt: new Cooldown(), blocked: new Set(), healPokemon: null, switchingTo: null };
  const canSend = (name, parameter) => !options.canSend || options.canSend(name, parameter);

  function hotkeyChannel(prefix, hotkey, actionBar) {
    const command = itemCommand(prefix, hotkey, actionBar, options.keyboardOnly);
    if (!command) {
      state.blocked.add(prefix + '-channel-missing');
      return null;
    }
    if (command.name === 'hotkey') {
      const text = command.parameter;
      if (options.keyboardOnly && !/^(?:f(?:[1-9]|1[0-2])|[a-z0-9])$/iu.test(text)) {
        state.blocked.add(prefix + '-keyboard-channel-unsupported'); return null;
      }
      if (Buffer.byteLength(text, 'utf8') > 255) {
        state.blocked.add(prefix + '-hotkey-too-long');
        return null;
      }
    }
    return canSend(command.name, command.parameter) ? command : null;
  }

  function step(telemetry, sink, now) {
    const emitted = [];
    const send = (name, parameter, extra, cooldown) => {
      sink.command(name, parameter, extra); emitted.push([name, parameter]); state.pendingCooldown = cooldown;
    };
    const done = action => ({ action, emitted, waiting: Boolean(state.switchingTo) || telemetry.isSwitching === true || telemetry.switchPending === true, blocked: [...state.blocked] });
    const health = telemetry.healthPercent;
    const hasHealth = Number.isFinite(health) && health >= 0 && health <= 100;
    const pokemonHealth = telemetry.ownPokemon?.healthPercent;

    if (Number.isFinite(pokemonHealth) && pokemonHealth > 0 && pokemonHealth <= 100
        && Number(hoenn.potionHpPercent) > 0 && pokemonHealth <= Number(hoenn.potionHpPercent)
        && state.potionAt.ready(now, Math.max(0, Number(hoenn.potionCooldownMs) || POTION_RETRY_MS))) {
      const channel = hotkeyChannel('potion', hoenn.potionHotkey, hoenn.potionActionBar);
      if (channel) { send(channel.name, channel.parameter, undefined, state.potionAt); state.potionAt.use(now); return done('heal'); }
    }

    const conditions = Array.isArray(telemetry.conditions) ? telemetry.conditions : [];
    const hasConditions = conditions.length > 0;
    if (hasConditions && hoenn.useMedicine === true && state.medicineAt.ready(now, MEDICINE_RETRY_MS)) {
      const channel = hotkeyChannel('medicine', hoenn.medicineHotkey, hoenn.medicineActionBar);
      if (channel) { send(channel.name, channel.parameter, undefined, state.medicineAt); state.medicineAt.use(now); return done('heal'); }
    }

    if (hasConditions) {
      state.blocked.add('combat-pokemon-debuffed');
      return done('idle');
    }

    const isSwitching = telemetry.isSwitching === true || telemetry.switchPending === true;
    if (state.switchingTo) {
      if (activePokemon(telemetry, state.switchingTo)) state.switchingTo = null;
      else return done('heal');
    }
    if (isSwitching) {
      return done('heal');
    }

    if (Number(healer.healHpPercent) > 0 && hasHealth && health <= Number(healer.healHpPercent)) {
      /* Um Pokemon esta' curado se a identidade dele for conhecida. Isso vem de
       * duas fontes, em ordem:
       *
       *   1. `roster` — a pokebar do jogo (nome + uuid por slot). Fonte completa,
       *      permite escolher QUAL Pokemon curar.
       *   2. `ownPokemon` — o Pokemon invocado no mapa. Fonte parcial: so' cobre
       *      o ativo, mas e' o unico que existe quando a DLL nao publica roster.
       *
       * ANTES: o fallback (2) so' valia com `keyboardOnly`, entao em modo nativo
       * com `roster: []` o healer travava em 'heal-pokemon-unresolved' e nunca
       * curava. Medido: nossa pka_native.dll publica roster vazio (hardcoded).
       *
       * AGORA: (2) vale tambem em modo nativo, SEMPRE que o nome configurado for
       * compativel. Ainda exige que `healPokemonName` case com o Pokemon ativo
       * quando configurado — nao cura o Pokemon errado por engano. */
      const ownName = telemetry?.ownPokemon?.name;
      const ownCompatible = ownName
        && (!healer.healPokemonName || normalizeName(ownName) === normalizeName(healer.healPokemonName));
      const pokemon = rosterMatches(telemetry, healer.healPokemonName)
        || (ownCompatible ? { name: ownName, uuid: telemetry?.ownPokemon?.uuid } : null);
      if (!pokemon) state.blocked.add('heal-pokemon-unresolved');
      else if (options.keyboardOnly && (!activePokemon(telemetry, pokemon.name)
          && (!telemetry?.ownPokemon || normalizeName(telemetry.ownPokemon.name) !== normalizeName(pokemon.name)))) {
        state.blocked.add('keyboard-heal-requires-active-pokemon');
      }
      else if (options.switchBeforeHeal && normalizeName(pokemon.name) !== normalizeName(telemetry.pokemonName)
          && !(ownCompatible && ownName)) {
        if (state.switchAt.ready(now, HEAL_RETRY_MS)) {
          state.switchingTo = pokemon.name;
          send('switchPokemon', textFits(pokemon.name, 255, 'Nome do Pokemon'), undefined, state.switchAt);
          state.switchAt.use(now);
        }
        return done('heal');
      }
      else if (Number.isInteger(healer.healMoveSlot) && healer.healMoveSlot >= 1 && state.healAt.ready(now, HEAL_RETRY_MS)
          && canSend('talk', 'm' + healer.healMoveSlot)) {
        state.healPokemon = pokemon;
        send('talk', 'm' + healer.healMoveSlot, pokemon.uuid ? { expectedUuid: pokemon.uuid } : undefined, state.healAt);
        state.healAt.use(now);
        return done('heal');
      }
    }

    if (state.healPokemon && (!options.switchBeforeHeal || (hasHealth && health > Number(healer.healHpPercent)))
        && Number.isInteger(healer.healResetSlot)
        && healer.healResetSlot !== healer.healMoveSlot && state.resetAt.ready(now, HEAL_RETRY_MS)
        && canSend('talk', 'm' + healer.healResetSlot)) {
      send('talk', 'm' + healer.healResetSlot, state.healPokemon.uuid ? { expectedUuid: state.healPokemon.uuid } : undefined, state.resetAt);
      state.resetAt.use(now);
      state.healPokemon = null;
      return done('heal');
    }

    if (state.healPokemon && hasHealth && health > Number(healer.healHpPercent)) {
      state.healPokemon = null;
    }

    if (state.healPokemon === null && typeof healer.returnPokemonName === 'string' && healer.returnPokemonName.trim()
        && state.switchAt.ready(now, HEAL_RETRY_MS)) {
      const back = rosterMatches(telemetry, healer.returnPokemonName);
      if (back && normalizeName(back.name) !== normalizeName(telemetry.pokemonName)) {
        if (options.keyboardOnly) {
          state.blocked.add('keyboard-pokemon-switch-unsupported'); return done('idle');
        }
        state.switchingTo = back.name;
        send('switchPokemon', textFits(back.name, 255, 'Nome do Pokemon'), undefined, state.switchAt);
        state.switchAt.use(now);
        return done('heal');
      }
    }

    return done('idle');
  }

  return {
    step,
    recordDispatch(timestamp) {
      if (!Number.isFinite(timestamp)) throw Error('Registro de cura invalido.');
      state.pendingCooldown?.use(timestamp); state.pendingCooldown = null;
    },
    reset() { Object.assign(state, { potionAt: new Cooldown(), medicineAt: new Cooldown(), healAt: new Cooldown(),
      resetAt: new Cooldown(), switchAt: new Cooldown(), healPokemon: null, switchingTo: null, pendingCooldown: null }); },
    get state() { return { blocked: [...state.blocked], healing: state.healPokemon !== null || state.switchingTo !== null }; },
  };
}

module.exports = { createHealerEngine, itemCommand, rosterMatches, MEDICINE_RETRY_MS, HEAL_RETRY_MS, POTION_RETRY_MS };
