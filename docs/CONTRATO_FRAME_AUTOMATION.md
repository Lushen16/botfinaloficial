# Contrato de automação por frames

Este documento descreve a lógica e os testes offline existentes. Não declara
equivalência com o cliente nem conclusão da integração de produção.

## Entradas

`createFrameAutomation(config)`, exportado por `reconstruction/automation.cjs`,
retorna um motor com `tick(snapshot, now)`, `reset()` e `state`.
`now` é um número em milissegundos, finito e monotônico. Um relógio inválido ou
regressivo lança `RangeError`; não equivale a uma desconexão.

Exemplo mínimo de amostra de teste:

```js
{
  pid: 7,
  online: true,
  paused: false,
  stale: false,
  runtimeReady: true,
  ageMs: 0,
  telemetry: {
    seq: 1,
    sampledAtMs: 1000,
    position: { x: 100, y: 100, z: 7 },
    player: { id: 0x10000001, name: 'Demo', pos: { x: 100, y: 100, z: 7 } },
    healthPercent: 100,
    creaturesAvailable: true,
    creatures: [],
    itemsAvailable: true,
    items: []
  }
}
```

- `seq` identifica a amostra, não o tick de decisão. O motor também aceita
  `telemetry.tick` como identidade legada. A sequência deve crescer na sessão.
- Um tick repetido não autoriza outra ação. O caminho de replay chama o walker
  com essa mesma identidade; não cria passos a partir de tempo decorrido.
- `player: null` interrompe o fluxo. Identidade de player, PID, `mapId` e piso
  delimitam a sessão; uma mudança invalida pendências.
- Um frame nulo antigo não pode renovar tentativas de alvo ou de corpo.
- `creaturesAvailable: false` significa desconhecido; lista residual é ignorada.
  `true` com `[]` significa ausência observada. A mesma distinção se aplica a
  itens por meio de `itemsAvailable`.
- `nativeVerified` e `pulseVersion` pertencem ao contrato externo do snapshot;
  o motor por frames não os usa para atestar autenticação ou origem dos dados.
  `ageMs` é exibido no painel, mas não é um filtro próprio de frescor desse motor.

## Criaturas e itens

Criaturas possuem `id, name, pos, type, canAttack` e `hp` ou
`healthPercent`. Se `healthPercent` existir, ele prevalece sobre `hp`,
inclusive quando for `null`.

Somente `type === 1` permite seleção como selvagem. IDs da família
`0x8xxxxxxx`, `ownPokemon: true` e `isOwnPokemon: true` indicam posse;
IDs da família `0x1xxxxxxx` e o ID do próprio player não podem ser alvo.
NPCs e players ficam fora da contagem de engajamento.

HP nulo permanece desconhecido e não equivale a zero. A primeira leitura
numérica estabelece uma referência. Uma queda numérica posterior indica
efeito observado; um intervalo de HP desconhecido não comprova dano nem
apaga a última referência numérica. Isso não atribui causalidade a um comando.

Itens usados pela captura possuem `id, pos` e podem incluir `stack, name,
kind, instanceId`. O motor só considera itens quando `itemsAvailable === true`.
As regras em `looting.captureEntries` aceitam `corpseId`, `corpseIds` ou,
para `kind: 'corpse'`, nome. Recursos de fallback podem ser
`fallbackBallKey` ou `fallbackBallSlot`.

## Decisões e ordens

O retorno inclui `phase, pauseWalker, allowMovement, orders, monitor,
creaturesAvailable, targetId, effectVerified` e, quando aplicável, `wildCount`.
`wildCount: null` significa contagem indisponível. Não deve ser exibido como zero.
`monitor` contém `actions` e os estados das regras.

O motor não recebe um adaptador. Emite intenções de ação para inspeção.
O replay compõe essas decisões com o walker real e normaliza as ordens:

| Ordem | Saída direta do motor de frames | Saída normalizada do replay |
| --- | --- | --- |
| Ataque | `{ name: 'attack', parameter: { x, y } }` | `{ name: 'attack', parameter: { pos: { x, y } } }` |
| Texto | `{ name: 'talk', parameter: texto }` | Igual |
| Potion | `{ name: 'potion', parameter: tecla }` | Igual |
| Captura | `{ name: 'capture', parameter: { pos, corpseId, ballKey? , ballSlot?, attempt } }` | `{ name: 'capture', parameter: { x, y, ball } }` |
| Caminhada | Não é emitida diretamente | `{ name: 'walk', parameter: direção }` |

O healer também pode planejar `switchPokemon`, um nome de Pokémon. Trata-se
de uma ordem pendente; o contrato de transporte solicitado não garante suporte
a ela. Não deve ser convertida silenciosamente em sucesso.

Quando `allowMovement` é falso, o replay avisa o walker com
`notifySkipped()`. `await-frame` é a exceção: um tick repetido não invalida
o passo só por ter sido consultado novamente.

## Matriz de decisão

| Prioridade | Condição | Decisão | Movimento |
| --- | --- | --- | --- |
| 1 | Pausa, player ausente/inválido, sessão indisponível | Interrompe e limpa pendências | Segurado |
| 1 | Troca de player, mapa, PID ou piso | Reinicia estado da sessão; consome a amostra de transição | Segurado na transição |
| 1 | Amostra repetida ou antiga | `await-frame` | Sem novo passo |
| 1 | Observação de criaturas passa a indisponível | Cancela pendências e anuncia blind | Segurado nessa amostra |
| 2 | Revive armado | Espera intervalo, emite uma potion e, se configurado, espera Pokémon ou timeout | Segurado |
| 3 | HP medido do player abaixo do limiar e cooldown vencido | Potion de emergência | Segurado nesse tick |
| 4 | Healer autorizado pela configuração | Cura, reset de slot ou retorno | Segurado enquanto houver ação/espera |
| 5 | Alvo válido, regras de alcance/contagem satisfeitas | Ataque e combo conforme a sequência | Segurado |
| 6 | Sem engajamento, corpo elegível e itens disponíveis | Captura ou espera do cooldown do corpo | Segurado |
| 7 | Nenhuma ação acima e posição válida | Libera walker ou indica waypoint BOX | Liberado |

Blind permite somente decisões baseadas nos dados ainda conhecidos: cura
quando autorizada e caminhada. Não executa captura nem inventa selvagens.
`healer.onlyOutsideCombat: true` exige ausência observada de alvos e fim da
pendência de combate; blind sozinho não prova ausência.

## Cooldowns e limpeza

- `target.combo.stepDelay`: intervalo entre skills. Amostra nova não implica
  que esse intervalo já venceu.
- `target.attackCooldownMs`: intervalo de pedido por alvo no modo por frames.
  `maxAttemptsPerTarget` limita tentativas sem confirmação (padrão 3).
  Duas tentativas seguidas de HP numérico sem queda podem antecipar a rotação.
- `target.damageTimeoutMs`: janela de espera por efeito. HP desconhecido
  não dispara uma conclusão instantânea; a janela continua valendo.
- `target.autoRevive.interval`: espera após o último skill; confirmação pode
  esperar até `hoenn.pokeReadyTimeoutMs` (padrão 3000 ms).
- `hoenn.potionCooldownMs`: intervalo da potion de emergência. Usa somente
  o HP do player, estritamente abaixo de `hoenn.potionHpPercent`.
- `looting.captureDelay`: cooldown por corpo. `maxAttemptsPerCorpse`
  limita tentativas (padrão 3). Itens indisponíveis não gastam tentativa nem
  provam desaparecimento. Lista vazia observada libera a rota.
- Pausa, player nulo válido e mudança de sessão limpam pendências e limites.
  Três amostras nulas distintas consecutivas disparam desconexão; uma amostra
  isolada interrompe o combo sem emitir esse alerta.
- Alertas de HP, chat e criaturas respeitam `cooldownMs`. Seus estados
  ficam disponíveis em `state.alerts`.

## Painel de status

O painel da conexão mostra canal informado, intervalo configurado, sequência,
idade e disponibilidade de criaturas/itens. Não muda a configuração.
O intervalo configurado e o intervalo efetivo informado são campos separados.
O segundo lê exclusivamente `effectiveIntervalMs` dos metadados da sessão ou
do runtime com o mesmo PID. Sem essa informação explícita, mostra `—`; não
deduz a cadência pelo canal nem atesta a frequência de leituras.
Metadados do runtime só são usados quando o PID corresponde ao selecionado.
Valores ausentes são exibidos como `—` ou sem informação, nunca inventados.
Um erro explícito de build não suportado pede uma versão compatível; o painel
não descobre perfis nem inicia comandos.

## Migração de configurações antigas

`migrateTelemetry` trata um modo antigo desconhecido usando o valor padrão
já declarado em `TELEMETRY_DEFAULTS`. Preserva os demais campos e não altera
o objeto fornecido pelo chamador. Quando existem as duas representações,
`tools.telemetry` tem precedência sobre `telemetry`, como na normalização.

`validateTelemetry` e `validateConfig` permanecem estritos para uma atribuição
explícita de modo inválido. A migração não encobre outros erros, como intervalo
fora dos limites ou hash malformado. Os testes cobrem a função de migração;
não demonstram que todo caminho de inicialização de perfil persistido passe
por ela antes da validação.

Verificações específicas:

```powershell
node --test tests/telemetry_migration.test.cjs tests/telemetry_status_effective_interval.test.cjs tests/telemetry_status_ui.test.cjs tests/settings.test.cjs
```

## Verificação offline reproduzível

```powershell
node --test tests/telemetry_status_ui.test.cjs tests/frame_adapter_integration.test.cjs tests/frame_runtime_replay.test.cjs tests/frame_automation.test.cjs
node tools/validate.cjs
```

O adaptador de `tests/frame_adapter_integration.test.cjs` é criado em memória
dentro do teste. A função de despacho desse teste captura exceção/recusa e
prossegue para as ordens seguintes. Ela não é o `runTick` de produção.
A ausência de falha no tick simulado não demonstra recuperação do transporte
real. As tentativas e cooldowns do motor são consumidos ao planejar uma ordem;
não há rollback automático após uma recusa de transporte.

`EngineRuntime.replay` e os testes de adaptador usam o motor real de decisões,
mas não acessam processos, executam gestos ou comprovam efeitos no jogo.
O `runTick` de produção continua em seu caminho anterior. Alterá-lo não faz
parte desta entrega.
