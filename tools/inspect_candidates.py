"""Inspeciona candidatos de item em detalhe: le cada elemento do vetor e mostra
id, pos, type, nome, distancia ao player. Nao varre nada novo — usa RVAs que a
descoberta ja reportou.
"""
import sys, struct
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import scan_creatures as sc
import pointer_scan_entities as pe

pid = int(sys.argv[1])
rvas = [int(v, 0) for v in sys.argv[2:]]

h = sc.k32.OpenProcess(sc.PROCESS_QUERY_INFORMATION | sc.PROCESS_VM_READ, False, pid)
read = lambda a, n: sc.read_mem(h, a, n)
mods = [m for m in pe.enum_modules(pid)
        if m['name'].lower().startswith('pokealliance') and 'launcher' not in m['name'].lower()]
base = mods[0]['base']

pr = struct.unpack('<Q', read(base + 0x3A03598, 8))[0]
px, py, pz = struct.unpack_from('<iih', read(pr, 0xB8), 0x20)
print('player (%d,%d,%d)' % (px, py, pz))
print()

for rva in rvas:
    raw = read(base + rva, 24)
    if not raw or len(raw) < 24:
        print('%#x: sem leitura' % rva); continue
    bg, en, cp = struct.unpack('<QQQ', raw)
    d = en - bg
    valid = 0 < d <= 4096 and d % 8 == 0
    if not valid:
        print('%#x: begin=%#x end=%#x (invalido)' % (rva, bg, en)); continue
    n = d // 8
    print('%#x  n=%d  begin=%#x' % (rva, n, bg))
    dados = read(bg, d)
    if not dados or len(dados) != d:
        print('   leitura do bloco falhou'); continue
    for i in range(n):
        ptr = struct.unpack_from('<Q', dados, i * 8)[0]
        if not (0x10000 < ptr < 0x7ff000000000):
            continue
        b = read(ptr, 0x180)
        if not b or len(b) < 0x178:
            continue
        x, y, z = struct.unpack_from('<iih', b, 0x20)
        iv = struct.unpack_from('<I', b, 0x4C)[0]
        tp = b[0x176]
        nm = b[0x70:0x70 + 24].split(b'\x00', 1)[0].decode('utf-8', 'ignore')
        if not (0 < x < 65536 and 0 < y < 65536 and 0 <= z < 16):
            continue
        dist = abs(x - px) + abs(y - py)
        print('   [%d] va=%#x id=%#010x type=%d pos=(%d,%d,%d) dist=%d name=%r'
              % (i, ptr, iv, tp, x, y, z, dist, nm))
    print()
