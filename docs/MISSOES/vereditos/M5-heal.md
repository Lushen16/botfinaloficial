# M5 — Recuperação de HP (treinador e Pokémon)

Sessão: `00-sessao-2026-11-19.md` (pid 20164, perfil `Default`).
Cenário: área aberta com selvagens próximos (Geodude/Bellsprout a 1–4 tiles),
patrimônio de HP perdido por ataque dos selvagens, Pokémon escolhido por hotkey
da Pokébar.

## Caso A — HP do treinador

- **Configuração:** Pokémon `Togepi` ativo (hotkey `7` da Pokébar), skill de
  cura `m4` (`Healarea`) enviada por `talk`. Limiar de disparo: HP 67 (abaixo de
  qualquer limiar de perfil; `healer.healHpPercent` está 0 no perfil, então o
  envio foi manual pelo canal).
- **Controle:** `talk m2` (`Charm`, não-cura) com HP 100 — nenhuma alteração.
- **Ação:** `talk m4` com HP 67.
- **Dados:** `local-data/m5-player-heal.json` (baseline 67 → 100 em ~650 ms,
  mesma entidade `Banedenovootario`, pet intacto em 99→100) e
  `local-data/m5-controlled.json` (controle `m2` sem efeito; `m4` depois eleva
  o HP do **pet** 36→100 com o treinador já em 100).
- **Atribuição:** mesma entidade, ação entre as amostras, nenhuma outra fonte de
  cura na janela; `m2` como controle negativo.
- **Veredito:** `CONFIRMADO`.

## Caso B — HP do Pokémon

- **Configuração:** mesmo pet `Togepi`; potion da Pokébar testada nas teclas
  `1`, `E`, `R`, `Alt+F` e `F`.
- **Dados:** `local-data/m5-potion-probe.json` (vazio — o laço nunca desceu de
  72 % de HP do pet), `local-data/m5-potion2.json` (pet 85 sem reação a
  `1`/`E`/`R`), `local-data/m5-controlled.json` (`m4` eleva o pet 36→100 e o
  controle `m2` não).
- **O que ficou provado:** a skill de cura (`Healarea`, `m4`) recupera o HP do
  Pokémon: 36 → 100 no mesmo tick seguinte, sem troca de entidade.
- **O que ficou INDISPONÍVEL:** a hotkey da potion. A tecla `1` curou um
  `Dugtrio` de 87 → 100 uma vez, mas não repetiu em `Togepi` 92 nem em
  `Squirtle` 85. Motivo: a Pokébar é por slot e o slot 1 varia com o time
  (a mesma tecla também troca de Pokémon); sem mapa de slot→item confirmado,
  não há como atribuir. Cooldown também não observável.
- **Veredito:** `CONFIRMADO` para a cura do Pokémon por skill; `INDISPONÍVEL`
  para a hotkey da potion.

## O que NÃO foi provado

- Potion como item (hotkey, slot 3, cooldown).
- Healer pelo motor (`healer-engine`): o canal publica `"roster":[]` fixo nesta
  DLL, então o healer não escolhe Pokémon por roster; a cura acima foi
  disparada direto pelo canal.
- Cura em combate com o pet sob dano contínuo e concorrência de regeneração —
  o caso A ocorreu sem regeneração observável, mas não foi isolado do
  combate.
