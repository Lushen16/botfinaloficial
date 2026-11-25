# Brief para reescrita da engine 3.0 (modo anti-ban por cadeia de ponteiros)

Cole este arquivo inteiro no GPT junto com o pedido: "reescreva o bot conforme
este brief, mantendo a interface atual". Ele tem o que foi medido, o que é
proibido e onde mexer.

## Objetivo

Deixar o bot funcional no cliente atual (build 21/11) **sem varredura de
memória** e **sem injeção**, com telemetria por cadeia de ponteiros e entrada
por `PostMessageW`. Base: `C:\Users\yago\Documents\Clone\RECONSTRUÇAO OFIcial`
(também copiada em `PokeBOT 3.0`).

## Evidência medida (não contradizer sem nova medição)

Todos os testes numa conta nova, um cliente, personagem parado, nada mais
rodando. O ban aparece no título da janela minutos depois.

| exposição | tempo | resultado |
| :--- | :--- | :--- |
| nada rodando | 15 min | safe |
| handle aberto, 0 leitura | 10 min | safe |
| 4 bytes na base do módulo @ 0,2 Hz | 10 min | safe |
| cadeia + nome + pos + hp @ 0,2 Hz | 15 min | safe |
| 2 passos por `PostMessageW` + cadeia @ 0,2 Hz | 10 min | safe |
| posição a 300 ms (3,3 Hz) | 10 min | **ban** |
| varredura de toda a memória (105 MB) | minutos | **ban** |
| crawl de containers 1×/s | 3,5 min | **ban** |

Regra: **o gatilho é a varredura do espaço de endereço**. `ReadProcessMemory`
em si é seguro em taxa baixa. Nada de varrer em loop; nada de RTTI scan; nada
de `VirtualQueryEx` sobre o processo inteiro em produção.

O Shiba é 100% externo (walker ativo: 98 módulos, todos do jogo/sistema; 73
threads, todas dentro de módulos; nenhum PE ou thread injetada). Não copiar
injeção de DLL — foi banida 4 vezes.

## Endereços do build atual

- Imagem: `PokeAlliance_dx.exe`, 32.110.128 bytes,
  sha256 `0ec61b0e401396660988943701c0417e7fce87d46a32f0dd641e7c0cf9b1f29e`.
- Base do módulo: `Toolhelp32Snapshot` + `Module32FirstW` (`PokeAlliance_dx.exe`).
- Cadeia direta do player: RVA **0x39F8E08** → ponteiro do struct (`.data`).
- Layout do struct:
  - `pos` = `+0x20`, `int32 x, y` + `int16 z`
  - `id` = `+0x4C` (`uint32`, família `0x1000xxxx` para player)
  - `name` = `+0x70` — `std::string`: ≤15 bytes inline (SSO); maior guarda
    ponteiro em `+0x0` e tamanho em `+0x8` (heap)
  - `hp` = `+0xB0` (`uint8`, 0..100)
  - `canAttack` = `+0xB4`
  - `type` = `+0x176`
- O RVA muda a cada build: guardar `{sha256 → rva, offsets}` em
  `reconstruction/executable-profile.cjs` e recusar rodar se o hash não bater.

## Entrada

- `PostMessageW` funciona sem foco (jogo minimizado/atrás): `WM_KEYDOWN 0x100` +
  `WM_KEYUP 0x101` com scan codes de seta `0x48/0x4D/0x50/0x4B`, lparam
  `1 | (scan<<16)` e `|0xC0000000` no keyup. Implementado em
  `tools/walker_input.py` (validado: `x 2961→2962→2963` em segundo plano).
- `PKA_EXECUTOR_MODE=background` continua recusando por desenho; o modo normal
  não exige foco.
- Mouse (`WM_LBUTTONDOWN/UP` com `lParam` em coordenadas de cliente) é o
  caminho para o walker de clique; validar efeito por mudança de posição.

## Arquitetura alvo

1. **`TelemetryProvider` (novo)**: abre o processo uma vez, resolve a base do
   módulo, lê a cadeia do player a cada `intervalMs` (padrão 5000 ms; mínimo
   2000 ms) e publica `{pos, hp, id, name}`. Proibido varrer. Falha de leitura
   não deve derrubar o processo.
2. **`CreatureListProvider`**: falta a cadeia da lista de criaturas. Descobrir
   UMA vez numa conta de teste lendo só a seção `.data` do módulo (~4 MB),
   guardar o RVA no perfil do build e nunca varrer em produção. Enquanto não
   existir, a engine roda em modo "cego": anda pela rota e usa só a posição.
3. **`InputSink`**: `PostMessageW` (teclado e clique). Sem `SendInput`, sem
   `keybd_event`.
4. **Engine**: tick de decisão 300 ms; cadência do walker 300 ms (mediana do
   Shiba: 302 ms, p90 603 ms, 22 % diagonais); jitter 0,82–1,28×; respiro em
   ~20 % dos passos. A* (`reconstruction/pathfinder.cjs`) continua.
5. **Loop único**: amostragem e decisão no mesmo relógio; nenhuma thread extra
   tocando memória.

## O que mudar no código

- `reconstruction/engines/walker-engine.cjs`: remover qualquer dependência de
  varredura; consumir posição do novo provider.
- `reconstruction/automation.cjs`: trocar o caminho "scan + snapshots" pelo
  provider de cadeia.
- `reconstruction/executable-profile.cjs`: versionar por sha256 do build.
- `tools/pka_live_session.py`: já usa `DEFAULT_CHAINS`; **atualizar**
  `DEFAULT_CHAINS` para `((0x39F8E08, ()),)` e o layout para os offsets acima
  (feito em `_resolve_name_field` para nome SSO/ponteiro).
- `tools/light_probe.py`: adicionar `--chain-rva` para localizar o player sem
  scan (hoje `--limited` ainda varre).
- Remover do caminho de produção: `scan_creatures.py`, `find_vtable_refs`,
  `crawl`, `iter_regions` sobre o processo inteiro.

## Testes que precisam passar

- `node tools/validate.cjs` (build, 1009 testes Node/Electron, smoke, audit).
- Novo teste: provider lê posição por cadeia e **nunca** chama varredura
  (mock de leitura conta endereços; falhar se algum endereço < base do módulo
  ou se mais de N leituras por amostra).
- Novo teste: nome SSO (≤15 bytes) e nome heap (>15 bytes) resolvem.
- Novo teste: hash do build errado → recusa explícita, sem fallback de scan.
- Walker: suíte existente (`tests/walker_*`), incluindo ordem de amostras.

## Limites de evidência (não afirmar como provado)

- Não há medição de caça real (matar monstro) com o modelo novo.
- Não há cadeia de criaturas ainda.
- Fluidez no jogo com telemetria real e tempo entre passos não medidos.
- Não se sabe se `PostMessageW` de clique em coordenada de cliente é tão seguro
  quanto o teclado; medir antes de produção.
