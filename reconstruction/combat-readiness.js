(function (root) {
  'use strict';
  const model = typeof module !== 'undefined' && module.exports ? module.exports : root.PkaDiagnostics;
  const originalTargetStartIssues = model.targetStartIssues;
  const keyboardUnsupported = new Set([
    'target.combo.usePokeStop',
  ]);

  /* ─── MOVIMENTO DO TREINADOR ───
   *
   * O schema do fornecedor (`Extracted_Source/shared/schema.js`) promete
   * quatro valores para `target.monsters[].movement`:
   *
   *   chase        "Chase · segue o monstro"
   *   stand        "Stand · fica parado"
   *   kite         "Kite · mantém distância"   (usa kiteRange, 1..30)
   *   random_move  "Random · alterna os de baixo"
   *
   * Nenhum deles é implementado pelo motor de combate — com UMA exceção:
   * `stand`, e por acidente. O combate devolve `pauseWalker: true`
   * (`automation.cjs`), ou seja o treinador fica parado enquanto luta, que é
   * exatamente o que `stand` promete.
   *
   * Medido em 2026-11-16: `grep kiteRange` em `reconstruction/` e `botfinal/`
   * não acha nenhum consumo fora de UI e schema. A config real do usuário usa
   * `movement: "stand"` + `kiteRange: 2`, então hoje o comportamento coincide
   * por sorte, não por implementação.
   *
   * CONSEQUÊNCIA DE NÃO AVISAR: quem configurar `kite` acha que o treinador
   * vai manter distância, mas ele fica parado. É a mesma classe de bug do
   * `holdMovement` do T4 — comportamento prometido que não existe.
   *
   * LIMITE DECLARADO: `movement` só vale com o combo DESLIGADO (o schema diz
   * "Só com o combo Desligado"). Com combo ligado, quem manda no posicionamento
   * é o Best Tile / Perfect lure. Por isso o aviso só aparece quando
   * `target.combo.enabled !== true`.
   */
  const HONOURED_MOVEMENT = new Set(['stand']);

  function movementIssues(config) {
    const target = (config && config.target) || {};
    if (target.combo && target.combo.enabled === true) return [];
    const rows = Array.isArray(target.monsters) ? target.monsters : [];
    const out = [];
    rows.forEach((row, index) => {
      if (!row || typeof row !== 'object') return;
      const movement = row.movement;
      if (!movement || HONOURED_MOVEMENT.has(movement)) return;
      out.push({
        action: 'config',
        path: `target.monsters.${index}.movement`,
        message: `Movimento "${movement}" ainda não é executado: o treinador fica`
          + ' parado durante o combate (equivale a "stand"). Só "stand" é honrado'
          + ' hoje; chase, kite e random_move estão no schema mas não no motor.',
      });
    });
    return out;
  }

  const applicable = issues => issues.filter(issue => issue.action !== 'connection'
    && !keyboardUnsupported.has(issue.path));

  /* Junta sem duplicar path: o modelo original pode já reportar o campo. */
  function merge(front, rest) {
    const vistos = new Set(rest.map(issue => issue.path).filter(Boolean));
    return [...front.filter(issue => !issue.path || !vistos.has(issue.path)), ...rest];
  }

  model.targetStartIssues = (config, session, options = {}) => {
    const issues = originalTargetStartIssues(config, session, options);
    const combo = config?.target?.combo;
    if (combo?.enabled === true && (combo.useMedicine || combo.useMedicineBeforeCombo)
        && !combo.medicineHotkey?.trim() && !issues.some(issue => issue.path === 'target.combo.medicineHotkey')) {
      issues.push({ action: 'config', path: 'target.combo.medicineHotkey',
        message: 'Informe a hotkey de Medicine em Antes do combo.' });
    }
    const movimento = movementIssues(config);

    if (options.blocked || options.apiAvailable === false || session?.source !== 'rpm'
        || !session.online || session.stale || session.ageMs > 1000 || session.error
        || session.authExpired || session.telemetryError) return merge(movimento, issues);
    if (session.capabilities?.targetKeyboard === true) return merge(movimento, applicable(issues));
    if (session.capabilities?.targetKeyboardIssue) return merge(movimento, [{ action: 'connection', message: 'Target RPM: '
      + session.capabilities.targetKeyboardIssue }, ...applicable(issues)]);
    const message = 'Backend teclado/RPM ativo: somente Walker está disponível. '
      + 'O Target ainda precisa de um backend de combate com telemetria e envio de comandos; '
      + 'reiniciar o jogo não adiciona esse suporte.';
    return merge(movimento, [{ action: 'connection', message }, ...issues.filter(issue => issue.action !== 'connection')]);
  };

  /* Exportado para teste e para quem quiser saber o que é honrado sem ler o
   * motor. Fonte unica da verdade desta lista. */
  model.HONOURED_MOVEMENT = HONOURED_MOVEMENT;
})(typeof window === 'undefined' ? globalThis : window);
