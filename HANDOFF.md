# HANDOFF — estado do projeto e próxima tarefa

Documento único para um agente novo começar sem explorar o repositório.
Leia só este arquivo. Ele aponta o resto por caminho, não por cópia.

Data: 2026-11-16.

> **2026-11-19 — cliente atualizado pelo launcher, RVAs de `.data` re-derivados.**
> O exe mudou (34.287.664 bytes, mtime 19/11 14:35:34) e todos os RVAs de
> `.data` da DLL caíram: `runtimeReady` falso, posição sentinela, `attack`
> recusado com `targetId=0`. Antes de culpar o motor, confira
> `(Get-Item native\pka_native.dll).LastWriteTime` contra o `StartTime` do
> processo e um `live-preflight.cjs --verify`.
> Corrigido em `native/pka_native.c` (RUNTIME `0x39F68E0`, global do
> LocalPlayer `0x39F8E08`, TEXT_CTX/GATE/REENTRY `0x39F8E48/0x39F8F48/0x39F8F4A`,
> vtable do player `0x1FDB2A8`). Build e preflight verdes em 19/11; evidência e
> método em `docs/MISSOES/vereditos/00-sessao-2026-11-19.md`.
 > Sem foco: em 20/11 o jogo minimizado andou 3/3 passos, attack rc=11 e combo
 > status 0 por PostMessage — gate de foco removido de `walk` e do chat.
>
> Achados abertos: walker encerra `walk` a 1 tile (`arrived-within-one-tile`) e o
> `live_walk_channel` aprova assim; `recallPokemon` é recusado (`status 1`);
> o pulso publica `"roster":[]`, `"items":[]` e `"tiles":[]` fixos.


---

## 1. Onde você trabalha

```
C:\Users\yago\Documents\Clone\RECONSTRUÇAO OFIcial
```

Grafia exata: `RECONSTRUÇAO` (Ç + AO, sem til) e `OFIcial` (C maiúsculo no meio).
Errar isso faz `cd` falhar.

A sessão pode abrir em outro diretório (ex.: `C:\Users\yago\SHIBA CLONE10`).
Trate sempre a raiz acima como o projeto.

---

## 2. O que é o projeto

Reconstrução do bot **PokeAlliance**. O bot fala com o cliente do jogo por
Named Pipe (`\\.\pipe\pka-runtime-2-<pid>`).

Duas interfaces coexistem:

| caminho | papel |
| :--- | :--- |
| `reconstruction/app/` | **interface principal** (clone da UI do Shiba) |
| `tools/rota/` | referência de comportamento — **não portar features** |

Três frentes de código que **não se misturam**:

| caminho | dono | pode editar? |
| :--- | :--- | :--- |
| `reconstruction/engines/` e `reconstruction/*.cjs` | clone | **sim, é aqui** |
| `botfinal/engines/` e `botfinal/core/` | outra frente | **não** |
| `native/*.c` | DLL em C | só se a tarefa pedir |

### Armadilha dos dois walker-engine

```
reconstruction/engines/walker-engine.cjs   ~25 KB  ← o clone usa ESTE
botfinal/engines/walker-engine.cjs         ~13 KB  ← outra frente
```

Os tamanhos citados antes (6 KB no clone) estavam defasados: o motor do clone
recebeu reconciliacao por tick, piso de cadencia, guarda de orbita e, em
2026-11-18, tolerancia de chegada para `box`/`safespot`. Sempre conferir o
arquivo, nao a lembranca.

`reconstruction/automation.cjs:4` importa `./engines/walker-engine.cjs`.
Um teste em `botfinal/tests` **não prova nada** sobre o clone.

Validação do clone é pelo ponto de entrada:

```
node tools/smoke_app.cjs
node tools/ui_audit.cjs
```

---

## 3. Estado atual (medido agora)

`validation.json`, gerado em 2026-11-18 (`node tools/validate.cjs`):

```
  build    exit 0
  node     959 testes, 951 pass, 0 fail, 8 skip
  electron 959 testes, 959 pass, 0 fail
  smoke    exit 0
  audit    exit 0
  success  true
```

Tudo verde. **Não quebre isso.**

### O que estava quebrado e foi corrigido em 2026-11-18

O número de testes subiu de 878 para 959 (novos casos de contrato e de walker).
A suíte estava vermelha e o `validation.json` velho escondia isso — três causas,
todas fora do motor em si:

1. `reconstruction/transport.cjs` passou a consumir kind 6 em `emit('automation')`
   e a retornar antes de `emit('frame')`. `botfinal/core/pipe-transport.cjs`
   depende de `'frame'` para aprender o `boot` da sessão → 3 testes de
   `botfinal/tests/automation_native_loop.test.cjs` falhavam. Correção: todo
   frame continua emitindo `'frame'`, inclusive os que ganharam evento dedicado.
2. `reconstruction/local-runtime.cjs` não declarava `action`, mas o Healer
   **exige** `action` por default (`hoenn.potionHpPercent: 60` +
   `potionActionBar: 3`). O start do Healer era recusado por capacidade e a
   auditoria da UI falhava em `healer.healCommand`/`healer.switchConfirm` sem
   emitir comando. Correção: `action` entrou em `SIMULATED_COMMANDS` (aceito,
   não modelado).
3. `native/pka_native.c` lia `name` como buffer inline, mas o campo é
   `std::string` do MSVC. Nome com 16+ bytes sai do SSO e vira ponteiro; todos
   os layouts eram reprovados e a DLL aceitava falso positivo, publicando
   `(0,0,0)` e HP 0 **com `runtimeReady: true`**. Correção: `read_name_from`
   trata SSO e heap. **Segundo caso medido ao vivo (PID 9500, mesmo build):**
   `size=0` e texto terminado em NUL no ponteiro — exigir `size>0` reprovava o
   jogador válido. `size` passou a ser opcional; `cap` limita a leitura.
   O probe `tools/live_probe.py` tinha 3 defeitos próprios corrigidos no mesmo
   dia: ordem de vtable (usava o RVA de build antigo), nome inline em vez de
   ponteiro e campo `stable` ausente na resposta de `sample`.
4. `box`/`safespot` exigiam o tile exato e orbitavam quando uma criatura estava
   em cima do waypoint (medido: 300 comandos, `stuck` nunca). Correção em duas
   partes: guarda de progresso (`ORBIT_SAMPLES`, encerra a órbita) e chegada
   tolerada no vizinho quando o tile está ocupado por criatura viva
   (`arrived-adjacent`). Teste discriminante: sem a regra, 4 casos falham.
5. O gate aceitava posição sentinela: `(0,0,0)` e `(65535,65535,255)` são
   inteiros e passavam em `no-position`. Agora `realPosition` recusa as duas
   (`shared.cjs`, `automation.cjs`), com teste. Ver
   `docs/PROTOCOLO_VALIDACAO.md` para a validação no cliente.
6. O walker não contornava parede: era guloso com `clockwise`. Agora há
   planejador A* sobre o mapa OTMM (`reconstruction/pathfinder.cjs`), ligado
   pelo `EngineRuntime.mapProvider` (mapa da aba). A guarda de órbita passou a
   medir **custo de caminho**, não distância em reta; sem mapa, o passo volta a
   ser guloso. `tests/walker_pathfinder.test.cjs` cobre desvio, quina, bloco
   desconhecido, alvo bloqueado e parede longa.
7. Item do Healer: `potion` usa hotkey quando existe e cai no **`potion`
   numérico** (slot) quando não há — a DLL executa potion, não `action`.
   Medicine não tem equivalente numérico: `useMedicine: true` sem hotkey agora
   **exige `hotkey` no start** (`capabilities.cjs`), em vez de iniciar e travar
   em `medicine-channel-missing` a cada tick.
8. Consumíveis das Tools (4 slots) passaram a rodar: `consumables-engine.cjs`,
   um `hotkey` por tick, imediato ao ativar, repetindo em 10/20/30 s e depois
   no intervalo configurado. Slot ligado exige `hotkey` no start. Ainda sem
   motor: Hoenn, Safe Logout, Instância e `guildDaily` (o IPC continua stub).
9. Escada direcional: `stairs` agora usa `param` (`north/east/south/west`) para
   UM passo de saída antes de esperar o `z`; vazio continua "só pisar no tile".
   Antes o `param` era ignorado e a escada terminava em `stairs-timeout`.
   `tests/walker_stairs_direction.test.cjs` cobre.

A execução de 2026-11-16T17:42:51Z também tinha 2 EPERM de symlink. O que sobrou
disso, para não ser redescoberto:

- Os EPERM **não** eram bug de produto: só aparecem com `TEMP`/`TMP` dentro do
  sandbox do Codex (`...\Packages\openai.codex_2p2nqsd0c76g0\AC\#!sandbox.<guid>\Temp`),
  onde `CreateSymbolicLinkW` é negado. O teste agora tenta o symlink e, se vier
  `EPERM`/`EACCES`/`EINVAL`/`ENOTSUP`, **pula** com o código na mensagem — as
  asserções seguem valendo onde há symlink. Prova do caminho de skip:
  `node --test --require <shim que lança EPERM> tests/settings.test.cjs` dá 0
  fail e 2 skip.
- `smoke`/`audit` passam isolados, em sequência e 3x seguidas (~2 s cada, contra
  timeout de 35 s), e passaram dentro do validate. A falha registrada foi
  transitória. Se voltar: `reconstruction/app/main.cjs:30` fixa `userData` em
  `local-data/electron`, então duas instâncias Electron ao mesmo tempo disputam o
  mesmo perfil — feche a interface antes de rodar a suíte.
- `audit` é consequência de `smoke`: `ui_audit.cjs:30` falha com
  `relatorio ausente` quando o app não chega a escrever `app-audit.json`.
  Confirmado por código e por os dois passarem/ falharem juntos.

`git status` tem ~300 arquivos sujos (trabalho não commitado, esperado).

---

## 4. O que já foi feito (não refazer)

| item | onde | prova |
| :--- | :--- | :--- |
| Combo vai pelo interpretador `exe+0x67fbf0`, literal `"!autocombo"` | `native/pka_native.c` | `cmp r8,10` no prólogo |
| `potion` é número (slot); `revive` é rejeitado pelo protocolo | `reconstruction/protocol.cjs` | vetores capturados 1273..1304 |
| `hotkey`/`potion` funcionam sem foco; `walk` exige foco | `native/pka_native.c` | medido 2026-11-13 |
| Combo por Pokémon (lê `roster[slot].moves`) | `target-engine.cjs` `sequence()` | Diglett tem 6 moves, Squirtle 7 |
| PokeStop: 4 tentativas, depois segue | `target-engine.cjs` `POKESTOP_ATTEMPTS` | +2 testes |
| Best Tile com teto de 2500 ms | `target-engine.cjs` `BEST_TILE_*` | +2 testes |
| Revive timeout = `hoenn.pokeReadyTimeoutMs` (3000) | `rpm-combat-runtime.cjs:567` | +1 teste |
| Pokémon ausente no meio do combo: espera e retoma do mesmo índice | `target-engine.cjs:580` `await-pokemon-recovery` | +2 testes |
| **T4** lure-hold: `walker.notifySkipped()` na retenção | `automation.cjs:228` | +1 teste, falha sem a chamada |
| Amostras atrasadas/fora de ordem | `walker-engine.cjs` `reconcile()` | 4 casos medidos |
| Hook em thread persistente | `native/pka_native.c` `hook_thread_proc` | 80 TIDs → 1 thread |


### Fronteira de evidência

Sustentado por captura/medição do Shiba (351,8 MB, `native/pka_tap_572.jsonl`):

- ordem das fases: **Best Tile → PokeStop → Perfect lure → AutoCombo**
- durações: Perfect lure 2,4 s · AutoCombo 1,3 s · Best Tile 750 ms · PokeStop 1,375 s
- cadência de passo: **406 ms/tile**
- HP emergência da lure: 30%
- `finishRemainingCount`: 2

**NÃO** sustentado — não afirme como equivalente:

- distância entre Pokémon e monstro
- box medida em tiles
- movimento do Pokémon durante a lure
- fluidez de caminhada e pathfinding
- parada física na lure

Motivo: a captura tem **zero frames com selvagem** (`kind5` só traz type 0 e 3).

---

## 5. T4 — implementado (não refazer)

Histórico completo em `RACIOCINIO.md`, seção **H1**. Resumo do que foi decidido,
porque a premissa do brief antigo estava errada:

`reconstruction/engines/lure-engine.cjs` modela três modos num motor só:

| modo | campo da config | intenção |
| :--- | :--- | :--- |
| `distance` | `luring.enabled` | treinador **para** e espera o Pokémon |
| `dynamic` | `luring.frontEnabled` | Pokémon vai à frente |
| `random` | `luring.randomEnabled` | alterna andar/esperar |

Todos devolvem `allowMovement`, e `reconstruction/automation.cjs:226` usa esse
único booleano para decidir se o walker roda.

**A política está certa.** O defeito era a **retomada**: segurar o walker sem
avisar mantinha o passo pendente vivo, e o primeiro tick após o hold devolvia
`hold: await-position-sample` por até 2,5 s — mesma classe de bug que
`notifySkipped()` já resolvia no caminho do combate.

**Correção** (`automation.cjs:228`), sem campo novo:

```js
else {
  walker.notifySkipped();
  walk = { action: 'held', emitted: [], reason: 'lure-hold' };
}
```

**Prova:** `tests/engines.test.cjs`, *"automation resumes walking on the first
tick after a distance lure hold"*. Sem a chamada: `expected 'move'`, `actual
'hold'`, reason `await-position-sample`. Com ela: passa. Reproduzido em
simulação; **não** verificado no jogo.

**Não existe campo `holdMovement`.** O brief antigo mandava criá-lo; a premissa
foi descartada. Não procure por esse nome.

`huntStep()` não consulta o lure, então o caminho `hunt` nunca teve a trava e
segue como referência de comportamento correto.

---

## 5b. A próxima tarefa: o que ainda não é equivalente

Não há tarefa de código aberta por brief. O que resta é fechar lacuna de
evidência — e o que resta **não** se resolve lendo código:

1. **H2 — Best Tile aproximado.** A fórmula de score do Shiba continua sem
   ranking (`spec/remaining-rules-v1.json`, `blockedBy`; constante 4000 em
   `0x933b2`). O clone usa `chebyshev(boxCenter, creature.pos) <=
   hoenn.bestTileRange`. É conservador, não é fiel. Se `0x933b2` for alcançável,
   extraia o score; se não, registre a limitação e siga.
2. **H3 — `kind5` sem selvagem.** A captura tem zero frames com monstro. Ou o
   Shiba esconde as criaturas durante a lure, ou o tap perdeu os frames. Se for
   (a), nenhuma captura passiva dará a geometria: só vídeo ou leitura direta de
   memória no processo dele.
3. **Captura nova com monstros na tela** fecha de uma vez: distância
   Pokémon↔monstro, box em tiles, movimento do Pokémon na lure, fluidez de
   caminhada.

```
ARQUIVO DE EVIDÊNCIA: analysis/COMBATE_SHIBA_MAQUINA.md
                       analysis/COMBATE_SHIBA_EVENTOS.md
VERIFICAR: node tools/validate.cjs  (uma vez, no fim)
```


---

## 6. Regras de execução (obrigatórias)

Estas regras existem porque um agente anterior estourou 65.828 de 65.536
tokens lendo 8 fontes completas antes de escrever a primeira linha.

1. **Um entregável por sessão.** Não agregue tarefas.
2. **Não releia um arquivo já lido** nesta sessão.
3. **Leia código com `offset`/`limit`** — no máximo 80 linhas por leitura.
4. **Não abra `native/pka_tap_572.jsonl`** (351,8 MB). Tudo que ele provou
   está resumido aqui e em `analysis/COMBATE_SHIBA_MAQUINA.md`.
5. **Confirme o ponto de inserção por grep**, não por número de linha do brief.
   Outro agente pode ter editado o arquivo entre a medição e a edição.
6. **Verifique com `node --test <arquivo>`**. Rode `validate.cjs` só no fim.
7. **Não commite** nada sem pedido explícito.
8. **Não invente resultado de teste.** Se não rodou, diga que não rodou.

### Sobre concorrência

Outro agente pode estar editando os mesmos arquivos. Antes de editar:

```
Get-Item <arquivo> | Select-Object LastWriteTime
```

Se o `LastWriteTime` for de minutos atrás, confirme que o outro terminou.
Hoje houve um caso de arquivo alterado 22 s antes de eu olhar.

### Prova de que um teste discrimina

Quando escrever um teste, considere fazer mutação: reverta a correção, rode o
teste, confirme que ele **falha**, restaure. Um teste que passa com e sem a
correção não prova nada. Dois agentes já fizeram isso neste projeto e vale.

---

## 7. Ferramentas de diagnóstico

```
node tools/validate.cjs              suite completa (build, node, electron, smoke, audit)
node tools/smoke_app.cjs             UI sobre simulação local
node tools/ui_audit.cjs              auditoria da interface (12 checks)
node tools/diagnostico_app.cjs       ambiente do Electron (só leitura)
node tools/analise_combate_shiba.cjs fases e distâncias da captura do Shiba
```

### Armadilha do Electron

`ELECTRON_RUN_AS_NODE=1` no ambiente faz o `electron.exe` rodar como Node puro
e morrer com *"Cannot find module 'electron'"*. Herdado de T3 Code / Codex.

- Sempre abrir por `ABRIR_RECONSTRUCAO.bat` (limpa a variável)
- `0x80000003` = `CHECK()` do Chromium: perfil corrompido, GPU ou sessão sem desktop

---

## 8. Documentos de apoio (leia sob demanda)

| arquivo | o que tem |
| :--- | :--- |
| `AGENTS.md` | fronteiras do repositório, respostas validadas |
| `RACIOCINIO.md` | hipóteses abertas (H1 resolvido, H2/H3 pendentes), regras de raciocínio |
| `analysis/COMBATE_SHIBA_MAQUINA.md` | máquina de estados e tempos medidos |
| `analysis/COMBATE_SHIBA_EVENTOS.md` | os 8 eventos do Shiba com contagem |
| `reconstruction/spec/remaining-rules-v1.json` | regras com `blockedBy` (BestTileScore) |

---

## 9. Primeira ação

Cole isto no chat novo:

```
Leia HANDOFF.md na raiz do projeto. A suíte está verde e o T4 já está feito
(seção 5) — não refaça nenhum dos dois.
Execute a tarefa da seção 5b: fechar lacuna de evidência (H2 Best Tile, H3
kind5, captura nova com monstros na tela).
Siga as regras de execução da seção 6. Preserve as asserções dos testes.
```

Abra `RACIOCINIO.md` antes: H1 está resolvido e H2/H3 são o que sobrou. A
implementação atual de Best Tile é aproximada de propósito.

