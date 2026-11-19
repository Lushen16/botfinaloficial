# M7 — Parada física e distância durante a lure

Sessão: `00-sessao-2026-11-19.md`.

## Desenho da tentativa

1. `EngineRuntime` (runtime de produção) com `target.monsters: [{name:"*",
   minCount:8}]`, `hoenn.perfectLure: true`, `luring.frontEnabled: true`,
   `walker.waypoints` com um ponto fixo; amostragem de 250 ms por 45 s
   (`local-data/m7-lure-*.json`).
2. Série geométrica manual: 6 s parado, 4 `walk` para oeste, 6 s parado, 4
   `walk` para leste, amostragem de 200 ms (`local-data/m7-geometry-*.json`).

## Resultado

- **Fase de lure não iniciou.** O estado ficou em walker (`cadence` 70,
  `arrived` 81, `await-position-sample` 18) e nenhum tick devolveu motivo de
  lure. Causa observada: o motor de target com `minCount` atingido entra em
  combate e o walker domina; o caminho que dispara o `lure-engine` (target
  `idle`/`luring`) não foi alcançado nesse cenário.
- **Pet ficou 85 tiles atrás do treinador** depois da morte/respawn
  (`ownPokemon.pos` 3286,2111 contra `position` 3300,2026) e não voltou às
  costas. `recallPokemon` foi **recusado** (`status 1`, comando inválido para o
  executor) e as teclas da Pokébar não trouxeram o pet. Com o pet longe, a
  distância pet↔monstro não mede a geometria da lure.
- As séries geométricas saíram com `nearD` = 1e9 porque o campo de criaturas
  estava quase vazio perto do respawn (1–2 criaturas).

## Veredito

`INCONCLUSIVO` para os quatro eixos (parada física, movimento do Pokémon,
distância, duração das fases).

## Correção aplicada depois da medição

- `recallPokemon` (15) deixou de ser `UNSUPPORTED`: posta a tecla do slot
  informado (Pokébar) e é declarado no contrato. Efeito ainda não observado.
- `items[]` passou a publicar corpos, o que permite medir distância pet↔corpo
  sem instrumento externo.
- O desvio de 85 tiles aconteceu depois de morte/respawn; o pet fica para trás
  e não acompanha teleporte.

## INDISPONÍVEL

- Duração das fases `travel`/`arc`/`stationary`/`wait`: o lure não rodou.
- Distância pet↔monstro: pet desacoplado do treinador.
- Parada física do treinador durante a lure: sem lure, o walker é dono do
  movimento.

## O que NÃO foi provado

Tudo o que depende de lure real. A referência (travel 3672 ms, arc 32 ms,
stationary 234 ms, wait 1406 ms) não foi comparada nesta sessão.

## Próximo passo mínimo

Reconectar o pet (`recallPokemon` implementado/validado no executor) e forçar
cenário de lure com `hoenn.minWildsToEngage` atingido sem combate imediato;
alternativa é rodar a interface principal (auditoria viva) e medir pelo
`state.lure` do `EngineRuntime`.
