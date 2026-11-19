# M8 — Desvio de parede com A* e OTMM

Sessão: `00-sessao-2026-11-19.md`.
Ferramenta: `node tools/live_walk_channel.cjs --pid 20164 --case wall`.
Evidência: `local-data/walk-channel-2026-11-19T18-11-20-712Z.json`.

## Cenário

| campo | valor |
| :--- | :--- |
| mapa carregado | `%APPDATA%\PokeAlliance\PokeAllianceV3\minimap854.otmm` (padrão do tool; `PKA_MAP_FILE` ausente) |
| origem | 3307, 2024, z 7 |
| destino | 3312, 2024, z 7 (distância em reta 5) |
| parede detectada | 3310, 2024, z 7 (mesmo andar) |
| planejador | A* (`EngineRuntime.mapProvider` → `reconstruction/pathfinder.cjs`) |
| duração | 25.028 ms, limite do tool |

## Resultado

- **58 passos**, terminou em 3335, 2042, z 7 — **23 tiles do destino**.
- Trajetória inicial: 3307,2024 → 3306,2024 → 3306,2025 → 3305,2025 →
  3305,2026 → … ou seja, **afastou-se para oeste/sul** em vez de contornar a
  parede imediata a leste.
- `result.reasons`: apenas `cadence` e `await-position-sample`; nenhum
  `map-blocked`, nenhum `stuck`, nenhuma chegada.
- `distanceToTarget` final 23; `dz` 0.

## Veredito

`FALHOU`.

O A* foi acionado (o caminho saiu da reta), mas não cumpre o critério de chegada
do F4 dentro da janela: percorreu custo maior que a distância direta e não
chegou. Falta ainda a comparação com o modo guloso.

## INDISPONÍVEL

- Comparação A* × guloso no mesmo par origem/destino (o tool não tem chave para
  desligar o planejador).
- Ocupação móvel: não registrada por amostra; criaturas podem ter alterado o
  custo entre tentativas.

## O que NÃO foi provado

Que o desvio seja vantagem do A* e não uma rota ruim: seria preciso o mesmo par
com guloso e tempo maior de execução. Também não se provou contorno completo de
parede (nenhum passo cruzou a linha 3310).

## Próximo passo mínimo

Repetir com limite maior (o tool usa ~25 s) e uma chave `PKA_NO_MAP=1` para o
controle guloso; registrar `map-blocked` como sinal de que o plano existe mas o
executor não segue.
