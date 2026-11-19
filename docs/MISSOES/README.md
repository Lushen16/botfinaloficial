# Missões para o Codex

Toda missão desta pasta é executada por um agente que **não conhece o histórico
da conversa**. O brief precisa ser autossuficiente e o veredito, atribuível.

Leia antes de escrever ou executar: `AGENTS.md` (fronteiras), `HANDOFF.md`
(estado) e `docs/PROTOCOLO_VALIDACAO.md` (fases e critérios).

## Regras de missão

1. **Uma entrega por missão.** Não agregue fases.
2. **Critério de efeito, não de superfície.** `status 0`, botão habilitado e
   teste verde não provam jogo.
3. **Nomeie a ferramenta e os argumentos.** "Use o mecanismo disponível" é
   ambíguo e já levou ao validador errado.
4. **Pré-condição explícita.** PID, arquivo de chave, nome do personagem, DLL
   atual, ausência de `pka_tap.dll`/`msftedit.dll`, foco.
5. **Evidência em arquivo**, produzida pela ferramenta, não stdout.
6. **Sem commit** salvo pedido explícito.
7. **Falhou é resultado.** Não repita a tentativa para "conseguir" um verde.
8. Se o brief estiver ambíguo, escolha a leitura mais conservadora e registre
   a decisão no veredito.

## Classificação obrigatória

| veredito | quando |
| :--- | :--- |
| `CONFIRMADO` | efeito observado e todos os gates de sanidade verdadeiros |
| `FALHOU` | medição suficiente e efeito ausente/errado |
| `INCONCLUSIVO` | sessão, telemetria ou foco não permitiram medir |
| `BLOQUEADO` | pré-condição de entrada não atendida (F1, chave, PID) |

`BLOQUEADO` e `INCONCLUSIVO` não são falha do produto. Confundir os três é o
erro mais caro do projeto.

Quando a missão tiver mais de uma dimensão (ex.: efeito × trajetória), classifique
cada uma e use **a mais fraca** como veredito geral. Campo que o instrumento não
mede é declarado `INDISPONÍVEL`, nunca inferido.

Recusa explícita do executor (`status 4`/`5`) é "não executou", não "executou e
falhou": registre o `status` cru e não transforme em falha de efeito.

## Execução

```
powershell -ExecutionPolicy Bypass -File tools\codex_pka.ps1 -Mission docs\MISSOES\F2-A-passo-caminhada.md
```

O launcher aplica o perfil `pka` (`~/.codex/pka.config.toml`), fixa o diretório
na raiz, herda o PATH (o sandbox filtra `node`/`python` sem isso), grava
transcrição e veredito em `local-data/codex/`. Missão só de leitura:
`-Sandbox read-only`.

O perfil e os argumentos do launcher valem para `codex exec` (CLI). Na janela do
app, o contrato é o `AGENTS.md` do projeto mais o arquivo de missão — por isso o
brief precisa ser autossuficiente.

O exit code do `codex` não reflete o veredito (ele sai 0 mesmo com `FALHOU`).
Quem decide aceite é o coordenador, lendo o arquivo de veredito.

Escrito o veredito, o coordenador confere contra a seção "Aceite" do brief e
contra a seção 3 (`Fronteira de evidência`) antes de aceitar.
