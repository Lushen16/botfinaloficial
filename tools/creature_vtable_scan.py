"""Acha criaturas pela vtable de Monster (RTTI), nao por offset chutado.

A vtable de Monster foi identificada por RTTI em 0x1fb41b8 (build anterior).
Este build pode ter mudado, entao o script:
  1. procura a vtable por RTTI no .rdata (referencia ao TypeDescriptor)
  2. varre .data/.rdata por ponteiros para objetos com essa vtable
  3. le pos/id/hp/type e reporta quantas criaturas reais aparecem

Somente .data/.rdata + 8 bytes por alvo. Sem scan do espaco todo.
"""
import ctypes, struct, sys, json
from pathlib import Path
from collections import defaultdict

sys.path.insert(0, str(Path(__file__).resolve().parent))
import scan_creatures as sc
import pointer_scan_entities as pe

CANDIDATAS_VTABLE = [0x1fb41b8, 0x1fb2d98, 0x1fdfc30, 0x1fc8040]
POS, ID, NAME, HP, CANATTACK, TYPE = 0x20, 0x4C, 0x70, 0xB0, 0xB4, 0x176


def main():
    pid = int(sys.argv[1])
    h = sc.k32.OpenProcess(sc.PROCESS_QUERY_INFORMATION | sc.PROCESS_VM_READ, False, pid)
    mods = [m for m in pe.enum_modules(pid)
            if m['name'].lower().startswith('pokealliance') and 'launcher' not in m['name'].lower()]
    base = mods[0]['base']
    read = lambda va, n: sc.read_mem(h, va, n)

    img = open(sc.process_image_path(h), 'rb').read(0x600)
    pe_off = struct.unpack_from('<I', img, 0x3C)[0]
    nsec = struct.unpack_from('<H', img, pe_off + 6)[0]
    opt = struct.unpack_from('<H', img, pe_off + 20)[0]
    sec_off = pe_off + 24 + opt
    secoes = []
    for i in range(nsec):
        off = sec_off + i * 40
        nome = img[off:off + 8].rstrip(b'\x00').decode(errors='ignore')
        vs = struct.unpack_from('<I', img, off + 8)[0]
        rva = struct.unpack_from('<I', img, off + 12)[0]
        secoes.append((nome, rva, vs))

    print('base: %#x' % base)

    def ler_ent(va):
        pos = read(va + POS, 10)
        ident = read(va + ID, 4)
        if not pos or len(pos) < 10 or not ident or len(ident) < 4:
            return None
        x, y, z = struct.unpack('<iih', pos)
        if not (0 < x < 65536 and 0 < y < 65536 and 0 <= z < 16):
            return None
        iv = struct.unpack('<I', ident)[0]
        nm = read(va + NAME, 24)
        nome = None
        if nm:
            nome = nm.split(b'\x00', 1)[0].decode('utf-8', 'ignore') or None
        tipo = read(va + TYPE, 1)
        hpr = read(va + HP, 4)
        return {'va': hex(va), 'id': hex(iv), 'pos': [x, y, z], 'name': nome,
                'type': tipo[0] if tipo else None,
                'hp': struct.unpack('<I', hpr)[0] if hpr and len(hpr) == 4 else None}

    # coletar todos os qwords de .data/.rdata apontando para heap
    alvos = []
    for nome, rva, vs in secoes:
        if nome not in ('.data', '.rdata'):
            continue
        bloco = read(base + rva, vs)
        if not bloco:
            continue
        print('lido %-8s %.2f MB' % (nome, len(bloco) / 1024 / 1024))
        for i in range(0, len(bloco) - 8, 8):
            p = struct.unpack_from('<Q', bloco, i)[0]
            if 0x10000 < p < 0x7ff000000000 and p % 16 == 0:
                alvos.append(p)
    unicos = sorted(set(alvos))
    print('alvos unicos: %d' % len(unicos))

    # descobrir vtables DISTINTAS realmente alcancadas (nao so as candidatas)
    vt_objs = defaultdict(list)
    lidos = 0
    for p in unicos:
        raw = read(p, 8)
        if not raw or len(raw) < 8:
            continue
        v = struct.unpack('<Q', raw)[0]
        lidos += 1
        if base < v < base + 0x663d000:
            vt_objs[v - base].append(p)
    print('lidos: %d | vtables distintas: %d' % (lidos, len(vt_objs)))

    # testar TODAS as vtables com o layout de entidade (pos/id)
    print('\n=== vtables que contem ENTIDADES (pos em +0x20, id em +0x4C) ===')
    achadas = []
    for vt, objs in sorted(vt_objs.items(), key=lambda kv: -len(kv[1])):
        ents = []
        for p in objs[:120]:
            e = ler_ent(p)
            if e:
                ents.append(e)
        if ents:
            ids_ok = sum(1 for e in ents if int(e['id'], 16) >> 28 in (0x4, 0x8, 0x1))
            print('  vtable %#08x : %d/%d entidades | ids 0x4/0x8/0x1: %d'
                  % (vt, len(ents), min(len(objs), 120), ids_ok))
            for e in ents[:4]:
                print('      %s  id=%s pos=%s type=%s hp=%s name=%r'
                      % (e['va'], e['id'], e['pos'], e['type'], e['hp'], e['name']))
            achadas.append({'vtableRva': hex(vt), 'entidades': len(ents),
                            'idsOk': ids_ok, 'amostra': ents[:8], 'totalObjs': len(objs)})
    achadas.sort(key=lambda a: -a['entidades'])

    saida = Path(__file__).resolve().parent.parent / 'local-data' / 'creature-vtable.json'
    saida.parent.mkdir(parents=True, exist_ok=True)
    json.dump({'pid': pid, 'base': hex(base), 'achadas': achadas[:10],
               'vtablesTop': {hex(k): len(v) for k, v in sorted(vt_objs.items(), key=lambda kv: -len(kv[1]))[:20]}},
              open(saida, 'w', encoding='utf-8'), indent=1)
    print('\nartefato:', saida)


if __name__ == '__main__':
    main()
