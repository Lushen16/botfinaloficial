# Protocolo de validação no cliente real

Regra central: **cada camada pode mentir**. ACK, botão habilitado, telemetria com
`schema` válido e teste verde não provam efeito. Só contam:

- `walk` → delta de `position` exato na direção, mesmo `z`, e nenhum passo extra;
- `attack` → HP do alvo cai (ou ele desaparece);
- cura/revive → HP sobe / hotkey aceita com o Pokémon de volta;
- captura → ID do corpo muda de estado.

Se uma fase falhar, **pare nela**. Não "compense" rodando a próxima.

Este protocolo só vale para a `pka_native.dll`. Não injete `pka_tap.dll` junto
(brigam pelo pipe); para comparar com o Shiba, sessão separada.

---

## F0 — preparação (sem comando de jogo)

1. **Reinicie o cliente** (`PokeAlliance_dx.exe`) e entre no personagem. A DLL
   nova só entra em processo novo; não descarregue com `FreeLibrary`.
2. Confirme o build: `node tools/build_native.cjs --only bot`. Se o jogo já
   estiver aberto com a DLL antiga, o build grava `pka_native_new.dll` — nesse
   caso reinicie antes de injetar.
3. Capture a chave do menu PKA Tools em execução:
   `powershell -ExecutionPolicy Bypass -File tools/capture_channel_key.ps1`
   e grave o valor em `native/pka_channel_key.txt` (a DLL lê do arquivo ao lado
   dela). Alternativa: `node tools/live-test.cjs` faz build+injeção+probe.
4. Injete só o bot: `native\pka_inject.exe --name PokeAlliance_dx.exe --dll native\pka_native.dll`.
5. No personagem, deixe na action bar: F1 potion, F2 skill de ataque,
   F3 revive. Configure-as no perfil.
6. Garanta `runtimeReady` **e** posição não-sentinela. `(0,0,0)` e
   `(65535,65535,255)` são recusados pelo gate desde 2026-11-18
   (`realPosition`, `reconstruction/engines/shared.cjs`).

## F1 — prontidão (gate de entrada)

```
$env:PKA_PID = '<PID>'
node tools/live_preflight.cjs --verify
```

**Aceite:** `status: "verified"` e `live-preflight.json` com
`nativeVerified: true`. `blocked`/`unverified` param tudo.

Prova: handshake, chave, canal e telemetria passando pelo gate dos motores.
Não prova: nenhum efeito de jogo.

## F2 — executor e transporte (um passo, um ataque)

```
node tools/walk-verify.cjs --pid <PID> --dir 2 --watch 6
node tools/route-e2e.cjs --pid <PID> --steps 2 --dir 2
```

O jogo precisa estar em primeiro plano (`walk` mantém o gate de foco;
`hotkey`/`potion` não dependem dele).

**Aceite do walk:** delta exato de 1 tile na direção, `z` igual, **um** comando,
nenhum passo extra na janela, `Tile` refcount estável.

**Aceite do ataque:** HP do alvo cai ou ele sai da lista. `status 0` não conta.

Prova: `Game::walk`/`attack` nativos, PostMessage e leitura. Não prova: o motor
do clone (quem decide a direção ali é o `CommandDispatcher`, não o walker).

## F3 — cadeia do clone (interface principal)

```
electron reconstruction/app --live-channel-audit
```

Sem `PKA_CHANNEL_KEY_FILE` a auditoria recusa (viraria teclado, não canal).
Ela esconde o menu e traz o jogo para frente nas fases de hotkey.

**Aceite:** `live-channel-audit.json` com `ok: true` e, obrigatoriamente:
`channel.connect`, `game.realChannel`, `target.kill` (com `damaged` ou `gone`),
`healer.healCommand`, `combat.revive`, `monitor.notification`, `errors`.

Prova: `EngineRuntime` + `native-adapter` + pipe no caminho de produção.
Não prova: caminhada — a auditoria monta `walker.waypoints: []`.

## F4 — walker do clone (lacuna atual, exige ferramenta)

Não existe validação viva do walker do clone. Criar
`tools/live_walk_channel.cjs` (mesmo padrão de `live-channel-audit`: runtime de
produção, efeito na telemetria) com três casos, nesta ordem:

1. **rota livre** — 3 `walk` no mesmo andar: chegada em N passos, delta exato,
   cadência ~406 ms, sem `stuck`;
2. **`box` com tile ocupado por criatura viva** — corpo a 1 tile: `advance` com
   `arrived-adjacent` em ≤1 passo, **sem** os ~5,85 s de órbita;
3. **`box` com tile bloqueado e criatura ausente da telemetria** — `stuck` em
   ~13 comandos, sem girar (confirma a guarda de órbita).
4. **`stairs` com direção** — um único passo na direção do `param` e transição
   de `z`; sem transição, `stairs-timeout` em 5 s. `stairs` sem `param` não
   pode emitir passo.

Com pathfinding, rota e caso 2 dependem de o mapa OTMM da aba estar carregado;
a rota precisa cruzar uma parede para provar o desvio. Sem mapa o motor cai no
guloso e o teste mede outra coisa — registrar qual mapa estava carregado.

**Aceite:** os três desfechos na primeira tentativa de cada caso, com
`position` real registrada por amostra. Se o caso 2 não disparar, a hipótese
"criatura no tile aparece na telemetria" está errada — registrar e reabrir.

Prova: decisão do walker + executor + efeito. Não prova ainda: rota real longa.

## F5 — rota real

Rota de 3–5 minutos, `loop: true`, com box e safespot. Medir: waypoints
cumpridos, `stuck` por tipo de ação, tempo parado, retomada após combate.
`node tools/route-cycle.cjs --pid <PID> --minutes 3` já cobre walk+attack+cura
em ciclo pelo transporte nativo (é a referência de comportamento).

**Aceite:** nenhuma ocorrência de órbita; `stuck` só em box/safespot com tile
realmente ocupado; retomada após cada combate.

---

## Triagem de falha

| sintoma | camada | suspeita |
| :--- | :--- | :--- |
| F1 `blocked` | canal/chave | pipe ausente, chave errada, DLL não injetada |
| F1 `unverified` | telemetria | `runtimeReady` falso (menu), posição sentinela, nome não resolve |
| F2 walk sem delta | executor | foco, `Game::walk` recusou, direção errada |
| F2 ataque sem dano | executor/alvo | alvo era o atual, alvo fora de alcance, HP não relido |
| F3 canal falha | clone | `native-adapter`, capabilities, gate |
| F4 caso 2 sem `arrived-adjacent` | walker | criatura não vem na telemetria ou `type` inesperado |
| F4 caso 3 sem `stuck` | walker | guarda de órbita não chegou a rodar (cadência/pending) |

## Definição de "completamente validado"

F1 a F5 verdes na **mesma sessão**, com os arquivos de evidência datados
(`live-preflight.json`, `live-channel-audit.json`, relatório do F4/F5) e nenhuma
ação manual fora dos comandos do bot. Enquanto F4 não existir, o walker do clone
está sem prova viva — e é a única camada, hoje, sem ferramenta.
