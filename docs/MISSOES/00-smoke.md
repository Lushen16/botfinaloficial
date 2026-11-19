# 00 — Smoke de configuração

Missão de leitura, sem efeito. Serve para provar que o agente está alinhado
antes de qualquer missão real.

Faça, sem editar nada:

1. Leia `AGENTS.md` e `docs/PROTOCOLO_VALIDACAO.md` (só as seções F1 e F2).
2. Rode `node --test tests/walker_box_occupied.test.cjs` e
   `node --test tests/walker_orbit.test.cjs`.
3. Diga em até 10 linhas: quantos testes passaram em cada arquivo, qual o
   caminho do motor de walker que o clone usa e quanto mede o arquivo.

Veredito: `CONFIRMADO` se os dois arquivos terminarem com 0 falhas e você citar
`reconstruction/engines/walker-engine.cjs`; senão `FALHOU`.
