'use strict';

/**
 * Perfis de executavel aceitos pelo runtime.
 *
 * O cliente e atualizado pelo fornecedor e o hash muda a cada build. Em vez de
 * fixar um unico valor em cada arquivo (o que quebra o pipeline inteiro quando
 * o jogo atualiza), a lista fica aqui e todos consultam este modulo.
 *
 * Regra: um build novo so entra na lista depois de o layout ser VERIFICADO no
 * processo real — offset de tipo, vtables de Creature/Player e leitura de
 * posicao/hp/name/posse. Adicionar hash no achismo derruba a garantia de
 * identidade que protege contra ler a estrutura errada.
 *
 * builds verificados:
 *   473df25c...  build anterior (2026-10 / 2026-11-02)
 *   82eadedc...  build de 2026-11-03 (secoes com nomes ofuscados; layout
 *                confirmado por RTTI no PID 25876, typeOffset 0x186)
 */

const EXECUTABLE_SHA256 = '473df25c1edd23e7464ad3ba9b923a603051a8b4ae8004a95c06402f678294e6';

const SUPPORTED_EXECUTABLE_SHA256 = Object.freeze([
  EXECUTABLE_SHA256,
  '82eadedcba74e368a7b981a11a6a4d20546b490be6bd4565026c2de847554e1c',
  // build 2026-11-20 (exe 32.110.128 bytes). Hash do ARQUIVO como identidade;
  // layout shifted -0x10 verificado no PID 13304.
  '0ec61b0e401396660988943701c0417e7fce87d46a32f0dd641e7c0cf9b1f29e',
  // build 2026-11-22 (exe 32.934.960 bytes). Cadeia do player descoberta em
  // .data no PID 28604; layout de campos identico ao de 20/11.
  '14cad59648656a8f128d1582d9ad7e358a8f421798ccc26ee611ed52cc935ed8',
  // build 2026-11-23 (exe 35.041.840 bytes). Cadeia em .data no PID 33920,
  // verificada no jogo (pos + passo real de 1 tile). Mesmo RVA do 22/11.
  'ed2560a00801b26796d8d666cf46d503a0c25c56075338e9102baef0d2f9c986',
]);

const SUPPORTED = new Set(SUPPORTED_EXECUTABLE_SHA256);

function isSupportedExecutable(sha256) {
  return typeof sha256 === 'string' && SUPPORTED.has(sha256.toLowerCase());
}

/** Perfil de layout por build. Offsets confirmados em processo real. */
const LAYOUTS = Object.freeze({
  '473df25c1edd23e7464ad3ba9b923a603051a8b4ae8004a95c06402f678294e6': Object.freeze({
    typeOffset: '0x186', label: 'build-2026-10',
  }),
  '82eadedcba74e368a7b981a11a6a4d20546b490be6bd4565026c2de847554e1c': Object.freeze({
    typeOffset: '0x186', label: 'build-2026-11-03',
  }),
  '0ec61b0e401396660988943701c0417e7fce87d46a32f0dd641e7c0cf9b1f29e': Object.freeze({
    typeOffset: '0x176', label: 'build-2026-11-20', chainRva: '0x39F8E08',
  }),
  '14cad59648656a8f128d1582d9ad7e358a8f421798ccc26ee611ed52cc935ed8': Object.freeze({
    typeOffset: '0x176', label: 'build-2026-11-22', chainRva: '0x3A03598',
  }),
  'ed2560a00801b26796d8d666cf46d503a0c25c56075338e9102baef0d2f9c986': Object.freeze({
    typeOffset: '0x176', label: 'build-2026-11-23', chainRva: '0x3A03598',
    /* Lista de criaturas: std::vector<Creature*> em .data. O container tem
     * begin/end/cap contiguos; o RVA aponta para o begin. Verificado com
     * 3 amostras a 5 s (Oddish estavel em 2976,2295,7). */
    creatureChainRva: '0x39fb498',
    creatureListKind: 'vector',
    /* Itens de chao/corpos ficam em g_map.m_tileBlocks[0..15] (nao em vetor
     * plano): std::map<uint32, TileBlock> stride 0x10 por andar z; TileBlock em
     * node+0x28 tem 1024 shared_ptr<Tile> ((y&31)*32 + (x&31)); Tile+0x58 e'
     * vector<shared_ptr<Thing>>; Item tem id uint16 em +0xD4. Verificado no
     * PID 15280 com corpo id=4007 em (2963,2268,7). */
    mapTileBlocksRva: '0x3a047d0',
    tileVtableRva: '0x1fdc3b8',
    tileThingsOffset: '0x58',
    tilePosOffset: '0x70',
    itemVtableRva: '0x1fe00c0',
    itemPosOffset: '0x20',
    itemIdOffset: '0xD4',
  }),
});

function layoutFor(sha256) {
  if (typeof sha256 !== 'string') return null;
  return LAYOUTS[sha256.toLowerCase()] || null;
}

module.exports = {
  EXECUTABLE_SHA256,
  SUPPORTED_EXECUTABLE_SHA256,
  isSupportedExecutable,
  layoutFor,
  LAYOUTS,
  chainRvaFor: sha256 => (layoutFor(sha256) || {}).chainRva || null,
  creatureChainRvaFor: sha256 => (layoutFor(sha256) || {}).creatureChainRva || null,
  itemChainRvaFor: sha256 => (layoutFor(sha256) || {}).itemChainRva || null,
  mapTileBlocksRvaFor: sha256 => (layoutFor(sha256) || {}).mapTileBlocksRva || null,
};
