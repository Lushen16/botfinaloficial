# Shiba walker medido — 2026-11-20

Fonte: `local-data/shiba-walker-sample-2026-11-20.json` (400 amostras de posição
a 100 ms, PID 24668, personagem Picararara, Shiba v3.3.8 com walker ligado).

## Números

- 101 posições consecutivas distintas contando a inicial: 100 mudanças de tile em cerca de 40 s.
- Intervalo entre passos: mín 100 ms, **mediana 302 ms**, p90 603 ms, máx 1306 ms.
- **22 % dos passos são diagonais** (dx=1 e dy=1), 78 % cardinais.
- 23 de 99 intervalos entre mudanças acima de 600 ms. A posição não distingue pausa programada, atraso do cliente ou outra causa.

## Conclusão de arquitetura

- Shiba **não injeta nada**: cliente oficial sem DLL extra (84 módulos, só os do
  jogo + sistema; nenhum PE manual-mapped além de 2 blobs de recurso 32-bit).
- O bot é processo externo (Electron, `--client-pid`), cliente do canal que o
  **jogo** cria (`pka-runtime-2-<pid>` / `pka-security-<pid>`).

## Diferenças com o nosso walker (antes dos ajustes)

| item | Shiba | nosso |
| :--- | :--- | :--- |
| cadência | ~300 ms | 406 ms fixos |
| diagonais | 22 % dos passos | só quando o guloso pede |
| pausas | distribuídas (23 % > 600 ms) | micro-pausas 4 % (humanize) |
| caminho | por mapa (OTMM), contorna obstáculo | A* quando há mapa; guloso sem |
| processo | externo, sem DLL | DLL injetada |

## Ajustes e pendências

1. O motor do clone já usa intervalo-base de 300 ms; isso não mede o intervalo observado no jogo.
2. O planejador testa atalhos em linha reta nos próximos 16 passos do A*. Só suaviza em tiles conhecidos e livres, incluindo as duas laterais de cada diagonal. Validação em mapas de teste, não no jogo.
3. Pausas: política existente inalterada; a causa dos intervalos longos não foi medida.
4. Cliente externo sem DLL: pendente. O EPIPE relatado não identifica sozinho qual etapa da conexão falhou.
