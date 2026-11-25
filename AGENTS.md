# Reconstrução Oficial

- Esta pasta é a única cópia de trabalho oficial. O nome anterior era RE_PKA.
- Trabalhe nesta árvore, não nas versões arquivadas.
- Consulte ../Extracted_Source para contratos originais. Preserve essa referência.
- Preserve ../Shiba_Bots_App: tools/build_app.cjs verifica o ASAR original.
- Preserve local-data, perfis, rotas, fixtures, dumps e evidências referenciadas.
- Use caminhos relativos à raiz do projeto; nomes com espaços e acentos são válidos.
- Não invente telemetria, autenticação nativa nem resultados de testes no jogo.
- Validação geral: node tools/validate.cjs. Testes de UI simulados não comprovam ações no jogo.
- VERIFICACAO_UI_REAL.md registra as limitações da última auditoria real.

---

## 🛡️ Diretrizes Multi-Agente (Coexistência sem Conflito)

Existem três frentes de trabalho ativas. Cada agente opera estritamente dentro
da sua fronteira.

### 1. Frente Bot Próprio (`botfinal/`)
- **Propósito**: motores próprios (walker, combat, healer, lure), árbitro de estado e runtime.
- **Motores**: `botfinal/engines/walker-engine.cjs` (com `pendingStep`/`_reconcile`),
  `combat-engine.cjs`, `healer-engine.cjs`, `dynamic-lure.cjs`.
- **Canal**: atua como **servidor** do Named Pipe `\\.\pipe\pka-runtime-2-<pid>`.
- **Regra**: NUNCA altere arquivos de `research/shiba_tap/` ou `tools/tap_*.cjs`.

### 2. Frente Interface / Clone do Shiba (`reconstruction/app/` e `reconstruction/engines/`)
- **Propósito**: interface principal do projeto, clone da UI do Shiba.
- **Motores próprios** em `reconstruction/engines/` — **diferentes** dos de `botfinal/`.
  Ver "Dois motores de walker" abaixo.
- **Canal**: `reconstruction/native-adapter.cjs` sobre `reconstruction/transport.cjs`.
  Alterna entre teclado e canal nativo por `PKA_CHANNEL_KEY_FILE`.
- **Regra**: preservar os seis tipos de waypoint (`walk`, `safespot`, `box`,
  `stairs`, `wait`, `say`), gravação de rotas e perfis `.lua`.

### 3. Frente Binários Nativos (`native/`)
- `native/pka_native.c`, `pka_native.dll`, `pka_host.exe` — DLL do bot próprio.
- `native/pka_tap.c`, `pka_tap.dll` — sniffer passivo do Shiba (frente 4).
- `tools/build_native.cjs` e `native/pka_inject.exe` são compartilhados e devem
  compilar bot e tap sem que um quebre o outro.

### 4. Frente Shiba Sniffer & Tap (`research/shiba_tap/`)
- **Propósito**: captura passiva e decodificação do protocolo oficial.
- **Regra**: NUNCA altere `botfinal/`, `reconstruction/` ou `native/pka_native.c`.

### 5. Ferramenta de referência (`tools/rota/`)
- Interface alternativa mantida como **referência de comportamento** — foi onde
  as correções de combo, lure e foco foram descobertas primeiro.
- Não é a interface principal. Não portar features novas para cá sem motivo.
- `tools/rota/diagnostico_app.cjs` continua útil para diagnosticar o Electron.

### 6. Regra de Execução no Processo do Jogo (`PokeAlliance_dx.exe`)
- **NÃO injete as duas DLLs juntas no mesmo processo**.
- Testando nosso bot → `pka_native.dll`. Espionando o Shiba → `pka_tap.dll`.

---

## ✅ Respostas validadas (não reverter sem nova medição)

Cada item abaixo foi medido ou provado por captura/teste. Ao mudar qualquer um,
atualize esta seção com a nova evidência.

### Protocolo — validado byte a byte contra captura

`reconstruction/protocol.cjs` é conferido contra vetores capturados do
fornecedor (`protocol_vectors.json`). Alterar formatos de comando quebra o
teste *"independent implementation matches every captured vector"*.

| comando | formato aceito | evidência |
| :--- | :--- | :--- |
| `potion` (12) | **número** 1..65535 (slot). Texto é rejeitado | vetores capturados |
| `revive` (13) | **sempre rejeitado** pelo protocolo | vetores 1273..1304 |
| `talk`/`combo` (6/7) | texto; `attackTargetId`/`expectedUuid` só em `talk` | protocol.cjs:121 |

Tentar abrir `potion`/`revive` para texto quebrou 52 vetores. Não repetir.

### Combo — o interpretador é `exe+0x67fbf0`, não o chat

O consumidor `TEXT_FN_RVA = 0x785050` é o **chat genérico**. Ele NÃO interpreta
comandos. Mandar `!autocombo` por ali apenas fala no chat — sintoma: "usa só a
primeira habilidade".

O interpretador real:

```
0x67fbf0  void interpretador(std::string *msg)     // só rcx
    +0x72  cmp r8, 10        ; EXIGE len == 10
    +0x76  jne sair          ; qualquer sufixo é descartado
    +0x7b  lea rdx, "!autocombo"
    +0x82  call strncmp
    +0x87  jne sair
```

Consequências:
- Mandar **exatamente** `"!autocombo"` (10 bytes), sem sequência.
- A sequência de skills vem da config do runtime (`combo.sequenceText`).
- Quem chama de verdade é `0x4439b4`, chamado pelo handler de chat.

### Attack — recusa silenciosa em `[rt+0x2548]`

`exe+0x784be0` compara a criatura recebida contra dois slots:

```
+0x81  mov rax,[rdi]            ; criatura pedida
+0x84  cmp rax,rdx              ; rdx = [rt+0x2528] = LocalPlayer
+0x87  je   sair
+0x96  cmp rax,[rbx+0x2548]     ; ALVO ATUAL DO JOGO
+0x9d  jne  ataca
```

Medido com 4 ataques a 1 tile: `rc == 4` = **recusado** (era o alvo atual);
`rc == 11/13` = atacou e o HP caiu. No mesmo teste o HP foi
`100 → 79 → 56 → 8 → 4`.

Portanto:
- `status 0` do ACK significa "comando entregue", **nunca** "acertou".
- Único critério de efeito é o HP do alvo cair.
- Consumidores devem tentar outro alvo quando não houver dano.

### Foco — `hotkey`/`potion` funcionam em segundo plano

`tap_key_with_mods` usa `PostMessageA`, que entrega sem foco. O gate
`require_foreground()` fazia `potion` e `revive` devolverem sempre `status 5`
com o jogo atrás — inutilizando o autoRevive do Shiba (`autoRevive.hotkey: "f"`).

Correto: postar primeiro; `PKA_EXECUTOR_MODE=background` continua sendo recusa
**explícita** para auditoria.

Medido de novo em 2026-11-20 com o jogo **minimizado** e outra janela em
primeiro plano: `PostMessageA` move o personagem (3 de 3 passos), `attack`
executa (handler rc=11) e `combo` entrega o texto (status 0). O gate de foco
para `walk` e para o fallback de chat foi removido — foco deixou de ser
pré-requisito. `PKA_EXECUTOR_MODE=background` continua recusando por desenho.

### Perfect lure — os campos são de `target`, não de `hoenn`

`botfinal/engines/dynamic-lure.cjs` lia `config.luring` (topo), mas a config
real aninha em `target.luring`/`target.combo`. Resultado: `enabled: false`
sempre, e o lure nunca ligava.

| conceito | campo correto | valor real |
| :--- | :--- | :--- |
| min count | `target.monsters[].minCount` / `hoenn.minWildsToEngage` | 8 |
| range (raio do lure) | `target.combo.perfectingLureRange` | **3** |
| HP de emergência | `target.combo.perfectingLureHpPercent` | 30 |
| timeout | `hoenn.perfectLureTimeoutMs` | 10000 |

`hoenn.bestTileRange` (4) é raio para escolher a **melhor tile** — outro
conceito. Usá-lo no lure fazia esperar 4 tiles quando o configurado era 3.

### Telemetria — `runtimeReady` sozinho não basta

Dois falsos positivos medidos no mesmo cliente:

| estado | `runtimeReady` | `position` | quem detecta |
| :--- | :--- | :--- | :--- |
| no menu | `false` | válida (vtable-scan) | só o gate |
| em transição | **`true`** | `(0,0,0)` ou `(65535,65535,255)` | só a posição |

Regra: exigir **os dois**. Sentinelas `(0,0,0)` e `(65535,65535,255)` não são
coordenadas.

`refresh_creature_stats` atualiza `g_creatures[]`; deve espelhar em
`g_ownSummon` no mesmo laço — o Pokémon executa o golpe e ficava com até 8 s
de defasagem (medido 26 tiles de erro).

### Hook — thread dedicada e persistente

O hook `WH_CALLWNDPROC` na thread da sessão do pipe morria a cada conexão
(medido: 80 TIDs distintos, 72 reinstalações de órfão). Correção: thread
própria em `GetMessage`/`DispatchMessage`, encerrada por
`PostThreadMessageW(WM_QUIT)` no shutdown.

### Electron — `ELECTRON_RUN_AS_NODE` quebra a janela

Com essa variável o `electron.exe` roda como Node puro e morre com
*"Cannot find module 'electron'"*. É herdada de T3 Code / Codex / VS Code.

- Sempre abrir por `ABRIR_RECONSTRUCAO.bat` (limpa a variável).
- `node tools/diagnostico_app.cjs` diz qual é o bloqueio, sem abrir janela.
- `ABRIR_RECONSTRUCAO_LIMPAR.bat` limpa só o cache do Chromium.
- `0x80000003` (`STATUS_BREAKPOINT`) = `CHECK()` do Chromium na inicialização:
  perfil corrompido, GPU incompatível ou sessão sem desktop.

### Dual interface — preservar as duas

`reconstruction/app` é a interface principal. `tools/rota` é referência.
Não apagar nenhuma das duas; não duplicar features sem decisão explícita.

---

## ⚠️ Dois motores de walker (armadilha)

```
botfinal/engines/walker-engine.cjs        ~13 KB  → pendingStep + _reconcile
reconstruction/engines/walker-engine.cjs  ~25 KB  → o clone usa ESTE
```

`~6 KB` era o tamanho do motor do clone em outubro/2026; ele cresceu com
reconciliação por tick, piso de cadência, guarda de órbita, chegada tolerada
para `box`/`safespot` (`arrived-adjacent`, 2026-11-18) e **pathfinding A\***
sobre o mapa OTMM (`reconstruction/pathfinder.cjs`, ligado por
`EngineRuntime.mapProvider`). Sem mapa o passo volta a ser guloso e a guarda de
órbita mede distância em reta; com mapa, mede custo de caminho. Conferir o
arquivo, não o número lembrado.

`reconstruction/automation.cjs:4` importa `./engines/walker-engine.cjs`. Um
teste em `botfinal/tests` **não** prova nada sobre o clone. Validar sempre pelo
ponto de entrada do clone:

```
node tools/smoke_app.cjs
node tools/ui_audit.cjs
```

## ✅ Resolvido — amostras atrasadas e fora de ordem

A guarda antiga comparava `telemetry.tick === state.lastMoveTick` (IGUALDADE) e
barrava só a amostra repetida. Medido em 2026-11-14 com o motor do clone:

| caso | antes | agora |
| :--- | :--- | :--- |
| amostra repetida (10,10,10) | 1 ✅ | 1 ✅ |
| amostra atrasada (10, 9, 9) | 2 ❌ | 1 ✅ |
| fora de ordem (10, 12, 11) | 3 ❌ | 1 ✅ |
| sem `tick` (undefined ×3) | 3 ❌ | 3 ✅ (por desenho, ver abaixo) |

A regra agora é de ORDEM, não de igualdade: só amostra com tick
**estritamente maior** que o do despacho confirma ou nega o passo
(`reconcile`, `reconstruction/engines/walker-engine.cjs`). Complementos, todos
cobertos por `tests/walker_sample_ordering.test.cjs`:

- queda de tick ≥ `TICK_RESET_MIN` (1000) = telemetria reiniciou: o pendente é
  descartado na hora em vez de a rota andar no ritmo do prazo;
- `playerId` divergente = entidade trocada (respawn/reconexão): aborta;
- aborto (andar, entidade, deslocamento) **despacha o passo recalculado no
  mesmo tick**, em vez de gastar um tick parado;
- sem `tick` não há ordem para comparar, e os dois chamadores reais já deduzem
  amostra repetida (`walker-input-runtime` descarta `generatedAt` igual;
  `automation` exige `tick`), então ali vale 1 passo por amostra com o
  travamento detectado por tentativas (`STUCK_LIMIT`/`STALL_LIMIT`).

Tudo acima é simulação. O intervalo entre passos e a fluidez no jogo com
telemetria real continuam sem medição — ver "Fronteiras de evidência".

---

## ✅ Fechado em 2026-11-16 — combate e lure

Quatro lacunas do combate foram fechadas, cada uma com teste que **discrimina**
(provado por mutação: reverter a correção faz o teste falhar).

| regra | onde | evidência |
| :--- | :--- | :--- |
| Revive timeout = `hoenn.pokeReadyTimeoutMs` (3000) | `rpm-combat-runtime.cjs:567` | evento `Revive sem confirmação em 3 s` × 4.431 |
| Best Tile com teto `bestTileMaxWaitMs` (2500) | `target-engine.cjs` `BEST_TILE_*` | evento `Best Tile: limite de ajuste atingido` × 20.706 |
| Pokémon ausente no combo → pausa e retoma o MESMO índice | `target-engine.cjs` | evento × 267.265 |
| Walker retoma no tick seguinte após a lure segurar | `automation.cjs` `notifySkipped()` | 568 transições `Dynamic↔Walker` |

### O diagnóstico do T4 estava errado — e a correção certa era outra

Eu propus criar um campo `holdMovement` para "deixar a lure rodar em paralelo
ao walker". **A política estava certa**: `holding` e `holding-front` devem
segurar o walker mesmo — o nome diz isso.

O bug real era a **retomada**: quando o `automation` segurava o walker, o passo
pendente sobrevivia e o primeiro tick seguinte devolvia
`hold: await-position-sample` por até 2,5 s. Correção: `walker.notifySkipped()`
no ponto em que o `automation` decide não rodar o walker — mesma solução que
`RPM skipWalker` já aplicava no caminho do combate.

Lição registrada: antes de inventar campo novo, verificar se o problema é
política (o quê fazer) ou ciclo de vida (o que sobrevive entre ticks).

---

## ✅ Medido em 2026-11-21 — leitura externa e antiban

Conta nova, um cliente, personagem parado; nada de scan quando o teste diz
"cadeia". Resultado (o ban aparece no título da janela, ~minutos depois):

| exposição | tempo | resultado |
| :--- | :--- | :--- |
| nada rodando | 15 min | safe |
| handle aberto, **0 leitura** | 10 min | safe |
| 4 bytes na base do módulo @ 0,2 Hz | 10 min | safe |
| cadeia + nome + pos + hp @ 0,2 Hz | 15 min | safe |
| 2 passos por `PostMessageW` + cadeia @ 0,2 Hz | 10 min | safe |
| runtime completo em `telemetry.mode:'chain'` (leitura 2 s + passo) | 12 s + 1 tile real | safe |
| posição a 300 ms (3,3 Hz) | 10 min | **ban** |
| varredura de toda a memória (105 MB) | minutos | **ban** |
| crawl de containers 1×/s | 3,5 min | **ban** |

Regra prática: **o gatilho é a varredura**, não o `ReadProcessMemory` em si.
Telemetria por cadeia de ponteiros em taxa baixa (≤ 0,5 Hz) sobrevive; qualquer
varredura de espaço de endereço tomba a conta.

Cadeia por build (o RVA muda a cada build — reescanear quando atualizar):

```
build 21/11 (sha 0ec61b0e...): rva 0x39F8E08 -> player direto (ponteiro em .data)
build 22/11 (sha 14cad596...): rva 0x3A03598 (+0x3A035A0 alias) -> player direto
layout: pos 0x20 | id 0x4C | name 0x70 | hp 0xB0 | canAttack 0xB4 | type 0x176
```

Descoberta do build 22/11: varredura SÓ de `.data`/`.rdata` (4 MB) no PID 28604,
validada por nome/pos/id e por passo real (`PostMessageW` moveu x 2970→2971).
O launcher do PokeAlliance reescreve `PokeAlliance_dx.exe` a cada abertura e
apaga backups; rollback para build antigo não é estável — o perfil por hash é
o caminho.

`name` em 0x70 é `std::string`: nomes ≤ 15 bytes ficam inline (SSO); maiores
guardam ponteiro em +0x0 e tamanho em +0x8. `pka_live_session._resolve_name_field`
trata os dois casos.

### Custo de leitura (build 23/11) — reduzir RPM, não só a taxa

Varredura de descoberta custa as seções inteiras (`.rdata` 8,2 MB + `.data`
23,7 MB). Fazer UMA vez por build e cachear:

- `tools/creature_chain_discover.py` grava `local-data/creature-chain.json`
  com `sha`, `rva` e `candidatos`. Na próxima execução com o mesmo sha ele
  reaproveita os candidatos e **não varre nada**; `--fresh` força.
  Há guarda de 30 min contra varredura repetida (`chain-scan-guard.json`).
- `tools/chain_sampler.py` lê **um bloco de 0x180 por entidade** (pos, id,
  name SSO/ponteiro, hp, canAttack, type) e o player no mesmo esquema:
  1 leitura por amostra em vez de ~6. Intervalo padrão 5 s.
- Cadeia de criaturas do build 23/11: `0x39FB498` (vector begin/end/cap).
  O vetor tem slots vazios/fantasmas; estabilidade entre amostras é o critério.
- HP de criatura em +0xB0 é **byte** (uint8 0..100); ler 4 bytes devolve lixo
  (ex.: 16711780). `healthPercent` só é publicado quando o byte ≤ 100.

O Shiba é **100% externo**: com o walker ativo o cliente mantém 98 módulos (todos
do jogo/sistema) e 73 threads todas dentro de módulos; nenhum PE ou thread
injetada. Os pipes `pka-*` só existem enquanto o Shiba roda, e o jogo **não**
conecta neles (servidor nosso no ar desde antes do login, zero `connect`).

---

## Fronteiras de evidência

Sustentado por captura ou medição:

- vocabulário do `kind 11` (`start`/`stop`/`monitor`/`togglePause`), com
  `hoenn` apenas em `stop`
- combo pelo interpretador `0x67fbf0` (len 10, literal exato)
- recusa de attack em `[rt+0x2548]` (`rc == 4`)
- fases e durações do Dynamic Lure (travel 3672 ms, arc 32 ms, stationary
  234 ms, wait 1406 ms) a partir de 6.616 frames de captura
- `potion` numérico / `revive` rejeitado no protocolo

**Não** sustentado por evidência (não afirmar como equivalente ao Shiba):

- distância mantida entre Pokémon e monstro — **e não há como obter por captura
  passiva**: o `kind5` do fornecedor esconde `type 1` de propósito. Confirmado
  em 2026-11-16 com ele caçando (`lure.count: 6/8`) e ainda assim 0 selvagens em
  554 frames. O payload está completo (publica 203 `tiles` e 271 `items` no
  mesmo frame) — ele simplesmente omite a criatura. Ver `RACIOCINIO.md` H3.
- box medida em tiles (só o count textual, ex. "8/9 monstros na área")
- movimento do Pokémon durante a lure
- fluidez de caminhada no jogo e tempo entre passos com telemetria real
- contorno de paredes / navegação por pathfinding
- parada física durante a lure — `analysis/lure-stop-rule/RELATORIO-VALIDACAO.md`
  registra ausência de vídeo sincronizado
- qualquer comportamento observado apenas em simulação
