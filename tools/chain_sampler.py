import argparse
import json
import struct
import sys
import time
from pathlib import Path

tools = Path(__file__).resolve().parent
sys.path.insert(0, str(tools))

import scan_creatures as sc
import pointer_scan_entities as pe
import pka_live_session as ls
from tile_items import MAX_TILE_RADIUS, read_tile_items_around

CREATURE_POS = 0x20
CREATURE_ID = 0x4C
CREATURE_NAME = 0x70
CREATURE_HP = 0xB0
CREATURE_CANATTACK = 0xB4
CREATURE_TYPE = 0x176


def _block_name(read, blk, offset):
    raw = blk[offset:offset + 24]
    inline = raw.split(b'\x00', 1)[0]
    if inline and all(32 <= b < 127 for b in inline):
        return inline.decode('utf-8', 'ignore')
    pointer, length = struct.unpack_from('<Q', raw, 0)[0], struct.unpack_from('<Q', raw, 8)[0]
    if not (0x10000 < pointer < 0x7ff000000000):
        return None
    if not (0 < length <= 32):
        heap = read(pointer, 32)
        if not heap:
            return None
        text = heap.split(b'\x00', 1)[0].decode('utf-8', 'ignore')
        return text or None
    heap = read(pointer, int(length))
    if not heap:
        return None
    text = heap.split(b'\x00', 1)[0].decode('utf-8', 'ignore')
    return text or None


def read_creature(read, va):
    blk = read(va, 0x180)
    if not blk or len(blk) < 0x180:
        return None
    x, y, z = struct.unpack_from('<iih', blk, CREATURE_POS)
    if not (0 < x < 65536 and 0 < y < 65536 and 0 <= z < 16):
        return None
    iv = struct.unpack_from('<I', blk, CREATURE_ID)[0]
    hp_byte = blk[CREATURE_HP]
    return {
        'id': iv,
        'name': _block_name(read, blk, CREATURE_NAME),
        'pos': {'x': x, 'y': y, 'z': z},
        'type': blk[CREATURE_TYPE],
        'healthPercent': hp_byte if hp_byte <= 100 else None,
        'canAttack': blk[CREATURE_CANATTACK] != 0,
        'struct_va': hex(va),
    }


def read_player_fast(read, va, expected):
    entity = read_creature(read, va)
    if not entity:
        return None
    if expected and (entity['name'] or '').lower() != expected.lower():
        return None
    return {'id': entity['id'], 'name': entity['name'], 'pos': entity['pos'], 'hp': entity['healthPercent'],
            'healthPercent': entity['healthPercent'], 'struct_va': entity['struct_va']}


def collect_creatures(read, base, chain_rva, kind='vector'):
    """Le a lista de criaturas a partir do qword em chain_rva.

    kind='vector': chain_rva guarda um std::vector<T*> como tres qwords
                   contiguos (begin, end, cap). Percorre [begin, end).
    kind='array' : chain_rva guarda um array de ponteiros terminado em NULL.

    Devolve (lista, disponivel). Lista vazia com disponivel=True e' valido:
    a cadeia existe e nao ha criatura.
    """
    if kind == 'vector':
        raw = read(base + chain_rva, 24)
        if not raw or len(raw) < 24:
            return [], False
        begin, end, cap = struct.unpack('<QQQ', raw)
        if not (0x10000 < begin < 0x7ff000000000):
            return [], True
        if not (0x10000 < end < 0x7ff000000000) or end < begin:
            return [], True
        nbytes = end - begin
        if nbytes == 0:
            return [], True
        if nbytes % 8 or nbytes > 512 * 8:
            return [], True
        dados = read(begin, nbytes)
        if not dados or len(dados) != nbytes:
            return [], False
        encontrados = []
        for i in range(nbytes // 8):
            p = struct.unpack_from('<Q', dados, i * 8)[0]
            if not (0x10000 < p < 0x7ff000000000):
                continue
            ent = read_creature(read, p)
            if ent:
                encontrados.append(ent)
        return encontrados, True

    raw = read(base + chain_rva, 8)
    if not raw or len(raw) < 8:
        return [], False
    inicio = struct.unpack('<Q', raw)[0]
    if inicio == 0:
        return [], True
    if not (0x10000 < inicio < 0x7ff000000000):
        return [], False
    encontrados = []
    for i in range(200):
        ponteiro = read(inicio + i * 8, 8)
        if not ponteiro or len(ponteiro) < 8:
            break
        p = struct.unpack('<Q', ponteiro)[0]
        if p == 0:
            break
        if not (0x10000 < p < 0x7ff000000000):
            break
        ent = read_creature(read, p)
        if not ent:
            break
        encontrados.append(ent)
    return encontrados, True


def main():
    parser = argparse.ArgumentParser(description='Streams player telemetry from a pointer chain.')
    parser.add_argument('--pid', type=int, required=True)
    parser.add_argument('--name', default=None)
    parser.add_argument('--chain-rva', type=lambda v: int(v, 0), required=True)
    parser.add_argument('--pos-offset', type=lambda v: int(v, 0), default=0x20)
    parser.add_argument('--id-offset', type=lambda v: int(v, 0), default=0x4C)
    parser.add_argument('--name-offset', type=lambda v: int(v, 0), default=0x70)
    parser.add_argument('--hp-offset', type=lambda v: int(v, 0), default=0xB0)
    parser.add_argument('--canattack-offset', type=lambda v: int(v, 0), default=0xB4)
    parser.add_argument('--type-offset', type=lambda v: int(v, 0), default=0x176)
    parser.add_argument('--creatures', action='store_true',
                       help='inclui creatures[] quando --creature-chain-rva for dado')
    parser.add_argument('--creature-chain-rva', type=lambda v: int(v, 0), default=None)
    parser.add_argument('--creature-list-kind', choices=('vector', 'array'), default='vector')
    parser.add_argument('--creature-pos-offset', type=lambda v: int(v, 0), default=CREATURE_POS)
    parser.add_argument('--creature-id-offset', type=lambda v: int(v, 0), default=CREATURE_ID)
    parser.add_argument('--items', action='store_true',
                        help='inclui items[] quando --tile-blocks-rva for dado')
    parser.add_argument('--tile-blocks-rva', type=lambda v: int(v, 0), default=None)
    parser.add_argument('--tile-radius', type=int, default=2)
    parser.add_argument('--interval-ms', type=int, default=5000)
    parser.add_argument('--once', action='store_true')
    args = parser.parse_args()
    tile_radius = max(0, min(int(args.tile_radius), MAX_TILE_RADIUS))

    layout = sc.Layout(pos_offset=args.pos_offset, id_offset=args.id_offset,
                       name_offset=args.name_offset, hp_offset=args.hp_offset,
                       canattack_offset=args.canattack_offset, type_offset=args.type_offset)
    filters = sc.Filters()
    chains = ((args.chain_rva, ()),)
    interval = max(0.05, args.interval_ms / 1000.0)

    frame = 0
    handle = None
    base = None
    # O protocolo anti-ban exige abortar quando a leitura para de funcionar:
        # 3 amostras nulas seguidas com o processo ainda vivo, ou processo morto.
        # Sem isto o sampler imprime null para sempre e mascara PID invalido.
    nulls_seguidos = 0
    ABORTO_NULLS = 3
    while True:
        started = time.time()
        player = None
        creatures = []
        creatures_available = False
        items = []
        items_available = False
        try:
            if not handle:
                handle = sc.k32.OpenProcess(sc.PROCESS_QUERY_INFORMATION | sc.PROCESS_VM_READ, False, args.pid)
            if handle and not base:
                modules = [m for m in pe.enum_modules(args.pid)
                           if m['name'].lower().startswith('pokealliance')
                           and 'launcher' not in m['name'].lower()]
                base = modules[0]['base'] if modules else None
            if handle and base:
                read = lambda va, n: sc.read_mem(handle, va, n)
                raw_chain = read(base + args.chain_rva, 8)
                if raw_chain and len(raw_chain) == 8:
                    player = read_player_fast(read, struct.unpack('<Q', raw_chain)[0], args.name)
                if args.creatures and args.creature_chain_rva is not None:
                    creatures, creatures_available = collect_creatures(read, base, args.creature_chain_rva, args.creature_list_kind)
                if args.items and args.tile_blocks_rva is not None and player and player.get('pos'):
                    pos = player['pos']
                    res = read_tile_items_around(read, base, args.tile_blocks_rva, (pos['x'], pos['y'], pos['z']), radius=tile_radius)
                    items = res['items']
                    items_available = res['available'] is True
        except Exception as error:
            print(json.dumps({'seq': frame, 'error': str(error)}), flush=True)
            player = None
        frame += 1
        payload = {'seq': frame, 'sampledAtMs': int(time.time() * 1000),
                   'pid': args.pid, 'player': player}
        if args.creatures:
            payload['creatures'] = creatures
            payload['creaturesAvailable'] = creatures_available
        if args.items:
            payload['items'] = items
            payload['itemsAvailable'] = items_available
        if not handle:
            payload['abort'] = 'open-process-failed'
        print(json.dumps(payload), flush=True)
        if args.once:
            return

        # Protocolo anti-ban: abortar quando a leitura deixa de funcionar.
        if not handle:
            print(json.dumps({'seq': frame, 'fatal': 'OpenProcess negado',
                              'sampledAtMs': int(time.time() * 1000)}), flush=True)
            return 3
        if player is None:
            nulls_seguidos += 1
            if nulls_seguidos >= ABORTO_NULLS:
                print(json.dumps({'seq': frame, 'fatal': '3 amostras null seguidas',
                                  'abort': 'null-streak',
                                  'sampledAtMs': int(time.time() * 1000)}), flush=True)
                return 4
        else:
            nulls_seguidos = 0

        delay = interval - (time.time() - started)
        time.sleep(delay if delay > 0 else 0)


if __name__ == '__main__':
    main()
