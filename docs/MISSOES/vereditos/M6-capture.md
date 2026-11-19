# M6 — Captura com efeito no corpo correto

Sessão: `00-sessao-2026-11-19.md`.

## Pré-requisitos e o que faltou

- Corpo elegível identificável: **não**. O pulso `kind 5` desta DLL publica
  `"items":[]` e `"tiles":[]` fixos
  (`native/pka_native.c:2111`), e corpos não aparecem em `creatures` depois da
  morte — o alvo simplesmente some do array (`local-data` desta sessão: alvo
  `1076951776` Magnemite some após 7 `attack`, sem id de corpo).
- Ball configurada: **não**. O perfil `Default` está com
  `looting.captureEnabled: false` e `captureEntries: []`.
- Janela de observação contínua do corpo: **não** há como, pelo canal, porque o
  corpo não é publicado.

## Tentativa

1. Alvo escolhido (`1076951776`), 7 comandos `attack` a 1–2 tiles: HP 100 → 72
   e o alvo sai da telemetria.
2. `items` permaneceu `[]` em todas as amostras; sem `itemId` não há como montar
   `useWith` (o encoder exige `itemId`, `targetId` e `stack`,
   `reconstruction/protocol.cjs:99`).

## Veredito

`BLOQUEADO` **na medição original**; desbloqueado como instrumento na mesma
sessão.

O que foi corrigido depois da medição:

- `kind 5` agora publica `items[]` com `id`, `corpseId`, `stack` e `pos`,
  alimentados por um cache de corpos (selvagem que sumiu da varredura, TTL 60 s).
  Confirmado em jogo: corpo adjacente aparece na lista logo após a morte.
- `useWith` e `recallPokemon` deixaram de cair em `STATUS_UNSUPPORTED`, são
  declarados no contrato e tiveram handler (tecla opcional, clique projetado no
  corpo, slot da barra configurável por `stack`).
- `tools/live_capture_channel.cjs` executa matar → achar corpo → `useWith` e
  grava evidência.

O efeito de captura **ainda não foi observado**: 6 combinações (slots
2/5/6/9/11/17, clique direito) deixaram o corpo em `items[]`. Falta confirmar
visualmente qual gesto o cliente exige — ver `docs/MISSOES/TESTE_VISUAL_M6_M7.md`.

## O que NÃO foi provado

- Efeito de captura, consumo de ball, mensagem ao jogador.
- Qual slot/hotkey seleciona a bola e se o clique deve ser esquerdo ou direito.

## Deviations from the captured protocol

- `useWith.targetId` aceita u32 (id de criatura); o original só aceita
  ≤ 65535. Vetores 3248..3251 marcados como relaxados no teste diferencial.
- `items[].container` é opcional e `items[].id` aceita u32; vetores de telemetria
  com item sem `container`/com id grande ficam fora do diferencial.
