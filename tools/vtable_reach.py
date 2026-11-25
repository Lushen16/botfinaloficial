"""Quais vtables do modulo sao alcancadas por ponteiros em .data/.rdata?

Para cada qword em .data/.rdata que aponte para o heap, le os 8 primeiros
bytes (vtable) e agrupa por RVA da vtable. A vtable de criatura aparece
aqui se .data guardar a lista.

Somente .data/.rdata + 8 bytes por alvo unico. Sem scan do espaco todo.
"""
import ctypes, struct, sys, json
from pathlib import Path
from collections import defaultdict

sys.path.insert(0, str(Path(__file__).resolve().parent))
import scan_creatures as sc
import pointer_scan_entities as pe


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

    # 1. coletar qwords que apontam para heap, com o RVA de origem
    candidatos = []   # (rva_origem, valor)
    for nome, rva, vs in secoes:
        if nome not in ('.data', '.rdata'):
            continue
        bloco = read(base + rva, vs)
        if not bloco:
            continue
        print('lido %-8s %.2f MB' % (nome, len(bloco) / 1024 / 1024))
        for i in range(0, len(bloco) - 8, 8):
            p = struct.unpack_from('<Q', bloco, i)[0]
            if 0x10000000000 < p < 0x7ff000000000 and p % 16 == 0:
                candidatos.append((rva + i, p))

    print('\nqwords para heap: %d' % len(candidatos))
    unicos = sorted(set(p for _, p in candidatos))
    print('alvos unicos: %d' % len(unicos))

    # 2. ler vtable de cada alvo unico (limite de seguranca)
    LIMITE = 40000
    vt_count = defaultdict(list)
    lidos = 0
    for p in unicos[:LIMITE]:
        raw = read(p, 8)
        if not raw or len(raw) < 8:
            continue
        v = struct.unpack('<Q', raw)[0]
        lidos += 1
        if base < v < base + 0x663d000:
            vt_count[v - base].append(p)

    print('vtables distintas alcancadas: %d' % len(vt_count))
    print('\n=== top 15 vtables por quantidade de objetos ===')
    for vt, objs in sorted(vt_count.items(), key=lambda kv: -len(kv[1]))[:15]:
        print('  vtableRva %#08x : %5d objetos   ex: %#x' % (vt, len(objs), objs[0]))

    # 3. para as 5 maiores, quantas parecem entidade (pos plausivel em +0x20)
    print('\n=== teste de entidade nas top 5 ===')
    resumo = {}
    for vt, objs in sorted(vt_count.items(), key=lambda kv: -len(kv[1]))[:5]:
        bons = 0
        amostra = []
        for p in objs[:200]:
            pos = read(p + 0x20, 10)
            ident = read(p + 0x4C, 4)
            if not pos or len(pos) < 10 or not ident or len(ident) < 4:
                continue
            x, y, z = struct.unpack('<iih', pos)
            iv = struct.unpack('<I', ident)[0]
            if 0 < x < 65536 and 0 < y < 65536 and 0 <= z < 16:
                bons += 1
                if len(amostra) < 3:
                    tipo = read(p + 0x176, 1)
                    amostra.append({'va': hex(p), 'id': hex(iv), 'pos': [x, y, z],
                                    'type': tipo[0] if tipo else None})
        resumo[hex(vt)] = {'total': len(objs), 'entidadesOk': bons, 'amostra': amostra}
        print('  vtable %#x : %d/%d entidades | %s'
              % (vt, bons, min(len(objs), 200), amostra[:2]))

    saida = Path(__file__).resolve().parent.parent / 'local-data' / 'vtable-reach.json'
    saida.parent.mkdir(parents=True, exist_ok=True)
    json.dump({'pid': pid, 'base': hex(base),
               'vtables': {hex(k): len(v) for k, v in sorted(vt_count.items(), key=lambda kv: -len(kv[1]))[:30]},
               'resumo': resumo},
              open(saida, 'w', encoding='utf-8'), indent=1)
    print('\nartefato:', saida)


if __name__ == '__main__':
    main()
