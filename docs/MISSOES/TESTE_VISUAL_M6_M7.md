# Teste visual — captura (M6) e lure/recall (M7)

O que está pronto: o canal passou a publicar **corpos** (`items[]` com
`corpseId`, `pos`) e a aceitar `useWith`/`recallPokemon`. Falta o aceite visual
de qual gesto o cliente exige para capturar; o botão/clique é o parâmetro que
precisa ser confirmado com olho humano.

## Preparação

1. Abra o jogo pelo executável, entre no personagem e deixe um selvagem vivo a
   1–2 tiles do seu Pokémon.
2. Injete apenas o bot:
   `native\pka_inject.exe --pid <PID> --dll native\pka_native.dll`
3. Confirme a prontidão: `node tools/live_preflight.cjs --verify` (com
   `PKA_PID` e `PKA_CHANNEL_KEY`).

## Roteiro

```
# 1. mata o selvagem mais próximo e espera o corpo aparecer em items[]
node tools/live_capture_channel.cjs --pid <PID> --kill --slot 9

# 2. se não capturar, teste os outros gestos:
node tools/live_capture_channel.cjs --pid <PID> --slot 17
node tools/live_capture_channel.cjs --pid <PID> --slot 0     # só clica no corpo
node tools/live_capture_channel.cjs --pid <PID> --slot 9 --item-id 28380
node tools/live_capture_channel.cjs --pid <PID> --key 7      # tecla + clique
```

- `--slot N` clica esse slot da barra de ações (1..20) antes de clicar no corpo.
- `--slot 0` não clica slot: só aponta o corpo (use quando a bola já estiver
  selecionada).
- `--key K` inclui uma tecla (Pokébar) além do clique.
- Cada execução grava `local-data/capture-channel-<stamp>.json` com o corpo,
  distância, respond do ACK e a série de `items`.

## O que olhar na tela

| gesto | o que deve acontecer |
| :--- | :--- |
| slot correto + clique no corpo | animação da bola e o corpo vira Pokémon capturado |
| slot errado | nada, ou o personagem usa outra coisa |
| clique sem bola selecionada | nada |

Anote **qual slot** produziu a captura e se foi clique esquerdo ou direito. Com
esse dado o default do `useWith` fecha.

## Recall (pet preso)

`useWith`/`recallPokemon` agora são aceitos pelo executor. Para testar o
recall: afaste o pet, mande `recallPokemon` com a tecla do slot do pet ativo
(ex.: `7` para Togepi) e confirme na tela se ele volta para a ball.

## Limites desta entrega

- A captura **ainda não foi confirmada por efeito**: o corpo continua em
  `items[]` nas 6 combinações tentadas (slots 2/5/6/9/11/17, clique direito).
  Por isso o parâmetro é justamente o que este teste resolve.
- M7 (lure) segue sem medição: depende do pet acoplado e de configuração de
  lure, que só rodam com o pet próximo.
- Distância em pixels é projetada por `72,36 * largura/1920`; janela pequena
  (800 px) dá ~30 px/tile. Se o clique cair fora do tile, o log
  `%TEMP%\pka_native.log` registra `clique=(x,y)` — compare com o que aparece
  na tela.
