!function(e){"use strict";const o="undefined"!=typeof module&&module.exports?require("./messages.js"):e.PkaMessages,n=(e,n)=>({...o.fieldInfo(e),message:o.fieldMessage(e,n)});function a(e){return`Conexão: ${{"Contagem de itens inválida.":"A leitura do inventário está incompleta.","Pokebar inválida.":"A leitura da pokebar está incompleta.","Mapa inválido.":"A leitura do mapa está incompleta.","Estado nativo inválido.":"A leitura da posição ou dos ataques está incompleta.","Condições inválidas.":"A leitura dos estados do Pokémon está incompleta.","Criaturas inválidas.":"A leitura das criaturas no mapa está incompleta.","Itens inválidos.":"A leitura dos itens no mapa está incompleta.","Sequência nativa inválida.":"A leitura do AutoCombo está incompleta.","Identidade da movebar inválida.":"A leitura dos ataques do Pokémon está incompleta."}[e]||"O jogo não enviou todos os dados necessários."} Aguarde a atualização; se persistir, feche o jogo e abra novamente pelo PokeAlliance.exe.`}const i={targetStartIssues:function(e,i,{blocked:t=!1,apiAvailable:s=!0}={}){const r=[],d=i?.telemetry,c=e.target,l=c.combo;return s?t?r.push({action:"profiles",message:"Corrija o arquivo de perfis que não pôde ser carregado. O aviso no topo contém o motivo."}):i?i.authExpired?r.push({action:"connection",message:"Sessão indisponível. Entre novamente pelo PokeAlliance.exe."}):i.error?r.push({action:"connection",message:`Conexão: ${o.message(i.error,"error")}`}):i.online?i.stale||i.ageMs>1e3?r.push({action:"connection",message:"Cliente sem atualização recente. Confira se o jogo está respondendo; reabra pelo PokeAlliance.exe se persistir."}):i.telemetryError?r.push({action:"connection",message:a(i.telemetryError)}):d?.nativeVerified&&3===d.pulseVersion&&1===d.automationVersion?d.position||r.push({action:"connection",message:"Posição do personagem indisponível. Entre no mapa e aguarde a atualização da conexão."}):r.push({action:"connection",message:"Cliente sem os dados necessários para iniciar. Feche o jogo e abra novamente pelo PokeAlliance.exe."}):r.push({action:"connection",message:"Cliente offline. Entre no personagem antes de iniciar o Target."}):r.push({action:"connection",message:"Selecione um cliente na conexão, no topo do menu."}):r.push({action:"connection",message:"Abra o PKA Tools para conectar ao jogo. Esta janela é uma prévia."}),c.monsters.length||r.push(n("target.monsters","adicione pelo menos uma criatura usando + Adicionar.")),c.instanceModeEnabled&&r.push(n("target.instanceModeEnabled","desative o modo instância, que ainda não está disponível.")),!l.enabled||!l.useMedicine&&!l.useMedicineBeforeCombo||l.medicineHotkey.trim()||l.medicineActionBar||r.push(n("target.combo.medicineHotkey","informe a hotkey de Medicine ou desligue “Medicine antes” e “Medicine em debuff” em Antes do combo.")),c.autoRevive.enabled&&!c.autoRevive.hotkey.trim()&&r.push(n("target.autoRevive.hotkey","informe a hotkey de Revive em Finalização / Revive ou desative Revive.")),l.enabled&&l.usePokeStop&&d?.nativeVerified&&!0!==d.conditionEvents&&!0!==d.conditionsKnown&&r.push(n("target.combo.usePokeStop","o jogo não disponibilizou o estado do PokeStop. Desative PokeStop ou reabra o jogo pelo PokeAlliance.exe.")),r},runtimeIssue:function(e){const n=o.details(e);return n.path?n:/> Carregar rota:/u.test(n.message)?{...n,tab:"walker",path:"walker.luaProfile"}:/> Verificar perfil:/u.test(n.message)?{...n,action:"profiles"}:{...n,action:"connection"}},connectionError:a};"undefined"!=typeof module&&module.exports?module.exports=i:e.PkaDiagnostics=i}("undefined"!=typeof window?window:globalThis);

(function (root) {
  'use strict';
  const model = typeof module !== 'undefined' && module.exports ? module.exports : root.PkaDiagnostics;
  const originalTargetStartIssues = model.targetStartIssues;
  const keyboardUnsupported = new Set([
    'target.combo.medicineHotkey',
    'target.combo.usePokeStop',
    'target.autoRevive.hotkey',
  ]);
  const applicable = issues => issues.filter(issue => issue.action !== 'connection'
    && !keyboardUnsupported.has(issue.path));
  model.targetStartIssues = (config, session, options = {}) => {
    const issues = originalTargetStartIssues(config, session, options);
    if (options.blocked || options.apiAvailable === false || session?.source !== 'rpm'
        || !session.online || session.stale || session.ageMs > 1000 || session.error
        || session.authExpired || session.telemetryError) return issues;
    if (session.capabilities?.targetKeyboard === true) return applicable(issues);
    if (session.capabilities?.targetKeyboardIssue) return [{ action: 'connection', message: 'Target RPM: '
      + session.capabilities.targetKeyboardIssue }, ...applicable(issues)];
    const message = 'Backend teclado/RPM ativo: somente Walker está disponível. '
      + 'O Target ainda precisa de um backend de combate com telemetria e envio de comandos; '
      + 'reiniciar o jogo não adiciona esse suporte.';
    return [{ action: 'connection', message }, ...issues.filter(issue => issue.action !== 'connection')];
  };
})(typeof window === 'undefined' ? globalThis : window);

(function(root) {
  'use strict';
  const api = typeof module !== 'undefined' && module.exports ? module.exports : root.PkaDiagnostics;
  const duration = value => Number.isFinite(value) && value >= 0
    ? value < 1000 ? value + ' ms' : (value / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' s' : '—';

  function telemetryStatus(session, runtime = {}, configured = {}, now = Date.now()) {
    runtime = runtime ?? {};
    configured = configured ?? {};
    const telemetry = session?.telemetry ?? {};
    const matchingRuntime = Number.isInteger(session?.pid) && session.pid > 0
      && Number.isInteger(runtime.pid) && runtime.pid === session.pid;
    const runtimeTelemetry = matchingRuntime ? runtime.telemetry ?? {} : {};
    const mode = telemetry.mode ?? telemetry.source ?? runtimeTelemetry.mode;
    const interval = telemetry.intervalMs ?? runtimeTelemetry.intervalMs ?? configured?.intervalMs;
    let age = Number.isFinite(session?.ageMs) && session.ageMs >= 0 ? session.ageMs : null;
    if (age === null && Number.isFinite(telemetry.sampledAtMs) && Number.isFinite(now)
        && now >= telemetry.sampledAtMs) age = now - telemetry.sampledAtMs;
    const codes = [
      session?.reason, session?.blocker?.code, session?.error?.code, session?.telemetryError?.code,
      matchingRuntime ? runtime.reason : null, matchingRuntime ? runtime.error?.code : null,
    ].filter(value => typeof value === 'string');
    const textError = [session?.error, session?.telemetryError, matchingRuntime ? runtime.error : null]
      .filter(value => typeof value === 'string').join(' ');
    const buildUnsupported = codes.some(code => /^build-unsupported$/iu.test(code.trim()))
      || /unsupported[-_ ]build|build[-_ ]not[-_ ]supported|build não suportado|unknown executable identity|executável não suportado/iu.test(textError);
    return {
      mode: ['chain', 'native', 'replay'].includes(mode) ? mode : '—',
      interval: session && Number.isFinite(interval) && interval > 0 ? duration(interval) : '—',
      seq: Number.isSafeInteger(telemetry.seq) && telemetry.seq >= 0 ? String(telemetry.seq) : '—',
      age: duration(age) + (session?.stale && age !== null ? ' · atrasada' : ''),
      creatures: telemetry.creaturesAvailable === false ? 'Blind · criaturas indisponíveis'
        : telemetry.creaturesAvailable === true ? 'Criaturas observadas' : 'Criaturas: sem informação',
      blind: telemetry.creaturesAvailable === false,
      items: telemetry.itemsAvailable === true ? 'Observados' : telemetry.itemsAvailable === false ? 'Indisponíveis' : 'Sem informação',
      buildError: buildUnsupported ? 'Build não suportado. Este executável não possui um perfil validado nesta versão. Solicite uma atualização compatível.' : '',
    };
  }

  function renderTelemetryStatus(document, session, runtime, configured, now) {
    const state = telemetryStatus(session, runtime, configured, now);
    for (const [id, value] of Object.entries({
      'sample-mode': state.mode, 'sample-interval': state.interval, 'sample-seq': state.seq,
      'sample-age': state.age, 'sample-creatures': state.creatures, 'sample-items': state.items,
      'sample-build-error': state.buildError,
    })) {
      const node = document.getElementById(id);
      if (node && node.textContent !== value) node.textContent = value;
    }
    const badge = document.getElementById('sample-creatures');
    badge?.classList.toggle('blind', state.blind);
    const error = document.getElementById('sample-build-error');
    if (error) error.hidden = !state.buildError;
    return state;
  }
  Object.assign(api, { telemetryStatus, renderTelemetryStatus });
})(typeof window === 'undefined' ? globalThis : window);
