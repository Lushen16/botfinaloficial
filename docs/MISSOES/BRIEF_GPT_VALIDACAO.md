# Brief GPT/Codex — validação viva do bot (cliente real)

Autossuficiente: quem receber este arquivo **não conhece o histórico**.
Projeto: `C:\Users\yago\Documents\Clone\RECONSTRUÇAO OFIcial` (grafia exata:
`RECONSTRUÇAO` sem til, `OFIcial` com C no meio).
Leia antes de executar: `AGENTS.md`, `HANDOFF.md`, `docs/PROTOCOLO_VALIDACAO.md`,
`docs/MISSOES/README.md`.

Executor deste brief **tem acesso ao jogo**: pode reiniciar
`PokeAlliance_dx.exe`, injetar `native\pka_native.dll`, postar teclas, observar
telemetria e gravar vídeo. É isso que se espera — o que falta no projeto é
**evidência viva**, não mais código especulativo.

---

## 0. Regras que valem para todas as missões

1. **Uma entrega por missão.** Não agregue fases; não avance se a fase anterior
   falhou.
2. **Critério de efeito, nunca de superfície.** `status 0`, ACK, botão
   habilitado, `runtimeReady` e teste verde **não provam jogo**. Só contam:
   - `walk` → delta exato de `position`, mesmo `z`, sem passo extra;
   - `attack` → HP do alvo cai ou ele sai da lista;
   - cura/revive → HP sobe / Pokémon de volta na telemetria;
   - captura → estado do corpo muda.
3. **Nunca injete `pka_native.dll` e `pka_tap.dll` juntas** no mesmo processo:
   brigam pelo pipe. Espionar o Shiba é sessão separada.
4. **DLL nova só entra em processo novo.** Confira
   `(Get-Item native\pka_native.dll).LastWriteTime` **anterior** ao `StartTime`
   do jogo. Se não, reinicie o cliente antes de injetar.
5. **Foco:** `walk` exige primeiro plano; `hotkey`/`potion` funcionam em
   segundo plano (`PostMessageA`). `PKA_EXECUTOR_MODE=background` recusa de
   propósito.
6. **Sentinelas não são coordenadas:** `(0,0,0)` e `(65535,65535,255)`.
   Exija `runtimeReady` **e** posição real.
7. **Evidência em arquivo**, produzida pela ferramenta. stdout não é prova.
   Não invente resultado; se não rodou, escreva que não rodou.
8. **Veredito obrigatório por missão:** `CONFIRMADO` / `FALHOU` /
   `INCONCLUSIVO` / `BLOQUEADO`, com a seção "O que NÃO foi provado".
   `BLOQUEADO` e `INCONCLUSIVO` não são falha do produto.
9. Sem commit salvo pedido explícito.
10. Electron: `ELECTRON_RUN_AS_NODE=1` herdado quebra a janela. Abrir por
    `ABRIR_RECONSTRUCAO.bat`.

### Pré-condições padrão (F0)

```powershell
# 1. build do bot (não do tap)
node tools/build_native.cjs --only bot
# 2. reiniciar PokeAlliance_dx.exe DEPOIS do build, entrar no personagem
# 3. chave do canal do menu PKA Tools em execução
powershell -ExecutionPolicy Bypass -File tools/capture_channel_key.ps1
# gravar o valor em native\pka_channel_key.txt
# 4. injetar só o bot
native\pka_inject.exe --name PokeAlliance_dx.exe --dll native\pka_native.dll
# 5. gate de entrada
$env:PKA_PID = '<PID>'
node tools/live_preflight.cjs --verify
```

Aceite do F0: `live-preflight.json` com `status: "verified"`,
`nativeVerified: true`. `blocked`/`unverified` → pare e classifique
`BLOQUEADO`.

Ação bar no jogo: F1 potion, F2 skill de ataque, F3 revive (as mesmas do perfil
usado na missão).

---

## 1. Inventário do que já está medido (não refaça)

| item | estado | evidência |
| :--- | :--- | :--- |
| protocolo (`potion` numérico, `revive` rejeitado, `talk`/`combo`) | CONFIRMADO byte a byte | `reconstruction/protocol.cjs` + `protocol_vectors.json` |
| combo pelo interpretador `exe+0x67fbf0` (len == 10, literal `!autocombo`) | CONFIRMADO | `AGENTS.md` |
| recusa silenciosa de attack em `[rt+0x2548]` (`rc == 4`) | CONFIRMADO | `AGENTS.md` |
| walk nativo `exe+0x780c90`, passo único | implementado, 1 tentativa medida | `local-data/walk-validation-*.json` |
| walker do clone, caso `free` | **verde frouxo** (ver M3) | `local-data/walk-channel-2026-11-18T20-11-16-871Z.json` |
| canal nativo ponta a ponta (F3) | **reprovado**: `target.kill` e `combat.revive` | `live-channel-audit.json` (2026-11-18T20:29Z) |
| UI sobre simulação | verde | `node tools/ui_audit.cjs`, `app-audit.json` |

Última auditoria viva (`live-channel-audit.json`) reprovou por:
`target.kill` → `no-attack`, `reasons: ["no-creature"]`, **apesar de 11
criaturas na telemetria**; `combat.revive` → `no-combo`;
`healer.healCommand` passou mas `healer.healthRecovery` ficou
`command-without-recovery` (HP plano em 91 em 15 amostras). Além disso o canal
vivo reportou `roster: 0`.

---

## 2. Missões pendentes, por prioridade

### M1 — P0 — `walk` nativo: passo único com série temporal
- **Objetivo:** provar que um `walk` move exatamente 1 tile na direção, mesmo
  `z`, sem passo extra, com **série** (não só antes/depois).
- **Ferramentas:**
  `node tools/live_walk_validate.cjs --pid <PID> --direction <dir> --test=A --confirm`
  e, para série,
  `node tools/live_walk_ordering.cjs --pid <PID> --direction <dir>` e
  `node tools/live_walk_cadence.cjs --pid <PID> --direction <dir>`.
- **Aceite:** delta exato em `(x,y)`, `z` intacto, um comando, nenhum passo
  extra na janela; cadência medida (não declarada).
- **Armadilha:** o `--test=A` só lê antes/depois; um passo extra com retorno
  escapa. Só `CONFIRMADO` de trajetória com série real.
- **Se FALHAR:** registrar primeira divergência e a menor checagem seguinte
  (foco? direção? `Game::walk` recusou? `Tile` bloqueado?). Não repetir para
  "conseguir verde".

### M2 — P0 — F3: auditoria viva do clone (canal nativo)
- **Objetivo:** `live-channel-audit.json` com `ok: true`.
- **Comando:**
  ```
  $env:PKA_CHANNEL_KEY_FILE = '<caminho>\pka_channel_key.txt'
  $env:PKA_PID = '<PID>'
  electron reconstruction/app --live-channel-audit
  ```
  Sem `PKA_CHANNEL_KEY_FILE` a auditoria recusa (viraria teclado).
- **Reprovações atuais e o que investigar:**
  1. `target.kill` = `no-attack` com `no-creature` **tendo 11 criaturas**:
     comparar `telemetry.creatures[]` do canal nativo com o que o
     `target-engine` filtra (`type`, `canAttack`, `is_player`, `healthPercent`,
     nome ignorado). Hipótese: campo ausente/renomeado no canal vivo — não
     invente, registre o payload cru de uma amostra.
  2. `combat.revive` = `no-combo`: depende de `target.kill` produzir combo.
     Resolver 1 antes.
  3. `roster: 0` no canal vivo: verificar se o `pka_native.dll` publica roster;
     sem roster, healer e revive-por-Pokémon não têm como confirmar.
- **Aceite:** `ok: true` com `target.kill` (`damaged` ou `gone`),
  `healer.healCommand`, `combat.revive`, `monitor.notification`, `errors`.
- **Não prova:** caminhada (a auditoria monta `walker.waypoints: []`).

### M3 — P0 — F4: walker do clone no cliente real
- **Objetivo:** os 4 casos do `tools/live_walk_channel.cjs` verdes na primeira
  tentativa de cada um.
  ```
  node tools/live_walk_channel.cjs --pid <PID> --case free
  node tools/live_walk_channel.cjs --pid <PID> --case box
  node tools/live_walk_channel.cjs --pid <PID> --case wall
  node tools/live_walk_channel.cjs --pid <PID> --case stairs --stairs x,y,z --dir north
  ```
- **Aceite por caso:**
  - `free`: 3 tiles, um passo por tile, `z` igual, sem `stuck`;
  - `box`: chegada com `arrived-adjacent` (ou exata) em ≤1 passo, **sem** os
    ~5,85 s de órbita;
  - `wall`: chegar contornando parede, com **mais passos que a distância em
    reta** (prova o A*; sem isso é guloso e o teste mede outra coisa);
  - `stairs`: um único `walk` na direção do `param` + transição de `z`; sem
    transição, `stairs-timeout` em 5 s; `stairs` sem `param` não emite passo.
- **Divergência já vista:** o relatório de `free` de 2026-11-18 terminou a
  **1 tile do alvo** (`distanceToTarget: 1`, `reasons: ["cadence",
  "arrived-within-one-tile"]`) e ainda assim `ok: true`, embora o protocolo
  exija delta exato. Decida e registre: ou o aceite do tool está frouxo
  (corrija), ou o contrato mudou (documente em
  `docs/PROTOCOLO_VALIDACAO.md`).
- **Mapa:** `wall` depende do mapa OTMM carregado na aba; registre qual arquivo
  estava carregado. Sem mapa, o motor cai no guloso.
- **Não prova:** lure, combate e rota longa.

### M4 — P0 — F5: rota real de 3–5 minutos
- **Objetivo:** rota com `loop: true`, box e safespot, sem intervenção manual.
- **Comando:** `node tools/route-cycle.cjs --pid <PID> --minutes 3`
  (referência de comportamento) e depois a mesma rota pela interface principal.
- **Medir:** waypoints cumpridos, `stuck` por tipo de ação, tempo parado,
  retomada após combate.
- **Aceite:** nenhuma ocorrência de órbita; `stuck` só em box/safespot com tile
  realmente ocupado; retomada após cada combate.
- **Depende de:** M2 e M3.

### M5 — P1 — Healer: recuperação de HP confirmada
- **Objetivo:** provar que a cura **sobe o HP**, não só emite `talk m1`.
- **Estado atual:** `healer.healCommand` passa, `healer.healthRecovery` falha
  (`command-without-recovery`, HP plano em 91).
- **Procedimento:** ferir o Pokémon/player até abaixo de `healer.healHpPercent`,
  rodar a auditoria viva, registrar HP antes/depois por amostra e o cooldown da
  skill.
- **Aceite:** HP sobe após o comando, com o mesmo `playerId`/entidade.
- **Se o snapshot não publicar HP do jogador nem roster:** declarar
  `INDISPONÍVEL` e registrar que a lacuna é de telemetria, não de cura.

### M6 — P1 — Captura: efeito no corpo
- **Objetivo:** provar o ciclo de captura (ID do corpo muda de estado / corpo
  sai da lista / ball consumida).
- **Base estática já existe:** `native_capture_*.json`, `native_capture_vm_static.json`.
- **Aceite:** transição observada em telemetria com o corpo correto, ou
  `FALHOU` com a primeira divergência.

### M7 — P1 — Lure: parada física e distância (exige vídeo)
- **Por que falta:** o `kind5` do fornecedor **esconde `type 1`** de propósito
  (confirmado: 0 selvagens em 554 frames com o Shiba caçando, `lure.count: 6/8`).
  Distância Pokémon↔monstro **não** sai por captura passiva.
- **Instrumento necessário:** gravação de tela sincronizada com telemetria
  (timestamp comum), medindo: parada física durante a lure, movimento do
  Pokémon, distância mantida, durações das fases.
- **Referência medida:** travel 3672 ms, arc 32 ms, stationary 234 ms, wait
  1406 ms (6.616 frames de captura).
- **Aceite:** série sincronizada com os quatro desfechos; campo não medido =
  `INDISPONÍVEL`, nunca inferido.

### M8 — P1 — Pathfinding A*: parede de verdade
- **Objetivo:** provar desvio de parede com o mapa OTMM e comparar com o guloso.
- **Aceite:** chegada ao destino com custo de caminho > distância em reta e
  nenhum passo dentro da parede; registrar o arquivo de mapa usado.
- **Ligação:** `EngineRuntime.mapProvider` → `reconstruction/pathfinder.cjs`.

### M9 — P2 — Regras estáticas ainda parciais (análise, sem jogo)
Arquivo: `reconstruction/spec/remaining-rules-v1.json`. Cada item exige
offset + assinatura de bytes + pseudocódigo; "provavelmente" não vale.

| id | o que falta | pista já registrada |
| :--- | :--- | :--- |
| `BestTileScore` | fórmula de score e desempate | construtor `0x93b04`, vtable `0xeb6e0`, constante 4000 em `0x933b2` |
| `NextTeam` | predicado exato de troca por HP | `0x9b683` roster, `0x9b6b3` `cvttsd2si`, limite 6 slots `0x9b6a9`, módulo `0x9b6c8` |
| `ComboBuffDone` | ACK do ComboStep e contagem de buffs | gate `0x57df5..0x57f8d`, comparação 1000 ms `0x57fe8`, contagem 3.0 `0x58097` |
| `HealerDeployReady` | agregação roster-wide (`gateReadyPct`/`gateMinHp`) | predicado resolvido `0x9d240..0x9d2c7`, const 1000.0 em `0xecf80` |

Dumps disponíveis: `dumps/payload_reconstructed.dll` (imagem crua, offsets de
imagem), `dumps/native_remaining_rules_evidence.json`,
`dumps/native_runtime_evidence.json`. O `.pdata` do exe é inválido
(71.433/71.459 entradas impossíveis) — não baseie conclusão nele.

### M10 — P2 — `movement` do treinador (kite/chase/random_move)
- **Estado:** só `stand` funciona, e por acidente (`pauseWalker: true`).
  `kiteRange` não é consumido em motor nenhum.
- **Bloqueio de contrato:** `rpm-combat-runtime.cjs:676` rejeita comando fora de
  `['hotkey','talk','combo']`; `engine-runtime.cjs` pausa o walker no combate.
  Implementar `kite` exige mexer nos dois runtimes.
- **Aceite:** distância mantida medida em jogo (com M7) e nenhum erro de
  despacho.

### M11 — P2 — Cadência real e fluidez
- **Objetivo:** medir intervalo entre passos com telemetria real (piso de
  cadência do clone é 406 ms, medido no cliente do Shiba) e se há "trava" entre
  passos.
- **Ferramenta:** `tools/live_walk_cadence.cjs` (série com timestamps).
- **Aceite:** distribuição de intervalos com N ≥ 20 passos; declarar
  min/mediana/p95. Não inferir fluidez de teste simulado.

---

## 3. Ordem de execução recomendada

```
M1 (walk nativo, série)
  └─> M2 (auditoria do clone)      [triagem target.kill antes de revive]
        └─> M3 (walker do clone: free → box → wall → stairs)
              └─> M4 (rota real 3–5 min)
M5, M6, M8 em paralelo quando houver sessão estável
M7 exige vídeo sincronizado (sessão dedicada)
M9 é offline (dumps), não compete com o jogo
```

## 4. Entrega de cada missão

Arquivo de veredito em `local-data/` ou `docs/MISSOES/vereditos/`, contendo:

- veredito (`CONFIRMADO`/`FALHOU`/`INCONCLUSIVO`/`BLOQUEADO`), por dimensão
  quando houver mais de uma (use a mais fraca como geral);
- `pid`, caminho do exe, `StartTime`, `mtime` da DLL, `loadedImageSha256`,
  `fileOnDiskSha256`;
- posição inicial/final com `tick`, hora de parede e `sameEntity`;
- delta esperado × observado, número de comandos, `dispatchDelivery`,
  `status`/`message` crus se houve recusa (`status 4`/`5` = não executou);
- caminho de cada JSON de evidência e do `%TEMP%\pka_native.log`;
- "O que NÃO foi provado" preenchido.

Aceite só é aceito se a seção "O que NÃO foi provado" existir e se nenhum campo
`INDISPONÍVEL` tiver sido inferido.

## 5. Definição de "bot validado"

F1 a F5 verdes **na mesma sessão**, com `live-preflight.json`,
`live-channel-audit.json` (`ok: true`), relatórios de F4 (4 casos) e F5 datados,
e **nenhuma ação manual fora dos comandos do bot**.
Hoje isso não existe: F1 já foi `verified` uma vez, F2 tem uma tentativa de
walk, F3 está reprovado, F4 tem só um caso parcial e F5 nunca foi medido.
