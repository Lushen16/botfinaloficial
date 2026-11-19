# F2-A — um passo de caminhada no cliente real

Missão de validação. **Não altera código.** Não avança para ataque, auditoria de
interface ou rota.

Leia antes: `docs/PROTOCOLO_VALIDACAO.md` (F1 e a parte de caminhada do F2) e
`docs/MISSOES/README.md` (classificação).

## Escopo

Uma única tentativa de `walk`. O entregável é um veredito **de duas dimensões**:
efeito (delta líquido) e trajetória (série temporal). Não invente uma dimensão
que o instrumento não mede.

### Limites conhecidos do instrumento (leia antes de classificar)

- `--test=A` lê a posição **antes** e **depois**; não grava série. Um passo extra
  seguido de retorno escapa dessas duas leituras.
- `--confirm` é asserção do operador. O teste A **não mede foco no instante do
  envio**. Perda de foco aparece como `status 5`.
- `live_probe.py modhash` devolve `loadedImageSha256` (imagem) e
  `fileOnDiskSha256` (arquivo lido agora). Se a DLL for recompilada depois da
  injeção, os dois arquivos comparados são o **mesmo arquivo atual** e a
  igualdade não prova imagem carregada nova.
- `%TEMP%\pka_observe_hz.txt` define a cadência pretendida da DLL; o teste A **não
  registra** os intervalos efetivamente recebidos.

## Pré-condições — todas obrigatórias

- Cliente `PokeAlliance_dx.exe` reiniciado **depois do último build** da
  `native/pka_native.dll`. Verificar de fato:
  `(Get-Item native\pka_native.dll).LastWriteTime` **anterior** ao `StartTime`
  do processo do jogo. Se a DLL for mais nova que o processo, a imagem carregada
  é velha → `BLOQUEADO`.
- Interface Electron fechada e menu PKA Tools encerrado: sem `pka_tap.dll` nem
  `msftedit.dll` no processo (o validador aborta).
- `native/pka_player_name.txt` igual ao personagem logado.
- `%TEMP%\pka_observe_hz.txt` contendo `20`.
- Jogo em primeiro plano, personagem parado, hp > 0, nenhuma outra fonte de
  movimento ativa.
- Tile vizinho na direção escolhida **livre e no mesmo andar** (sem criatura,
  item ou escada).

Pré-condição falhou ou F1 não-verified → `BLOQUEADO` com a condição observada.
Não execute a tentativa nesse caso.

## Procedimento

1. **F1.** Definir `PKA_PID` e rodar `node tools/live_preflight.cjs --verify`.
   Aceite somente `status: "verified"`. Preserve `live-preflight.json`.
2. **Identidade.** Registrar `pid`, caminho do executável, `StartTime`, `mtime`
   da DLL, `loadedImageSha256`, `loaderFileSha256` e `diskFileSha256`.
3. **Posição inicial.** Usar a amostra do validador (RPM e canal coerentes).
   Registrar horário de parede e `tick`.
4. **Direção.** Uma cardinal: `north [0,-1]`, `east [1,0]`, `south [0,1]`,
   `west [-1,0]`.
5. **Tentativa única:**
   `node tools/live_walk_validate.cjs --pid <PID> --direction <dir> --test=A --confirm`
   Não repetir em caso de falha.
6. **Observar** toda a janela prevista, preservando as amostras.

## Classificação

Dois eixos independentes. O veredito geral é o **mais fraco** dos dois.

### Efeito (delta líquido)

- `CONFIRMADO`: leituras válidas, mesma entidade, delta exato em `(x,y)` e `z`
  intacto.
- `FALHOU`: leituras válidas e mesma entidade, mas delta zero, errado ou `z`
  mudou.
- `INCONCLUSIVO`: leitura antes/depois inválida, entidade trocada, `settle`
  do canal falhou.

### Trajetória (série na janela)

- `CONFIRMADA`: existe série da mesma sessão que sustenta um único passo e
  nenhum passo extra.
- `INCONCLUSIVA`: só existem as duas leituras. **É o esperado com este
  instrumento.**

### Execução / entrega

- Recusa explícita do executor: registrar `status` cru e `message`
  separadamente. `status 4` e `status 5` **não** são falha de delta — a ação não
  chegou a ser executada.
- ACK expirado: a ferramenta rotula como "dispatcher recusou" e devolve
  `dispatchError.status` nulo. Distinguir pela mensagem (`ACK expirou`) e tratar
  como **entrega indeterminada** (`INCONCLUSIVO`), preservando a evidência.

`--confirm` sem medição de foco e `status 5` → `INCONCLUSIVO`, não `FALHOU`.
O ACK vai no relatório como diagnóstico de entrega, nunca como efeito.

## Entrega

- veredito de efeito e de trajetória, separados;
- resultado de F1 e caminho do `live-preflight.json`;
- `pid`, caminho do exe, `StartTime`, `mtime` da DLL e os três hashes;
- posição inicial e final com `tick` e horário;
- delta esperado e observado; `sameEntity`;
- número de comandos, `dispatchDelivery` e `status`/`message` se houver recusa;
- janela medida e cadência efetiva **declarada como indisponível** se não houver
  série;
- caminho de `local-data/walk-validation-<stamp>.json` e de
  `%TEMP%\pka_native.log`.

Se `FALHOU` ou `INCONCLUSIVO`: primeira divergência e a menor checagem capaz de
esclarecer. Encerrar após a medição.

## Aceite

Veredito com os dois eixos, caminhos de evidência preenchidos e campos
indisponíveis marcados como tais. `CONFIRMADO` de efeito só com delta exato,
mesma entidade e `z` intacto. Trajetória só é `CONFIRMADA` com série; duas
leituras nunca bastam.
