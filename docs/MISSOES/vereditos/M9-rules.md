# M9 — Regras parciais de fidelidade (offline)

Sessão: `00-sessao-2026-11-19.md`. Sem jogo: só artefatos.
Fonte primária: `native_remaining_rules_evidence.json` (âncoras byte-exatas),
`reconstruction/spec/remaining-rules-v1.json`, implementações em
`reconstruction/`.

Regra de entrega: cada registro traz predicado candidato, referência
verificável, caso discriminante e o que o motor atual faz. Onde a evidência só
sustenta parte, a regra fica **parcial** e as condições abertas são listadas.

---

## 1. BestTileScore

- **Lacuna:** fórmula de score e critério de desempate.
- **Sustentado:** `tickBestTile` em `0x92730..0x93c63`; contexto de config em
  `0x9d9ef..0x9dd7d` lê `bestTileMaxWaitMs` (2500), `bestTileRetryMs` (700),
  `bestTileRange` (4), `perfectLureTimeoutMs` (10000). Constante 4000 em
  `0x933b2` (`mulsd`), 2 em `0x92e98`, 200 em `0x930e2`, 2500 em `0x936ae`,
  1400 em `0x936d9`, 4 em `0x93a24`, 100 em `0x93a60`, 1 em `0x93a8e`.
- **Predicado candidato (parcial):**

  ```
  score(tile) = f(posições livres em raio <= bestTileRange) * 4000
                + g(distância ao Pokémon), com piso em 1 e teto em 100
  escolha = argmax(score); empate = ? (não recuperado)
  retry a cada bestTileRetryMs; desiste em bestTileMaxWaitMs
  ```

- **Caso discriminante:** dois tiles com **contagens livres diferentes**
  (7 vs 8) e um terceiro empate com a mesma contagem — o desempate decide; se o
  desempate for "mais perto do Pokémon" o terceiro perde, se for "ordem de
  varredura" pode ganhar.
- **Motor atual:** `chebyshev(boxCenter, creature.pos) <= bestTileRange`
  (`target-engine.cjs`), aceitando o alvo dentro do raio sem calcular score nem
  desempate. Conservador, não equivalente.

## 2. NextTeam

- **Lacuna:** predicado exato de troca por HP.
- **Sustentado:** `tickHoenn` em `0x9b4c0`; leitura do roster em `0x9b683`
  (`lea` para a chave `roster`), `cvttsd2si` do HP em `0x9b6b3`, limite de 6
  slots em `0x9b6a9`, rotação módulo em `0x9b6c8..0x9b6ce` (`cdq`/`idiv`/`cmp`).
- **Predicado candidato (parcial):**

  ```
  próximo = roster[(índiceAtual + 1) % min(slots, 6)]
  candidato entra se hp(candidato) > limiar; limiar = ? (não recuperado)
  roster incompleto: slots vazios pulados? (a confirmar)
  ```

- **Caso discriminante:** HP do próximo slot exatamente **no limiar**, outro
  **1 abaixo** e outro **1 acima**; se a comparação for `>` o do limiar fica,
  se for `>=` entra — resultados opostos. Complementos: roster com 3 de 6 slots
  (pular vazios) e passagem do 6º para o 1º (módulo).
- **Motor atual:** healer/hoenn do clone não implementam esse predicado; e o
  canal publica `roster: []` fixo, então nem há dado em jogo.

## 3. ComboBuffDone

- **Lacuna:** critério de conclusão por ACK do step e contagem de buffs.
- **Sustentado:** gate de config em `0x57df5..0x57f8d` (`useMedicine`,
  `useMedicineBeforeCombo`, `medicineHotkey`, `medicineActionBar`, erro literal
  "Configure a hotkey de Medicine ou desative Medicine."); gate de combo em
  `0x57f90..0x5818d` compara `elapsed` com 1000 (`0x57fe8`) e contagem com 3
  (`0x58097`); dispatch em `0xa1633..0xa1800` monta o pedido com
  `pokestopToComboMs`, `gateStopped`, `useReadyGate`, `cycleAtSafeSpot`,
  `gateReadyPct`, `readyPct`, `gateDpsMinHp`, confirmando a ordem
  medicine → gate → combo.
- **Predicado candidato (parcial):**

  ```
  buffDone = ACK(step anterior) && (elapsed since dispatch >= 1000)
             && (contagem de buffs < 3 ? continua : conclui)
  ```

- **Caso discriminante:** ACK ausente, ACK atrasado (fora de 1000 ms),
  contagem parcial (1–2 buffs) e conclusão com 3; cada um separa ACK de
  contagem. Se o motor usar "3 buffs" como contador absoluto, 4 buffs deve
  encerrar; se for "até 3", o quarto continua.
- **Motor atual:** o clone aplica medicine antes do combo sem ACK nem contagem
  de buffs; conclusão do combo é por `comboFallbackMs`/`nativeComboWaitMs`.

## 4. HealerDeployReady

- **Lacuna:** agregação roster-wide de `gateReadyPct`/`gateMinHp`.
- **Sustentado:** predicado resolvido em `0x9d240..0x9d2c7`:
  `ready = (now - deployStableSince) > max(pokeReadyTimeoutMs, 1000)`, âncoras
  `subsd/maxsd/comisd/jbe`, constante 1000.0 em rdata `0xecf80`.
- **Predicado candidato (parcial):**

  ```
  deployReady = estável por > max(pokeReadyTimeoutMs, 1000)
                && todos os slots com readyPct >= gateReadyPct
                && tank com hp >= gateMinHp
                && cada DPS com hp >= gateDpsMinHp
  ```

- **Caso discriminante:** equipe mista (tank pronto, 1 DPS abaixo) — a
  agregação "todos" reprova; Pokémon ausente do roster — reprova ou ignora
  (comportamentos opostos); valores exatamente no limiar — `>=` aprova.
- **Motor atual:** só o predicado temporal (`combat-readiness.js`), sem
  agregação roster-wide; depende de roster, que o canal não publica.

---

## Veredito por regra

| regra | veredito | aberto |
| :--- | :--- | :--- |
| BestTileScore | parcial | desempate, escala exata do termo de distância |
| NextTeam | parcial | limiar de HP, tratamento de slot vazio |
| ComboBuffDone | parcial | ACK real do step, semântica da contagem 3 |
| HealerDeployReady | parcial | agregação "todos" e ausência de slot |

Nenhum registro chegou a `CONFIRMADO`: todas as lacunas continuam em pelo menos
um dos elementos que a missão exige (fórmula completa ou desempate).
