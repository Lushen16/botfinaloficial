# Diagnóstico dos bans — 21/11/2026

## P0 — Preservar a cronologia
Suspender ensaios no servidor. Nos registros das seis contas, separar início do scanner, primeira leitura válida, intenção de entrada, despacho, movimento observado e aviso de ban. Anotar fonte e relógio; evento sem registro é desconhecido, não negativo.

## P1 — Uma verificação por hipótese, em ordem de investigação
1. **Componente comum, especialmente o scanner.** Nas duas pilhas, conferir se há leitura anterior ao aviso. Resultado positivo confirma exposição comum, não causalidade. Um registro completo sem tentativa de leitura antes da decisão exclui RPM daquela execução como condição necessária.
2. **Decisão anterior ao aviso.** Se houver registro do operador com horário da decisão, comparar com o início da sessão. Decisão anterior exclui a sessão corrente como gatilho. Sem esse dado, os ~12 s medem tempo até o aviso, não latência do detector.
3. **Entrada ou movimento.** Na execução travada, localizar a falha em relação à primeira chamada de entrada. Falha comprovadamente anterior a qualquer despacho exclui o clique daquela execução como condição necessária; ausência de confirmação posterior não exclui despacho. Seis passos no outro caso não identificam padrão de cadência.

## P2 — Instrumentar antes de trocar componentes
Implementar primeiro replay offline com telemetria de fixture e atuador que apenas registra intenções. Sem fixture, abortar; nunca abrir scanner ou enviar entrada como fallback. Marcar efeito simulado separadamente. Não alterar foco, cadência, pathfinder ou autowalk com base nesses bans.

**Shiba:** pipes que aparecem e somem com o app não identificam a origem da telemetria nem o executor das ações. O comentário em `tools/live_click_walk.cjs` não é medição de entrada física.

**Parada:** zero contas novas por hipótese. Encerrar quando a cronologia excluir a condição necessária ou os registros não discriminarem as explicações. Janela curta sem ban não valida método. `node --test tests/walker_sample_ordering.test.cjs` verifica ordenação offline, não o anticheat.
