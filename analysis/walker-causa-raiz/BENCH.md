# Bancada offline do walker

Execute na raiz com Node 22. As nove simulações usam o `runFrameTick` do clone, o A* do projeto, um relógio virtual com tick de 50 ms e um adaptador que só altera dados em memória. O mundo publica sua posição a cada 5 s. O transporte simulado aceita instantaneamente as ordens. Os resultados abaixo caracterizam a implementação atual.

```powershell
node tools/walk-bench.cjs --cenario todos --trace local-data/walk-trace.jsonl
node tools/walk-bench.cjs --cenario todos --conferir local-data/walk-trace.jsonl
node tools/walk-bench.cjs --captura local-data/sample-only-2026-11-21.json
node --test tests/walk_bench.test.cjs
node tools/validate.cjs
```

O primeiro comando cria o trace com exclusividade. Se o arquivo já existir, o segundo comando o confere sem sobrescrevê-lo. Para inspecionar um cenário, troque `todos` por um dos nomes da tabela. O modo de captura aceita o formato histórico `samples[{at,pos,id,error}]` com tempo em segundos e seleciona a última amostra disponível a cada 5 s. Erros de leitura registrados aparecem como ausência de jogador. A trajetória gravada continua independente dos comandos emitidos no replay.

## Resultados

| Cenário | Emitidos | Aplicados no mundo | Confirmados por posição | Maior intervalo entre emissões | Descarte simulado |
| --- | ---: | ---: | ---: | ---: | ---: |
| reta | 199 | 199 | 199 | 5 s | 0% |
| reta-exata | 200 | 200 | 200 | 5 s | 0% |
| descarte | 11 | 10 | 10 | 5 s | 9,09% |
| atraso | 10 | 10 | 10 | 20 s | 0% |
| teleporte | 11 | 11 | 10 | 5 s | 0% |
| bloqueio | 10 | 10 | 10 | 5 s | 0% |
| corredor | 8 | 8 | 8 | 5 s | 0% |
| escada | 1 | 1 | 0 | um único envio | 0% |
| multidao | 12 | 10 | 10 | 5 s | 16,67% |

Na reta comum o waypoint aceita chegada a uma casa do destino. Na reta exata o destino é um `safespot` livre. O mundo chegou ao tile 200 em 995 s e o motor concluiu no snapshot seguinte, em 1.000 s. A taxa foi de 12 tiles/min, com 200 buscas A* e eficiência de 1,00 frente ao custo ótimo da reta. O corredor em L, com uma casa de largura, chegou com oito passos e custo ótimo. No atraso, o cenário retém a publicação até 20 s. Na multidão, o mundo retém dois movimentos e continua aceitando comandos. São estímulos artificiais com resultado conhecido.

O trace contém 46.609 linhas. SHA-256 de duas execuções com humanização desligada e os nove cenários na ordem padrão:

```
fc3a320eb7a0050b09a3430f2e0afc23686ec8d733c30bd9aaa0b5471fc3b8f7
```

O replay da captura histórica de 600 amostras executou 3.601 ciclos, selecionou 37 snapshots e emitiu 16 comandos hipotéticos. A correlação entre esses comandos e o movimento histórico é indeterminada.

## Leitura das métricas

`actual` é a última posição publicada. `mundoSimulado` é a posição de referência do simulador e fica nula no replay histórico. `expected` é o destino do pendente exposto pelo motor. `confirmadosPorPosicao` conta coincidência XYZ no próximo snapshot quando houve um único comando no intervalo. A escada muda de Z e aparece como transição de andar, sem confirmação de passo no mesmo plano. No replay histórico, confirmação e descarte ficam nulos.

`buscasGarantidas` conta consultas que exigem busca porque o cache venceu ou recebeu obstáculo. `eficiencia` usa custo ótimo dividido pelo realizado e só existe para chegada exata em geometrias comparáveis. O ótimo foi calculado para cada geometria com os pesos 10/14 do A*. A razão inversa também aparece no resultado. O trace usa `rng: null` com `humanize: false`. O motor atual não expõe um evento específico de unstuck, por isso o campo é nulo.

O limite de 1,5 s falha nas duas retas. Os cenários de descarte e multidão também ultrapassam 2% por construção. O ensaio não mede descarte nem duração de passo no cliente. Ainda não há trace posterior de uma implementação nova.

Na árvore oficial, cinco testes novos da bancada passaram. A validação geral terminou com código 0, incluindo build, smoke e auditoria. O Node registrou 1.103 aprovados e 8 pulados entre 1.111 testes. O Electron registrou 1.111 aprovados. O sampler permaneceu fora desta mudança.
