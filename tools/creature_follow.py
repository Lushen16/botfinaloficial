"""A partir do objeto do PLAYER, segue ponteiros procurando a lista de criaturas.

O player e' alcancado por chainRva em .data. Se as criaturas estao no heap,
o player (ou alguem perto dele) tem o ponteiro. Este script le o player,
testa cada qword, e para os que apontam para estruturas validas, continua
1-2 niveis.

Somente leitura de algumas centenas de bytes por objeto.
"""
import ctypes, struct, sys, json
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import scan_creatures as sc
import pointer_scan_entities as pe

POS, ID, NAME, HP, CANATTACK, TYPE = 0x20, 0x4C, 0x70, 0xB0, 0xB4, 0x176
CHAIN_RVA = 0x3A03598


def main():
    pid = int(sys.argv[1])
    h = sc.k32.OpenProcess(sc.PROCESS_QUERY_INFORMATION | sc.PROCESS_VM_READ, False, pid)
    mods = [m for m in pe.enum_modules(pid)
            if m['name'].lower().startswith('pokealliance') and 'launcher' not in m['name'].lower()]
    base = mods[0]['base']
    read = lambda va, n: sc.read_mem(h, va, n)

    raw = read(base + CHAIN_RVA, 8)
    player = struct.unpack('<Q', raw)[0]
    print('player = %#x (rva %#x)' % (player, CHAIN_RVA))

    def ler_ent(va):
        pos = read(va + POS, 10)
        ident = read(va + ID, 4)
        if not pos or len(pos) < 10 or not ident or len(ident) < 4:
            return None
        x, y, z = struct.unpack('<iih', pos)
        if not (0 < x < 65536 and 0 < y < 65536 and 0 <= z < 16):
            return None
        nm_raw = read(va + NAME, 32)
        nm = None
        if nm_raw:
            if nm_raw[0:1] and len(nm_raw) >= 16:
                ln = struct.unpack_from('<Q', nm_raw, 8)[0] if len(nm_raw) >= 16 else 0
                if 0 < ln <= 40:
                    nm = nm_raw[:ln].decode('utf-8', 'ignore')
                    if not all(32 <= ord(c) < 127 for c in nm):
                        nm = None
            if nm is None:
                nm = nm_raw.split(b'\x00', 1)[0].decode('utf-8', 'ignore') or None
        tipo = read(va + TYPE, 1)
        hpr = read(va + HP, 4)
        return {'va': va, 'x': x, 'y': y, 'z': z,
                'id': struct.unpack('<I', ident)[0], 'name': nm,
                'type': tipo[0] if tipo else None,
                'hp': struct.unpack('<I', hpr)[0] if hpr and len(hpr) == 4 else None}

    def dump_qwords(va, n_bytes=0x400, rotulo=''):
        print('\n=== qwords em %s %#x (0x%x bytes) ===' % (rotulo, va, n_bytes))
        dados = read(va, n_bytes)
        if not dados:
            print('  leitura falhou')
            return []
        achados = []
        for off in range(0, len(dados) - 8, 8):
            p = struct.unpack_from('<Q', dados, off)[0]
            if not (0x10000 < p < 0x7ff000000000):
                continue
            ent = ler_ent(p)
            if ent:
                achados.append(ent)
                print('  +%#05x -> %#x ENTIDADE id=%#x pos=(%d,%d,%d) type=%s name=%r' %
                      (off, p, ent['id'], ent['x'], ent['y'], ent['z'], ent['type'], ent['name']))
            else:
                # ponteiro para bloco que parece lista de ponteiros?
                inner = read(p, 16)
                if inner and len(inner) == 16:
                    q1 = struct.unpack_from('<Q', inner, 0)[0]
                    q2 = struct.unpack_from('<Q', inner, 8)[0]
                    if 0x10000 < q1 < 0x7ff000000000 and q1 % 8 == 0:
                        e1 = ler_ent(q1)
                        if e1:
                            print('  +%#05x -> %#x (container?) primeiro=%#x ENTIDADE id=%#x pos=(%d,%d,%d)'
                                  % (off, p, q1, e1['id'], e1['x'], e1['y'], e1['z']))
                            achados.append(dict(e1, viaContainer=p))
        return achados

    todos = []
    todos += dump_qwords(player, 0x400, 'player')

    # se nada, tentar a partir de ponteiros de 2o nivel do player
    if not todos:
        print('\nnenhuma entidade direta; tentando nivel 2...')
        dados = read(player, 0x400)
        for off in range(0, len(dados) - 8, 8):
            p = struct.unpack_from('<Q', dados, off)[0]
            if not (0x10000 < p < 0x7ff000000000):
                continue
            todos += dump_qwords(p, 0x100, 'nivel2(+%#x)' % off)
            if len(todos) >= 12:
                break

    print('\n=== TOTAL de entidades alcancadas: %d ===' % len(todos))
    ids = {}
    for e in todos:
        ids.setdefault(e['id'], 0)
        ids[e['id']] += 1
    print('ids unicos: %d' % len(ids))
    for i, n in list(ids.items())[:15]:
        print('  id %#x : %d' % (i, n))

    saida = Path(__file__).resolve().parent.parent / 'local-data' / 'creature-follow.json'
    saida.parent.mkdir(parents=True, exist_ok=True)
    json.dump({'pid': pid, 'player': hex(player), 'entidades': todos},
              open(saida, 'w', encoding='utf-8'), indent=1)
    print('\nartefato:', saida)


if __name__ == '__main__':
    main()
