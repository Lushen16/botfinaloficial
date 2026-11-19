'use strict';

/*
 * Contrato de capacidades do NOSSO servidor (`pka_native.dll`).
 *
 * Isto NAO e' um contrato recuperado do fornecedor. E' uma extensao nossa,
 * versionada e explicita, publicada no envelope `kind 6` (automation), que ja
 * existia e ja transporta `modules`/`paused`/`monitor`.
 *
 * Motivacao medida (G03):
 *   `Object.keys(COMMANDS)` descreve o que o ENCODER conhece, nao o que o
 *   servidor conectado executa. Os dois simuladores em JS aceitavam qualquer
 *   comando (RuntimeServer com auto-ACK status 0; local-runtime tratando o
 *   resto como no-op e devolvendo true), entao `chase` nunca falhava em teste
 *   e sempre falhava no jogo (`status 4` da DLL -> fault -> sessao encerrada).
 *
 * Regras deste modulo:
 *   - sem declaracao valida NAO existe lista presumida;
 *   - identificacao declarada NAO e' prova de autenticidade nem de efeito;
 *   - o codigo numerico do ACK nunca e' descartado;
 *   - `protocol.cjs` (tabela do fornecedor) nao e' alterado aqui;
 *   - requisitos vem do caminho EFETIVO dos motores, nao do vocabulario.
 */

const { normalizeLuring } = require('./engines/lure-engine.cjs');
const { itemCommand } = require('./engines/healer-engine.cjs');
const { COMMANDS } = require('./protocol.cjs');

const CONTRACT = 'pka-capabilities';
const VERSION = 1;

/* Tipos realmente tratados por `execute_command` em native/pka_native.c
 * (linhas 3171, 3240, 3292, 3308, 3607/3627, 3709, 3748).
 *
 * `revive` (13) esta no mesmo bloco de `potion` (12), mas `protocol.cjs:108`
 * rejeita `revive` no encoder; por isso ele nao entra como capacidade.
 * `action` (9), `useWith` (14), `turn` (17), `order` (16), `orderGround` (21),
 * `follow` (3), `focus` (5), `fight` (11), `refreshCombo` (18), `guildDaily`
 * (25) e `chase` (19) caem em `return STATUS_UNSUPPORTED` (3797).
 *
 * Esta e' a declaracao DA NOSSA DLL — nao um filtro de validacao. Uma
 * declaracao de outro servidor pode legitimamente listar `chase`; quem decide
 * se o nome e' utilizavel e' o encoder (`COMMANDS`), nao esta lista. */
const NATIVE_COMMANDS = Object.freeze([
  'walk', 'attack', 'stop', 'talk', 'combo', 'switchPokemon', 'potion', 'hotkey',
  'useWith', 'recallPokemon',
]);

/* Vocabulario do ENCODER. Um nome fora daqui nao pode nem ser serializado por
 * `protocol.cjs:encodeCommand`, entao declara-lo nao habilita nada.
 *
 * `revive` e' conhecido pelo encoder mas REJEITADO SEMPRE
 * (`protocol.cjs:108`: `command === 'revive' ? false`). Declarar `revive` nao
 * pode virar suporte: o comando nunca sai por este canal. O teste
 * "the encoder rejects revive" prova isso contra a implementacao, em vez de
 * confiar nesta lista. */
const ENCODER_COMMANDS = new Set(Object.keys(COMMANDS).filter(name => name !== 'revive'));

/* Status do NOSSO contrato. Nao substitui `protocol.cjs:STATUS` (fornecedor).
 * `pka_native.c:2300-2306` define: 0 OK, 1 BAD_COMMAND, 2 SEND_FAILED,
 * 3 NO_WINDOW, 4 UNSUPPORTED, 5 NO_FOREGROUND, 6 BACKGROUND_UNSUPPORTED. */
const CONTRACT_STATUS = Object.freeze({
  0: 'Comando entregue ao executor.',
  1: 'Comando invalido para o executor.',
  2: 'Envio falhou (executor tentou e nao conseguiu).',
  3: 'Janela do jogo indisponivel.',
  4: 'Capacidade nao suportada por este servidor.',
  5: 'Sem foco; comando nao executado.',
  6: 'Recusado no modo segundo plano (PKA_EXECUTOR_MODE=background).',
});

const emptyDeclaration = () => ({
  contract: null, version: null, server: null, serverValid: false,
  commands: [], effects: [], unrecognised: [], reason: null,
});

/**
 * Interpreta a declaracao recebida no kind 6.
 *
 * `commands` devolve apenas nomes que o encoder conhece. Nomes desconhecidos
 * ficam em `unrecognised` e NAO habilitam nada — declarar um nome que nao
 * existe no encoder nao pode virar suporte implicito.
 *
 * @returns {{state:'valid'|'unknown'|'malformed'|'absent', contract:?string,
 *            version:?number, server:?string, serverValid:boolean,
 *            commands:string[], effects:string[], unrecognised:string[],
 *            reason:?string}}
 */
function parseDeclaration(value) {
  const empty = emptyDeclaration();
  if (value === undefined || value === null) {
    return { ...empty, state: 'absent', reason: 'Servidor nao declarou capacidades.' };
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ...empty, state: 'malformed', reason: 'Declaracao de capacidades nao e um objeto.' };
  }
  const contract = value.contract;
  if (typeof contract !== 'string' || !contract) {
    return { ...empty, state: 'malformed', reason: 'Declaracao sem identificacao de contrato.' };
  }
  const version = value.version;
  if (!Number.isInteger(version) || version < 1) {
    return { ...empty, state: 'malformed', contract, reason: 'Declaracao sem versao inteira positiva.' };
  }
  const commands = value.commands;
  if (!Array.isArray(commands) || commands.length === 0) {
    return { ...empty, state: 'malformed', contract, version, reason: 'Declaracao sem lista de comandos.' };
  }
  if (commands.some(name => typeof name !== 'string' || !name)) {
    return { ...empty, state: 'malformed', contract, version, reason: 'Lista de comandos invalida.' };
  }
  /* `server` e' INFORMATIVO. Ausente/vazio e' aceitavel, mas registrado:
   * o nome nao autentica o binario nem prova efeito no jogo. */
  const serverValid = typeof value.server === 'string' && value.server.trim().length > 0;
  const server = serverValid ? value.server : null;
  /* `effects` e' opcional e NAO habilita comandos: diz quais comandos o
   * servidor realmente MODELA (muda estado). `commands` diz o que ele aceita
   * sem recusar. Um no-op aceito nao vira efeito implementado. */
  let effects = [];
  if (value.effects !== undefined) {
    if (!Array.isArray(value.effects) || value.effects.some(name => typeof name !== 'string' || !name)) {
      return { ...empty, state: 'malformed', contract, version, server, serverValid, reason: 'Lista de efeitos invalida.' };
    }
    effects = [...new Set(value.effects)];
  }
  /* Contrato reconhecido: mesma identificacao e versao que este modulo entende. */
  if (contract !== CONTRACT || version !== VERSION) {
    return { state: 'unknown', contract, version, server, serverValid,
      commands: [], effects: [], unrecognised: [],
      reason: 'Contrato desconhecido: ' + contract + '/' + version + '.' };
  }
  const unique = [...new Set(commands)];
  /* Nomes que o encoder nao conhece ficam registrados e nao habilitam nada;
   * nomes que ele conhece sao aceitos como declaracao do SERVIDOR (pode ser
   * outro servidor, com `chase` por exemplo). */
  const usable = unique.filter(name => ENCODER_COMMANDS.has(name));
  const unrecognised = unique.filter(name => !ENCODER_COMMANDS.has(name));
  return { state: 'valid', contract, version, server, serverValid,
    commands: usable, effects, unrecognised, reason: null };
}

/** Mensagem de ACK: pelo contrato quando reconhecido, neutra com codigo bruto
 *  quando o contrato e' desconhecido/ausente. Nunca descarta o numero. */
function statusMessage(declaration, code) {
  const numeric = Number.isInteger(code) ? code : Number(code);
  const contract = declaration && declaration.state === 'valid' ? declaration.contract : null;
  const version = declaration && declaration.state === 'valid' ? declaration.version : null;
  if (contract === CONTRACT && version === VERSION
      && Object.prototype.hasOwnProperty.call(CONTRACT_STATUS, numeric)) {
    return { code: numeric, text: CONTRACT_STATUS[numeric], interpreted: true };
  }
  return { code: Number.isFinite(numeric) ? numeric : null,
    text: 'Resposta com codigo ' + (Number.isFinite(numeric) ? numeric : '?') + ' (contrato nao reconhecido).',
    interpreted: false };
}

/* ---------------------------------------------------------------------------
 * Requisitos por modulo/configuracao.
 *
 * Cada requisito e': { module, feature, commands, mode: 'all'|'any' }.
 * Cada entrada corresponde a um caminho que o motor REALMENTE emite, com a
 * configuracao dada. Nao exigimos comandos que a config nao usa; nao aceitamos
 * canal alternativo quando o motor nao faz esse fallback.
 * ------------------------------------------------------------------------- */

/* `stop` interrompe movimento E combate: `pauseWalker()` manda `stop` sempre
 * que o runtime precisa parar. Sem ele o runtime nao consegue conter o que
 * iniciou — por isso entra no requisito de target e walker. */
const INTERRUPT_COMMAND = 'stop';

function _mode(config) {
  return normalizeLuring(config).mode;
}

function comboRequirement(combo) {
  if (combo?.enabled !== true) return null;
  const native = combo.useNativeSequence === true;
  if (native) {
    const nativeHotkey = (typeof combo.nativeHotkey === 'string' && combo.nativeHotkey.trim())
      || (typeof combo.hotkey === 'string' && combo.hotkey.trim());
    /* Com hotkey nativa o alvo manda `hotkey`; sem ela cai em `combo`. */
    return nativeHotkey ? 'hotkey' : 'combo';
  }
  /* Combo enumerado: uma skill por vez via `talk` (target-engine.cjs:585). */
  return 'talk';
}

/**
 * Requisitos de capacidade para os modulos + configuracao dados.
 * @returns {{requirements:Array, commands:string[]}}
 */
function requirementsFor(modules = [], config = {}) {
  const active = new Set(modules);
  const requirements = [];
  const target = config?.target || {};
  const combo = target.combo || {};
  const hoenn = config?.hoenn || {};
  const healer = config?.healer || {};
  const push = (module, feature, commands, mode = 'all') => {
    const list = [...new Set(commands.filter(Boolean))];
    if (!list.length) return;
    requirements.push({ module, feature, commands: list, mode });
  };

  if (active.size) {
    /* Consumíveis das Tools rodam junto de qualquer modulo. Slot ligado sem
     * hotkey e' ignorado em silencio pelo motor; exigir cedo evita "liguei e
     * nao usou". */
    const toolsConfig = config?.tools || {};
    for (let slot = 1; slot <= 4; slot += 1) {
      if (toolsConfig['consumable' + slot]?.enabled === true) {
        push('tools', 'consumable' + slot, ['hotkey']);
      }
    }
  }

  if (active.has('target')) {
    /* Ataque + interrupcao. `attack` sai sempre (target-engine.cjs:407). */
    push('target', 'target', ['attack', INTERRUPT_COMMAND]);

    /* `talk` do alvo: healSkill (274-285), lureSkill (426-432), PokeStop (535)
     * e Best Tile. Sao caminhos independentes; qualquer um exige `talk`. */
    const talkPaths = [];
    if (target.healSkill?.enabled === true) talkPaths.push('healSkill');
    if (target.lureSkill?.enabled === true) talkPaths.push('lureSkill');
    if (combo.usePokeStop === true) talkPaths.push('PokeStop');
    if (comboRequirement(combo) === 'talk') talkPaths.push('combo');
    if (talkPaths.length) push('target', 'target-talk', ['talk']);

    const comboCmd = comboRequirement(combo);
    if (comboCmd === 'combo') push('target', 'combo', ['combo']);
    if (comboCmd === 'hotkey') push('target', 'combo-hotkey', ['hotkey']);
    if (combo.enabled === true && (combo.useMedicine === true || combo.useMedicineBeforeCombo === true)
        && typeof combo.medicineHotkey === 'string' && combo.medicineHotkey.trim()) {
      push('target', 'combo-medicine', ['hotkey']);
    }

    /* Rotacao de skills avulsas (target-engine.cjs:411-414). */
    if (Array.isArray(target.skills) && target.skills.length) push('target', 'skills', ['hotkey']);

    /* autoRevive usa HOTKEY, nao `revive` (reviveStep, automation.cjs:138). */
    if (target.autoRevive?.enabled === true
        && typeof target.autoRevive.hotkey === 'string' && target.autoRevive.hotkey.trim()) {
      push('target', 'autoRevive', ['hotkey']);
    }

    /* dynamic lure emite `chase 0/1`. Sem a capacidade o regroup nao existe. */
    if (_mode(config) === 'dynamic') push('target', 'dynamic-lure', ['chase']);
  }

  if (active.has('walker')) {
    const waypoints = Array.isArray(config?.walker?.waypoints) ? config.walker.waypoints : [];
    const required = ['walk', INTERRUPT_COMMAND];
    if (waypoints.some(point => point && point.action === 'say')) required.push('talk');
    push('walker', 'walker', required);
  }

  if (active.has('healer')) {
    /* Potion (healer-engine.cjs:52-56) so' quando o limiar esta' ligado. */
    if (Number(hoenn.potionHpPercent) > 0) {
      const command = itemCommand('potion', hoenn.potionHotkey, hoenn.potionActionBar);
      if (command) push('healer', 'potion', [command.name]);
    }
    /* Medicine (:60-63) exige a flag E o canal. Medicine NAO tem fallback
     * numerico: so' sai por hotkey (diferente de potion). Sem hotkey o motor
     * trava em `medicine-channel-missing` a cada tick com debuff; exigir aqui
     * faz o start falhar com mensagem em vez de iniciar e nao curar. */
    if (hoenn.useMedicine === true) {
      push('healer', 'medicine', ['hotkey']);
    }
    /* Cura do Pokemon (:114-120) e' `talk mX`; o reset tambem (:126-127). */
    if (Number(healer.healHpPercent) > 0 && Number.isInteger(healer.healMoveSlot)
        && healer.healMoveSlot >= 1) {
      push('healer', 'heal', ['talk']);
    }
    /* Retorno ao Pokemon inicial (:137-148) e' `switchPokemon`. */
    if (typeof healer.returnPokemonName === 'string' && healer.returnPokemonName.trim()) {
      push('healer', 'healer-return', ['switchPokemon']);
    }
  }

  const commands = [...new Set(requirements.flatMap(entry => entry.commands))];
  return { requirements, commands };
}

/**
 * Avalia os requisitos contra uma declaracao.
 * @returns {{ok:boolean, missing:Array<{module,feature,commands,mode,reason}>}}
 */
function evaluate(requirements, declaration) {
  const known = declaration && declaration.state === 'valid';
  const declared = new Set(known ? declaration.commands : []);
  const missing = [];
  for (const entry of requirements) {
    const lacking = entry.commands.filter(name => !declared.has(name));
    if (known && lacking.length === 0) continue;
    missing.push({ ...entry, lacking,
      reason: known
        ? 'servidor nao declara ' + lacking.join(', ')
        : 'servidor nao declarou capacidades reconhecidas (' + (declaration?.state || 'absent') + ')' });
  }
  return { ok: missing.length === 0, missing };
}

/** Texto objetivo para o usuario, sem prometer que o recurso funciona. */
function describeMissing(missing) {
  return missing.map(entry => {
    const capability = entry.mode === 'any'
      ? 'uma de [' + entry.commands.join(', ') + ']'
      : '[' + entry.commands.join(', ') + ']';
    return 'Recurso "' + entry.feature + '" (modulo ' + entry.module + ') exige capacidade ' + capability
      + ': ' + entry.reason + '.';
  }).join(' ');
}

module.exports = {
  CONTRACT, VERSION, NATIVE_COMMANDS, CONTRACT_STATUS, INTERRUPT_COMMAND,
  parseDeclaration, statusMessage, requirementsFor, evaluate, describeMissing,
};
