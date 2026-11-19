# Missões 5–11 · Cura, captura, lure, navegação e fidelidade

Os IDs seguem o [brief do DeepSeek](BRIEF_GPT_VALIDACAO.md). As missões P1 medem efeitos específicos. As P2 tratam regras parciais, movimento de combate e fluidez. O aceite F1–F5 da hunt está no [primeiro arquivo](MAPA_MISSOES_PENDENTES.md).

M5 e M6 precisam de sessão estável. M7 tem coleta de vídeo dedicada. M8 reaproveita a parede de M3. M9 é offline. M10 depende da observação espacial de M7 para fechar o `kite`. M11 reaproveita amostras de M1 e M3 que tenham cobertura suficiente.

Para cada missão, guardar cenário, versão, configuração, dados com timestamps e veredito por caso. Usar `CONFIRMADO`, `FALHOU`, `INCONCLUSIVO` ou `BLOQUEADO`. Quando um campo não puder ser medido, registrar `INDISPONÍVEL` e o motivo. A entrega termina com **O que não foi provado**.

## M5 · P1 · Recuperação de HP do treinador e do Pokémon

**Estado.** Na [auditoria de 18/11](../../live-channel-audit.json), houve dois comandos de cura e 15 amostras com HP em 91. Ainda faltam medições conclusivas por entidade.

**Pré-requisitos.** Configurar o Pokémon curador do treinador e, para curar o Pokémon em combate, o item na barra de ação, com slot 3 como cenário do perfil e hotkey configurável. Usar uma sessão em que o HP e a identidade da entidade testada sejam observáveis.

**Etapas.** Fazer dois casos independentes. Primeiro, observar o HP do treinador cruzar o limiar e acompanhar a cura pelo Pokémon configurado. Depois, fazer o mesmo para o HP do Pokémon, registrando o uso da hotkey da potion. Guardar amostras antes e após a ação, o limiar usado, a identidade da entidade e o cooldown, quando observável. Registrar regeneração ou cura concorrente que coincida com a janela.

**Entrega e aceite.** Duas séries de HP com veredito independente. Confirmar cada caso quando o HP da mesma entidade subir após a ação esperada e o contexto sustentar a atribuição. Se faltar HP, identidade ou outro dado indispensável ao caso, marcar o campo indisponível e registrar se a medição ficou bloqueada ou inconclusiva.

## M6 · P1 · Captura com efeito no corpo correto

**Estado.** O [brief](BRIEF_GPT_VALIDACAO.md#m6--p1--captura-efeito-no-corpo) registra evidência estática. Continua pendente a prova do efeito durante uma tentativa.

**Pré-requisitos.** Corpo elegível identificável, ball configurada e janela com observação contínua do corpo. Registrar ID ou outro identificador consistente, posição e estado inicial.

**Etapas.** Acompanhar uma tentativa, correlacionando horário, corpo escolhido e estado observado depois. Se o corpo sumir, registrar se o personagem ficou na mesma região e se havia evidência de expiração. Se houver dado de inventário, registrar o consumo da ball e o resultado exibido ao jogador.

**Entrega e aceite.** Uma linha do tempo vinculando o corpo à tentativa e à mudança observada. Consumo de ball confirma uso do item. Para confirmar o efeito no corpo, exigir transição identificável, como estado atualizado ou desaparecimento atribuível à tentativa. Se a mudança coincidir com expiração ou perda de visibilidade sem distinção observável, classificar como inconclusiva.

## M7 · P1 · Parada física e distância durante a lure

**Estado.** Existem durações de referência para `travel`, `arc`, `stationary` e `wait`. A captura disponível não mostra os monstros selvagens necessários para medir a geometria da lure.

**Pré-requisitos.** Vídeo com piso, treinador, Pokémon e monstros visíveis, mais registro de fases com timestamps. Usar marcadores de sincronização no início, meio e fim e estimar a precisão do alinhamento. A coleta precisa preservar a resolução temporal usada nas conclusões.

**Etapas.** Alinhar vídeo e eventos. Para cada episódio analisável, anotar início e fim das fases, posição do treinador, deslocamento do Pokémon e distância em tiles até o monstro identificado. Registrar intervalos de imobilidade e o momento da retomada. Marcar trechos ocultos, sobrepostos ou com resolução temporal insuficiente.

**Entrega e aceite.** Vídeo, referência temporal e tabela de episódios com quatro vereditos: parada física, movimento do Pokémon, distância e duração das fases. Informar resolução, número de episódios válidos e campos indisponíveis. Os valores do brief são referência de comparação e o resultado deve trazer as medidas da sessão analisada.

## M8 · P1 · Desvio de parede com A* e OTMM

**Estado.** Há [registro de seis passos para distância direta de cinco](../../local-data/walk-channel-2026-11-18T20-10-12-633Z.json), com chegada a um tile do destino e sem identificação do arquivo de mapa no relatório.

**Pré-requisitos.** Usar o caso de parede de M3 e identificar o OTMM, origem, destino, coordenadas bloqueadas e mesmo andar. Preparar o mesmo cenário com mapa disponível e com o modo guloso.

**Etapas.** Registrar a sequência de posições e o motivo de cada parada nos dois cenários. Conferir a trajetória contra os tiles bloqueados e comparar custo do percurso, resultado de chegada e ponto de divergência entre os modos. Registrar ocupações móveis que possam mudar o percurso de uma execução para outra.

**Entrega e aceite.** Mapa identificado e tabela comparativa com posição inicial, destino, distância direta, percurso, bloqueios e resultado. O A* deve cumprir o critério de chegada registrado no F4, percorrer custo superior ao caminho direto e evitar os tiles bloqueados. Para atribuir o desvio ao A*, registrar qual decisão mudou com o mapa.

## M9 · P2 · Regras parciais de fidelidade

**Estado.** A [especificação `remaining-rules-v1`](../../reconstruction/spec/remaining-rules-v1.json) marca quatro regras como implementáveis com lacunas. É uma missão offline.

| Regra | Lacuna e casos que a evidência precisa distinguir |
| --- | --- |
| `BestTileScore` | Fórmula e desempate. Comparar tiles com números diferentes de posições livres e um empate em que o critério secundário altere a escolha. |
| `NextTeam` | Predicado exato de troca por HP. Cobrir abaixo, no limite e acima dele, além de roster incompleto e passagem do último slot para o primeiro. |
| `ComboBuffDone` | Condição de conclusão baseada no ACK do passo e na contagem de buffs. Distinguir ACK ausente, atraso, contagem parcial e conclusão efetiva. |
| `HealerDeployReady` | Agregação de `gateReadyPct` e `gateMinHp`. Distinguir equipe mista, Pokémon ausente e valores no limiar. |

**Etapas.** Comparar a especificação, as regras implementadas e a evidência estática já arquivada. Para cada lacuna, registrar a regra candidata, a origem verificável da conclusão e um caso em que uma interpretação concorrente produziria outro resultado. Documentar entradas, saída esperada e comportamento do motor atual.

**Entrega e aceite.** Quatro registros com predicado ou pseudocódigo, referência verificável e exemplo discriminante. Quando a evidência sustentar apenas parte do comportamento, manter a regra como parcial e enumerar as condições abertas.

## M10 · P2 · Movimento do treinador durante combate

**Estado.** `chase`, `kite` e `random_move` existem na configuração. O [diagnóstico local](../../reconstruction/combat-readiness.js) registra que esses modos ainda não têm comportamento no motor. `stand` é a referência atual.

**Pré-requisitos.** Combate com alvo estável e posição do treinador e do alvo observáveis. Definir perfis separados por modo e reaproveitar o instrumento da M7 para medir `kite`.

**Etapas.** Definir quem controla o movimento durante o combate, a condição de devolução ao walker e o que ocorre quando o alvo some. Validar `chase` com redução de distância, `kite` com casos abaixo, dentro e acima da distância configurada e `random_move` com seleção restrita aos modos habilitados. Cobrir alvo perdido, tile bloqueado e retomada da rota após o fim do combate. Conferir `stand` no mesmo conjunto de cenários.

**Entrega e aceite.** Resultado por modo, com configuração ativa, série de posições, distância ao alvo, decisões do motor e evidência de retomada. `chase` deve se aproximar quando houver caminho, `kite` deve corrigir a distância conforme `kiteRange`, e `random_move` deve escolher apenas opções ativas. Guardar falhas de despacho e casos de disputa pelo movimento.

## M11 · P2 · Cadência real e fluidez do walker

**Estado.** O walker tem referência de 406 ms. Falta uma distribuição de intervalos do movimento da interface principal em campo.

**Pré-requisitos.** Trajeto livre, versão e perfil registrados e série com timestamps suficientemente precisos para distinguir passos sucessivos. Aproveitar dados de M1/M3 somente se a cobertura permitir separar cada transição.

**Etapas.** Registrar pelo menos 20 passos reais e calcular os intervalos entre mudanças consecutivas de posição. Guardar a contagem de passos e intervalos, lacunas de coleta e eventos de parada. Identificar, na série original, esperas intencionais por waypoint, combate ou transição, além de pausas sem causa identificada.

**Entrega e aceite.** Série original e tabela com N, mínimo, mediana, p95 e pausas prolongadas. Informar quais intervalos entraram no cálculo e o motivo das exclusões. Comparar com a referência de 406 ms e localizar as pausas medidas. O brief exige medição e não define um limite de p95 para classificar a caminhada como fluida.
