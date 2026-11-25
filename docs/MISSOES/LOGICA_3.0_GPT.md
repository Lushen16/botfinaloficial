# PokeBOT 3.0 — projeto sem injeção

**Decisão:** no cliente público, manter o jogador no controle e usar apenas ações oferecidas pela interface e permitidas pelo operador. Desenvolver o executor automático em simulador local ou QA expressamente autorizado. Não usar contas descartáveis para testar evasão de sanções nem adaptar entrada ou cadência para contornar o anti-cheat. Sem DLL é requisito de arquitetura, não garantia contra banimento.

## 1. Evidência e limites

- **Incidente reportado:** cinco contas banidas desde o início do uso do bot próprio. A última caiu cerca de 12 s após iniciar scanner de memória + `PostMessage`, sem DLL. A mesma conta havia passado aproximadamente 11 min em jogo manual e mais de 10 min com Shiba v3.3.8 sem banimento observado nesses intervalos. Isso não isola entrada, scanner, trajetória, histórico da conta ou atraso da sanção. Essas janelas não demonstram segurança.
- **Topologia reportada:** 84 módulos e nenhum PE manual-mapped identificado no cliente observado; Shiba externo em Electron (~245 MB), iniciado como `RANDOM.exe.tmp` com `--client-pid=<pid>`. Pela medição fornecida, os pipes `pka-runtime-2-<pid>` e `pka-security-<pid>` são criados pelo Shiba, somem ao fechá-lo e não existem com o jogo sozinho. Isso contradiz a atribuição ao jogo em `docs/SHIBA_WALKER_MEDIDO.md`. Não tratar esses pipes como API do cliente nem inferir o mecanismo de entrada do Shiba.
- **Movimento observado:** `local-data/shiba-walker-sample-2026-11-20.json`, 400 amostras a 100 ms; mediana 302 ms, p90 603 ms, 22% de diagonais e 23 de 99 intervalos acima de 600 ms. O relato descreve contorno de obstáculos e curvas suaves. A série mede posições, não eventos de entrada: não distingue clique de tecla nem explica os intervalos longos. Não usar esses valores como metas de cadência.
- **Divergência do checkout:** `tools/combat_actuator.py`, em `dispatch()`, aceita `key`, `attack`, `click` e `useWith`; o resultado declara `PostMessageW`, `effectVerified: False` e `retrySafe: False`. Não encontrei `sendInput:true`, `keybd_event` ou `mouse_event` nesse arquivo. Mesmo que outra cópia tenha a opção, `keybd_event` e `mouse_event` sintetizam eventos: não são entrada física.
- **Referências:** manter `../Extracted_Source` intacto; seu `package.json` declara 3.1.9, não 3.3.8. `PokeBOT 3.0/README.md` não foi encontrado nesta árvore. Quando existir, deve apontar para este projeto e distinguir modo assistido de QA, sem prometer paridade com o Shiba.

## 2. Arquitetura sem injeção

Separar observação, decisão, execução e confirmação. No modo assistido, usar rota e informações observáveis pelo jogador, quando permitido; a saída é uma indicação, nunca um clique ou tecla automatizada. Em QA, alimentar o motor com fixtures ou observações da interface autorizada; somente o adaptador de simulador/QA executa intents. O perfil público não carrega o adaptador. Scanner de memória, DLL, pipes privados e `PostMessage` não são fallback.

| Ação | Operação manual, quando permitida | Confirmação em simulador / QA |
| --- | --- | --- |
| Mover | Jogador clica no tile se a UI oferecer autowalk ou usa as teclas da interface. | Comparar destino único com passos explícitos; confirmar posição e andar. |
| Atacar | Jogador seleciona o alvo e usa botão ou atalho exposto. | Separar seleção e efeito; medir queda de HP com alvo isolado, sem atribuir dano de terceiros ao comando. |
| Curar | Jogador usa consumível ou atalho exposto na UI. | Confirmar efeito no alvo certo e mudança de inventário quando observável; evitar consumo duplicado. |
| Capturar | Jogador usa bola e alvo segundo o fluxo que a UI oferecer. | Aguardar resultado explícito associado à tentativa; ACK, desaparecimento do alvo ou consumo da bola não provam sucesso. |

Skills individuais só entram no escopo se houver controle visível, atalho configurado ou API autorizada. Sem chat e sem controle confirmado, considerar combo indisponível, não recriar o interpretador interno. Foco é proteção contra ação na janela errada, não mitigação demonstrada de banimento.

Em QA, manter uma intenção pendente por vez, ligada à sessão, ao alvo e ao prazo. Cura urgente tem prioridade; captura pendente bloqueia movimento até resultado ou timeout. Se não for possível confirmar cancelamento do autowalk, não emitir ação concorrente: passar o controle ao operador. Pausar ao perder foco, detectar intervenção manual, receber amostra vencida ou ambígua, mudar de sessão ou abrir modal inesperado. Retomar só com observação nova; não repetir ação de efeito incerto.

## 3. Walker e projeção no simulador

- **Planejamento:** `createPathPlanner()` de `reconstruction/pathfinder.cjs` expõe `plan()` e `canStep()`. `plan()` devolve direção e custo restante, não uma lista de destinos de clique. Usar A* e teste de atalho como referência de alcançabilidade em QA, sem extrapolar tile desconhecido ou cortar quina. `reconstruction/engine-runtime.cjs` utiliza `mapProvider`.
- **Contratos distintos:** `reconstruction/automation.cjs` usa `createWalkerEngine()` de `reconstruction/engines/walker-engine.cjs`, não o motor de `botfinal/`. `pendingStep` e `reconcile()` confirmam um passo. Em QA, propor `pendingDestination` para autowalk: tiles intermediários indicam progresso, não chegada ou erro por si só; falta de progresso até o prazo é falha. Usar `notifySkipped()` como referência de ciclo de vida: invalidar a pendência ao perder a vez e reconciliar a posição observada antes de retomar.
- **Tile → pixel no viewport de QA:** obter um centro conhecido `p0` do tile `(x0,y0)` e os vetores em pixels `ux` e `uy` até centros vizinhos. No mesmo andar, `p = p0 + (x − x0)·ux + (y − y0)·uy`. Converter da área renderizada para as coordenadas da superfície de teste, distinguindo pixels da captura de coordenadas lógicas. Rejeitar destino fora do viewport, oclusão, câmera em transição sem compensação ou erro que permita atingir mais de um tile. Invalidar calibração com DPI, zoom, resize, troca de andar ou mudança de layout. Confirmar o tile registrado no simulador, não apenas o pixel enviado.
- **Cadência e diagonais:** autowalk recebe um destino por vez e resolve os passos intermediários. Para passos explícitos, aguardar confirmação fresca antes do próximo e respeitar a cadência do QA. Pausas têm causa registrada: espera da rota, bloqueio, observação indisponível ou arbitragem. Diagonais decorrem de legalidade e custo, sem cortar quinas. Sem cota, jitter ou reprodução das pausas medidas no Shiba.
- **Chegada:** exigir amostra nova, da mesma sessão/entidade e com posição válida; descartar amostras atrasadas e sentinelas `(0,0,0)` e `(65535,65535,255)`. `walk` exige tile exato; `box`/`safespot` aceitam adjacência só nos termos da regra existente; `stairs` exige a transição esperada de andar; `wait` é espera explícita. Preservar `say` no formato de rota, com execução manual. Timeout e entrega de clique não avançam o waypoint.

## 4. A/B funcional — não de banimento

Usar simulador local sem conta ou conta de QA fornecida pelo operador em ambiente autorizado e segregado. Fixar mapa, rota, início, viewport e cenário; alternar ordem A/B e restaurar o estado a cada caso. Registrar observação, intenção, efeito, motivo de pausa, intervenção e prazo. Dado não observável permanece desconhecido.

| Comparação | Braços | Medidas e critérios propostos |
| --- | --- | --- |
| Navegação | A: passos explícitos. B: autowalk nas mesmas rotas. | Medir taxa de chegada, duração mediana/p90, travamentos e intervenções. Exigir ≥38 de 40 rotas navegáveis concluídas por braço e zero destinos errados. Preferir B se reduzir intervenções sem piorar a chegada. |
| Projeção e parada | A: viewport estável. B: variantes de DPI/zoom, borda, modal, perda de foco, troca de andar ou amostras fora de ordem, um fator por caso. | Zero cliques no tile errado, zero novas emissões após observar uma guarda de parada, zero avanços indevidos. Medir separadamente latência para parar de emitir e tempo até cessar deslocamento já iniciado. |
| Ataque, cura e captura | A: alvos e controles válidos. B: alvo ambíguo ou efeito atrasado/indisponível. | Separar entrega, seleção e efeito. Exigir ≥19 confirmações corretas em 20 casos válidos por ação; zero efeitos em alvo errado, duplicidades ou falsos sucessos. Inconclusivo não é sucesso. |

Uma falha crítica reprova o cenário mesmo com boa taxa agregada. Esses limiares são propostas, não resultados. A comparação não estima chance de ban nem comprova equivalência com o Shiba.

## 5. Prioridades e descarte

- **P0 — Restringir a operação:** suspender o stack automático no serviço público. Preservar artefatos do incidente sem reexecutá-los. Não usar `tools/live_new_name_launch.cjs` como entrada do 3.0: copia o executável sob outro nome, procura seu PID em `findPid()` e tem caminho de encerramento forçado de processos. Não integrar `tools/combat_actuator.py` nem `ChannelCaptureRuntime` de `reconstruction/channel-capture.cjs` ao perfil público. Trocar o backend não resolve a falta de autorização.
- **P1 — Validar offline:** separar confirmação de passo, destino e efeito; testar pausa, retomada e projeção com fixtures. Preservar seis tipos de waypoint, rotas e perfis `.lua`. Priorizar falhas por amostra obsoleta, janela incorreta, quina, troca de andar e consumo duplicado.
- **P2 — Avaliar com autorização:** comparar autowalk e teclas pelo resultado funcional; catalogar os controles de UI disponíveis e documentar o contrato no futuro `PokeBOT 3.0/README.md`. Sem autorização, encerrar no modo assistido permitido e no simulador. Descartar renomeação furtiva, imitação de cadência, entrada sintética rotulada como física, dependência de pipes privados e teste de sanção em contas descartáveis.

**Validação desta entrega:** documentação apenas. Nenhum jogo, bot, benchmark ou teste ao vivo foi executado; não há novos resultados de comportamento.
