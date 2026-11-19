# M10 — Movimento do treinador durante combate

Sessão: `00-sessao-2026-11-19.md`.

## Desenho

Combate contínuo com o monstro vivo mais próximo, `attack` a cada 600 ms por
9 s, em dois perfis de `target.monsters[].movement`: `stand` e `kite`
(`kiteRange: 2`). Distância medida em Chebyshev **treinador→monstro mais
próximo**, reescolhido a cada amostra (o alvo anterior morria ou saía).

Comando: driver direto pelo canal (sem `EngineRuntime`), para isolar a decisão
de movimento de combate.

## Resultado

| modo | n | mín | mediana | máx | série (Chebyshev) |
| :--- | --: | --: | --: | --: | :--- |
| `stand` | 15 | 8 | 9 | 11 | 8,8,8,8,8,9,9,9,9,9,9,9,10,10,11 |
| `kite` | 15 | 4 | 6 | 7 | 4,4,4,4,4,4,5,6,6,7,7,7,7,7 |

- Em `kite` o treinador não emitiu nenhum `walk`: a distância subiu de 4 para 7
  por movimento do monstro, não por correção do motor.
- `kiteRange: 2` nunca foi atingido em nenhum modo.
- `chase` e `random_move` não foram executados em jogo (mesmo motor; a
  ausência de `walk` de combate é comum aos quatro).
- `stand` coincide por acidente: o combate devolve `pauseWalker: true` e o
  treinador fica parado.

## Veredito

`FALHOU` para `kite` (não corrige distância); `FALHOU` para `chase` e
`random_move` por ausência de implementação; `CONFIRMADO` apenas o efeito de
`stand` (parado durante o combate).

## INDISPONÍVEL

- Retomada da rota após o fim do combate: não medida (o walker não era o mesmo
  driver).
- Alvo perdido, tile bloqueado e disputa de movimento: não exercitados.
- Série de posições do treinador por amostra: só distâncias foram guardadas.

## O que NÃO foi provado

- Qualquer redução de distância atribuível a `chase`.
- Correção para dentro/fora de `kiteRange`.
- Sorteio de `random_move` restrito às opções ativas.

## Causa técnica já registrada

`rpm-combat-runtime.cjs:676` aceita só `hotkey`/`talk`/`combo`; `walk` de
combate lança erro. `engine-runtime.cjs` pausa o walker no status `combat`.
Sem mexer nos dois, nenhum dos três modos pode mover o treinador.
