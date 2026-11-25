"""Diagnostico: o que os vetores begin/end de .data/.rdata contem?

Para cada par plausivel, conta quantos elementos resolvem para algo que
PARECE entidade (pos plausivel no +0x20), mesmo sem exigir id valido.
Reporta os melhores candidatos com o que foi encontrado.
"""
import ctypes, struct, sys, json
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import scan_creatures as sc
import pointer_scan_entities as pe

POS, ID, NAME, TYPE = 0x20, 0x4C, 0x70, 0x176


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

    melhor = []
    for nome, rva, vs in secoes:
        if nome not in ('.data', '.rdata'):
            continue
        bloco = read(base + rva, vs)
        if not bloco:
            continue
        for i in range(0, len(bloco) - 24, 8):
            bg, en, cp = struct.unpack_from('<QQQ', bloco, i)
            if not (0x10000 < bg < 0x7ff000000000): continue
            if en <= bg: continue
            d = en - bg
            if d % 8 or d > 4096: continue
            n = d // 8
            dados = read(bg, d)
            if not dados or len(dados) != d: continue

            comPos = 0
            comId = 0
            ent = []
            for k in range(n):
                p = struct.unpack_from('<Q', dados, k * 8)[0]
                if not (0x10000 < p < 0x7ff000000000): continue
                pr = read(p + POS, 10)
                if not pr or len(pr) < 10: continue
                x, y, z = struct.unpack('<iih', pr)
                if not (0 < x < 65536 and 0 < y < 65536 and 0 <= z < 16): continue
                comPos += 1
                ir = read(p + ID, 4)
                iv = struct.unpack('<I', ir)[0] if ir and len(ir) == 4 else 0
                if iv: comId += 1
                tipo = read(p + TYPE, 1)
                ent.append({'va': hex(p), 'id': hex(iv), 'pos': [x, y, z],
                            'type': tipo[0] if tipo else None})
            if comPos >= 2:
                melhor.append({'secao': nome, 'rva': rva + i, 'n': n,
                               'comPos': comPos, 'comId': comId, 'ent': ent[:8]})

    melhor.sort(key=lambda c: (-c['comPos'], -c['comId']))
    print('=== vetores com >=2 elementos com posicao plausivel: %d ===' % len(melhor))
    for c in melhor[:10]:
        print('\n  %s rva=%#x n=%d comPos=%d comId=%d'
              % (c['secao'], c['rva'], c['n'], c['comPos'], c['comId']))
        for e in c['ent'][:5]:
            print('      %s id=%s pos=%s type=%s' % (e['va'], e['id'], e['pos'], e['type']))

    saida = Path(__file__).resolve().parent.parent / 'local-data' / 'vector-diag.json'
    json.dump(melhor[:20], open(saida, 'w', encoding='utf-8'), indent=1)
    print('\nartefato:', saida)


if __name__ == '__main__':
    main()
