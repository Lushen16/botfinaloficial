"""Leitura de itens no chao via g_map.m_tileBlocks[z] -> Tile+0x58 -> Item+0xD4.

Requer zero varredura de secoes: caminha somente a RB-tree do andar do player
e le ate <=4 blocos de 16 KB (radius=2) por amostra.
"""
import struct

DEFAULT_TILE_BLOCKS_RVA = 0x3a047d0
TILE_VTABLE_RVA = 0x1fdc3b8
TILE_THINGS_OFFSET = 0x58
TILE_POS_OFFSET = 0x70
ITEM_VTABLE_RVA = 0x1fe00c0
ITEM_POS_OFFSET = 0x20
ITEM_ID_OFFSET = 0xD4
MAX_TILE_RADIUS = 7


def _valid_ptr(va):
    return 0x10000 < va < 0x7ff000000000


def read_tile_items_around(read, base, tile_blocks_rva, player_pos, radius=2):
    """Le itens visiveis em torno de `player_pos` no mesmo andar `z`.

    Retorna dict com `available` (bool), `items` (lista de `{id, pos, stack, va}`),
    `tileBlocksRva` e `radius`. Lista vazia com `available=True` indica mapa valido
    sem itens no raio.
    """
    radius = max(0, min(int(radius), MAX_TILE_RADIUS))
    meta = {
        'tileBlocksRva': hex(tile_blocks_rva),
        'tileVtableRva': hex(TILE_VTABLE_RVA),
        'tileThingsOffset': hex(TILE_THINGS_OFFSET),
        'tilePosOffset': hex(TILE_POS_OFFSET),
        'itemVtableRva': hex(ITEM_VTABLE_RVA),
        'itemPosOffset': hex(ITEM_POS_OFFSET),
        'itemIdOffset': hex(ITEM_ID_OFFSET),
        'radius': radius,
    }
    if not player_pos:
        return {**meta, 'available': False, 'items': []}

    px, py, pz = int(player_pos[0]), int(player_pos[1]), int(player_pos[2])
    if not (0 < px < 65536 and 0 < py < 65536 and 0 <= pz < 16):
        return {**meta, 'available': False, 'items': []}

    raw_map = read(base + tile_blocks_rva + pz * 0x10, 16)
    if not raw_map or len(raw_map) < 16:
        return {**meta, 'available': False, 'items': []}
    head, sz = struct.unpack('<QQ', raw_map)
    if not _valid_ptr(head) or sz > 256:
        return {**meta, 'available': False, 'items': []}
    hnode = read(head, 0x18)
    if not hnode or len(hnode) < 0x18:
        return {**meta, 'available': False, 'items': []}
    root = struct.unpack_from('<Q', hnode, 8)[0]

    needed_keys = {
        (((py + dy) >> 5) << 11) | ((px + dx) >> 5)
        for dy in range(-radius, radius + 1)
        for dx in range(-radius, radius + 1)
    }
    blocks = {}
    queue, seen = [root], {head, 0}
    while queue and len(blocks) < len(needed_keys) and len(seen) < 128:
        cur = queue.pop(0)
        if cur in seen or not _valid_ptr(cur):
            continue
        seen.add(cur)
        nb = read(cur, 0x30)
        if not nb or len(nb) < 0x30 or nb[0x19]:
            continue
        left, _, right = struct.unpack_from('<QQQ', nb, 0)
        key = struct.unpack_from('<I', nb, 0x20)[0]
        if key in needed_keys:
            arr = read(cur + 0x28, 1024 * 16)
            if arr and len(arr) == 1024 * 16:
                blocks[key] = arr
        queue.extend([left, right])

    tile_vt_expected = base + TILE_VTABLE_RVA
    item_vt_expected = base + ITEM_VTABLE_RVA
    items = []
    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            tx, ty = px + dx, py + dy
            arr = blocks.get(((ty >> 5) << 11) | (tx >> 5))
            if not arr:
                continue
            tptr = struct.unpack_from('<Q', arr, ((ty & 31) * 32 + (tx & 31)) * 16)[0]
            if not _valid_ptr(tptr):
                continue
            tb = read(tptr, 0x80)
            if not tb or len(tb) < 0x80:
                continue
            if struct.unpack_from('<Q', tb, 0)[0] != tile_vt_expected:
                continue
            if struct.unpack_from('<iih', tb, TILE_POS_OFFSET) != (tx, ty, pz):
                continue
            bg, en, cp = struct.unpack_from('<QQQ', tb, TILE_THINGS_OFFSET)
            if not (_valid_ptr(bg) and bg < en <= cp and (en - bg) <= 1024 and (en - bg) % 16 == 0):
                continue
            things = read(bg, en - bg)
            if not things:
                continue
            for stack in range(len(things) // 16):
                th = struct.unpack_from('<Q', things, stack * 16)[0]
                if not _valid_ptr(th):
                    continue
                ob = read(th, 0xE0)
                if not ob or len(ob) < ITEM_ID_OFFSET + 2:
                    continue
                if struct.unpack_from('<Q', ob, 0)[0] != item_vt_expected:
                    continue
                ix, iy, iz = struct.unpack_from('<iih', ob, ITEM_POS_OFFSET)
                item_id = struct.unpack_from('<H', ob, ITEM_ID_OFFSET)[0]
                if (ix, iy, iz) == (tx, ty, pz) and item_id > 0:
                    items.append({
                        'id': item_id,
                        'pos': {'x': ix, 'y': iy, 'z': iz},
                        'stack': stack,
                        'va': hex(th),
                    })
    return {**meta, 'available': True, 'items': items}
