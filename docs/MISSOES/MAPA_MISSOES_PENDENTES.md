# Missões 1–4 · Caminho crítico da hunt

**Escopo.** Interface principal e motores de `reconstruction/`. Os IDs preservam o [brief do DeepSeek](BRIEF_GPT_VALIDACAO.md). As fases F0–F5 vêm do [protocolo de validação](../PROTOCOLO_VALIDACAO.md). As [missões 5–11](MISSOES_COMPLEMENTARES_M05_M11.md) têm critérios próprios.

**Ordem.** F0/F1 → M1/F2 → M2/F3 → M3/F4 → M4/F5. A prontidão foi registrada em 18/11 e precisa ser conferida na sessão usada para o fechamento. O [registro da suíte](../../validation.json) de 19/11 mostra 997 testes aprovados no Electron, 989 aprovados e 8 pulados no Node, e smoke e auditoria de UI aprovados. O aceite em campo depende das evidências abaixo.

## Registro comum

Para cada caso, guardar data, identificação da sessão, versão testada, perfil, parâmetros relevantes, arquivo de evidência e primeira divergência. Usar observações da sessão com timestamp e conservar separadamente o comando solicitado, o resultado do despacho e o efeito observado. Em posição, exigir coordenada válida, mesmo personagem e identificação do andar. Se a amostragem tiver lacunas, registrar a cobertura e quais conclusões ficam limitadas.

Cada missão entrega um veredito com `CONFIRMADO`, `FALHOU`, `INCONCLUSIVO` ou `BLOQUEADO`, a evidência por caso, a primeira divergência e a seção **O que não foi provado**. Usar `BLOQUEADO` se faltar pré-condição, `INCONCLUSIVO` se a observação não permitir medir e `FALHOU` se a medição for suficiente e contrariar o aceite. Um campo sem medição fica `INDISPONÍVEL`. Registrar a primeira tentativa de cada cenário. Em caso de falha, preservar os arquivos antes de qualquer nova rodada e identificar o que mudou.

## M1 · P0 · Passo unitário e verificação isolada de ataque

**Estado.** O [registro de 18/11](../../local-data/walk-validation-2026-11-18T20-08-28-594Z.json) confirma `(0, -1, 0)` entre duas leituras do mesmo personagem. A trajetória entre elas continua inconclusiva. O ataque isolado é um check adicional exigido pelo F2.

**Pré-requisitos.** F1 verificada, personagem em tile estável, direção cardinal com um tile livre e nenhuma rota concorrente. Para o ataque, escolher uma criatura identificável e observável na janela.

**Etapas.** Registrar a posição estável antes do comando e acompanhar a série durante e depois de uma única solicitação de passo. Comparar cada mudança de posição com a direção esperada, mantendo a coleta até a posição estabilizar. Registrar intervalo de amostragem e lacunas. Em um cenário separado, registrar identidade e HP do alvo antes e depois de uma tentativa de ataque, guardando as mudanças na lista de criaturas.

**Entrega e aceite.** Série timestampada com a quantidade de comandos, caminho observado, delta esperado e observado, andar e identidade do personagem. Confirmar a caminhada quando a série sustentar uma única transição de um tile na direção esperada, no mesmo andar, sem passo adicional na janela. Se só houver antes/depois, separar `efeito confirmado` de `trajetória inconclusiva`. Para o ataque isolado, registrar queda de HP ou saída do alvo da lista, com contexto suficiente para descartar perda de visibilidade como explicação. Ver o [caso unitário do F2](F2-A-passo-caminhada.md).

## M2 · P0 · Target, Combo e Revive pela interface principal

**Estado.** Na [auditoria de 18/11](../../live-channel-audit.json), 11 entradas no snapshot coexistiram com `no-creature` e zero ataques. O Revive ficou em `no-combo`, o roster estava vazio e a notificação do monitor passou. A causa de `no-creature` ainda precisa ser identificada.

**Pré-requisitos.** F1/F2 com evidência registrada, um perfil identificável com Target, Combo e Revive habilitados, e um alvo vivo observável nessa configuração.

**Etapas.** Primeiro, cruzar um snapshot da execução com a configuração ativa e com os filtros do Target. Para cada candidato, conferir tipo, atacabilidade, HP, alcance, nome ignorado e `minCount`, separando valores ausentes de valores presentes que rejeitam o candidato. Identificar a primeira condição responsável pela ausência de alvos elegíveis. Depois, acompanhar o alvo escolhido até o dano ou sua saída, registrar início e fim do combo e verificar se o Pokémon configurado reaparece após o Revive, ou se ocorre timeout. Investigar `roster: 0` como lacuna de observabilidade da sessão e registrar seu impacto nos checks que dependem da lista de Pokémon.

**Entrega e aceite.** Auditoria F3 com `ok: true` e os checks de conexão, canal, efeito do ataque, comando do healer, Revive, monitor e erros exigidos no protocolo. Anexar a evidência de seleção, efeito no alvo e retorno do Pokémon. O teste específico de recuperação efetiva de HP fica em M5. Se a seleção voltar a falhar, fechar o diagnóstico nesse ponto e registrar o Revive como dependente da execução do combo.

## M3 · P0 · Walker da interface principal

**Estado.** O caso [`free`](../../local-data/walk-channel-2026-11-18T20-11-16-871Z.json) marcou sucesso a um tile do destino. [`box`](../../local-data/walk-channel-2026-11-18T20-10-47-838Z.json) registrou `arrived-adjacent` em um passo e 216 ms. [`wall`](../../local-data/walk-channel-2026-11-18T20-10-12-633Z.json) registrou seis passos para distância em reta de cinco, com chegada a um tile do alvo. Não foi localizado relatório de `stairs`.

**Pré-requisitos.** Usar o walker de `reconstruction/` pelo caminho da interface principal. Preparar um cenário por caso, com destino, posição inicial, ocupação e arquivo OTMM documentados quando relevantes. Antes de classificar `free`, usar o critério escrito no F4, que exige chegada exata. Se a margem de um tile for adotada como aceite do walker, registrar essa decisão no F4. O passo unitário de M1 continua exigindo delta exato.

| Caso | Execução e critério de aceite |
| --- | --- |
| `free` | Escolher alvo a três tiles em corredor livre. Registrar cada deslocamento, mesmo andar e ausência de `stuck`. Conferir chegada pelo critério F4 registrado previamente. |
| `box` ocupado | Confirmar a criatura viva no tile do waypoint antes da aproximação. Registrar chegada exata ou `arrived-adjacent` em até um passo na aproximação final, sem ciclos de ida e volta. |
| `box` bloqueado sem criatura visível | Registrar o bloqueio e acompanhar a guarda de órbita até `stuck`. O protocolo cita cerca de 13 comandos. Guardar a sequência para demonstrar que não houve órbita. |
| `wall` | Usar mapa OTMM identificado e um destino que exija contornar uma parede. Registrar tiles visitados, maior percurso que a distância direta e chegada conforme o F4. M8 reaproveita o cenário para comparar o A* com o guloso. |
| `stairs` | Com direção configurada, registrar um único passo nessa direção e mudança de `z`. Cobrir os dois controles: direção presente sem transição produz `stairs-timeout` em cinco segundos, e waypoint sem direção emite zero passos. |

**Entrega e aceite.** Um relatório por cenário, com comandos, amostras de posição, motivo de chegada ou parada e veredito. No caso de falha, identificar se a primeira divergência está na escolha do passo, na execução do passo ou no critério do verificador.

## M4 · P0 · Rota de hunt em loop por 3–5 minutos

**Estado.** O mapa anterior não encontrou evidência da interface principal fechando o ciclo. Depende de M2 e M3.

**Pré-requisitos.** Fases anteriores aprovadas na mesma sessão, rota conhecida com `loop: true`, `box` e `safespot`, e perfil com Target e Combo configurados. Escolher um trecho em que a rota possa completar uma volta e encontrar combate dentro da janela.

**Etapas.** Registrar rota, posição inicial e módulos ativos. Iniciar pela interface principal e observar a janela completa de 3–5 minutos. Marcar chegada ou avanço de waypoint, início e fim de combate, parada, `stuck`, retomada e retorno ao primeiro waypoint. Para parada prolongada, registrar duração, tipo de waypoint e ocupação observada. Se nenhum combate ocorrer na janela, marcar a retomada como inconclusiva.

**Entrega e aceite.** Linha do tempo com pelo menos uma volta completa, lista de waypoints cumpridos, tempo parado, contagem de `stuck` por tipo e retomada após cada combate observado. Exigir execução sem intervenção manual, ausência de órbita e `stuck` apenas em `box` ou `safespot` com ocupação confirmada. Consolidação final com F1–F5 aprovadas na mesma sessão e arquivos datados.
