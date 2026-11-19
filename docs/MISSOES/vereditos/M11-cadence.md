# M11 — Cadência real e fluidez do walker

Sessão: `00-sessao-2026-11-19.md`.
Ferramenta: `tools/live_walk_channel.cjs --case free` (walker do clone pelo
caminho de produção), 13 execuções no corredor leste a partir de ~3305,2024
(z 7). Cada execução anda 2 tiles e para.
Amostras: `local-data/walk-channel-2026-11-19T18-09-*.json` e
`…T18-10-*.json`. Agregado: `local-data/m11-cadence.json`.

## Dados

- 13 execuções, 26 intervalos entre mudanças consecutivas de tile.
- Varredura completa: N 26, mín 100 ms, mediana 328 ms, p95 440 ms, máx 440 ms.
- Por execução há **dois** intervalos: o primeiro (100–109 ms) é o do
  despacho até a primeira mudança e não é cadência; o segundo (328–440 ms) é o
  passo seguinte.
- Excluindo o primeiro intervalo de cada execução: N 13, mín 328 ms,
  mediana 431 ms, p95 440 ms, máx 440 ms.
- Referência medida no cliente do Shiba: 406 ms. A mediana (431) e o p95 (440)
  ficam até 34 ms acima — dentro da granularidade de amostragem do tool
  (~50 ms, 100 ms por tick).
- nenhuma pausa > 1 s dentro de execução; nada de combate no corredor.

## Achado que não é cadência

Em **todas** as 13 execuções o walker encerrou o waypoint a
`distanceToTarget: 1`, com motivo `arrived-within-one-tile` — nunca no tile
exato. O `result.ok` do tool aprova assim mesmo. Isso conflita com
`docs/PROTOCOLO_VALIDACAO.md` ("delta exato de 1 tile na direção"), então o
aceite do tool está frouxo ou o contrato mudou sem registro.

## Veredito

`CONFIRMADO` para cadência: passos sucessivos a ~430 ms, sem travas, contra
referência 406 ms, dentro da granularidade.
`FALHOU` para chegada exata: 0 de 13 execuções pararam no tile do waypoint.

## INDISPONÍVEL

- Fluidez com combate ativo, lure ou obstáculo: só corredor livre.
- Intervalo real dentro do jogo (não amostrado): resolução de ~50–100 ms.

## O que NÃO foi provado

- Que a chegada a 1 tile seja proposital em `walk` (a tolerância documentada é
  para `box`/`safespot`) ou regressão.
- Distribuição em rota longa; p95 em rota real.
