"""Acha o LocalPlayer pelas COORDENADAS, nao pelo nome.

O Dugtrio estava em (3308, 2044, 7) na leitura anterior. Varre a memoria
privada procurando triplas int32 plausiveis naquela faixa e, para cada uma,
verifica se o objeto tem vtable dentro do modulo.

Somente leitura. Conta descartavel.
"""
import ctypes, struct, sys, json, os
from ctypes import wintypes

PID = int(sys.argv[1])
MODULE = 'pokealliance_dx.exe'

k32 = ctypes.WinDLL('kernel32', use_last_error=True)
k32.OpenProcess.restype = wintypes.HANDLE
k32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
k32.VirtualQueryEx.restype = ctypes.c_size_t

class ME(ctypes.Structure):
    _fields_ = [('dwSize', wintypes.DWORD), ('th32ModuleID', wintypes.DWORD),
                ('th32ProcessID', wintypes.DWORD), ('GlblcntUsage', wintypes.DWORD),
                ('ProccntUsage', wintypes.DWORD), ('modBaseAddr', ctypes.c_void_p),
                ('modBaseSize', wintypes.DWORD), ('hModule', wintypes.HMODULE),
                ('szModule', wintypes.WCHAR * 256), ('szExePath', wintypes.WCHAR * 260)]

class MBI(ctypes.Structure):
    _fields_ = [('BaseAddress', ctypes.c_void_p), ('AllocationBase', ctypes.c_void_p),
                ('AllocationProtect', wintypes.DWORD), ('PartitionId', wintypes.WORD),
                ('RegionSize', ctypes.c_size_t), ('State', wintypes.DWORD),
                ('Protect', wintypes.DWORD), ('Type', wintypes.DWORD)]

snap = k32.CreateToolhelp32Snapshot(0x8 | 0x10, PID)
me = ME(); me.dwSize = ctypes.sizeof(ME)
base = size = 0
if k32.Module32FirstW(ctypes.c_void_p(snap), ctypes.byref(me)):
    while True:
        if me.szModule.lower() == MODULE:
            base = int(me.modBaseAddr); size = int(me.modBaseSize); break
        if not k32.Module32NextW(ctypes.c_void_p(snap), ctypes.byref(me)):
            break
k32.CloseHandle(ctypes.c_void_p(snap))

h = k32.OpenProcess(0x10 | 0x1000, False, PID)

def rd(va, n):
    buf = ctypes.create_string_buffer(n); got = ctypes.c_size_t(0)
    if not k32.ReadProcessMemory(ctypes.c_void_p(h), ctypes.c_void_p(va),
                                 buf, n, ctypes.byref(got)):
        return b''
    return buf.raw[:got.value]

def vtable_rva(obj):
    raw = rd(obj, 8)
    if len(raw) != 8: return None
    p = struct.unpack('<Q', raw)[0]
    return (p - base) if base < p < base + size else None

# faixa de coordenadas observada no mapa anterior
XMIN, XMAX = 2800, 3800
YMIN, YMAX = 1700, 2400
ZMIN, ZMAX = 0, 12

achados = []
addr = 0x10000
max_addr = 0x7FFFFFFFFFFF
total = 0
CHUNK = 8 * 1024 * 1024

while addr < max_addr:
    mbi = MBI()
    if not k32.VirtualQueryEx(ctypes.c_void_p(h), ctypes.c_void_p(addr),
                              ctypes.byref(mbi), ctypes.sizeof(mbi)):
        break
    rbase = int(mbi.BaseAddress); rsize = int(mbi.RegionSize)
    if rsize <= 0: break
    if mbi.State == 0x1000 and (mbi.Protect & 0x0F) in (0x02, 0x04, 0x40, 0x08) and not (mbi.Protect & 0x100):
        desloc = 0
        while desloc < rsize:
            n = min(CHUNK, rsize - desloc)
            bloco = rd(rbase + desloc, n)
            if bloco and len(bloco) >= 12:
                total += len(bloco)
                for off in range(0, len(bloco) - 12, 4):
                    x, y, z = struct.unpack_from('<iii', bloco, off)
                    if XMIN <= x <= XMAX and YMIN <= y <= YMAX and ZMIN <= z <= ZMAX:
                        va = rbase + desloc + off
                        achados.append((va, x, y, z))
            desloc += n
    addr = rbase + rsize

print('bytes lidos: %.1f MB' % (total / 1024 / 1024))
print('triplas plausiveis: %d' % len(achados))

# agrupar por proximidade e testar vtable em offsets negativos tipicos
print('\n=== candidatos com vtable do modulo antes da tripla ===')
saida = []
vistos = set()
for va, x, y, z in achados[:400]:
    for back in range(0x8, 0x180, 0x8):
        obj = va - back
        if obj in vistos: continue
        rva = vtable_rva(obj)
        if rva is None: continue
        # distancia ao nome (std::string em qualquer offset)
        nome = None
        for noff in range(0, 0x200, 8):
            raw = rd(obj + noff, 0x20)
            if len(raw) < 0x20: continue
            ln = struct.unpack_from('<Q', raw, 0x10)[0]
            if ln < 3 or ln > 40: continue
            txt = raw[:ln].decode('utf-8', 'ignore') if ln < 16 else None
            if txt and all(32 <= ord(c) < 127 for c in txt):
                nome = (hex(noff), txt); break
        vistos.add(obj)
        entry = {'obj': hex(obj), 'vtableRva': hex(rva),
                 'pos': [x, y, z], 'posOffset': hex(back), 'name': nome}
        print(json.dumps(entry))
        saida.append(entry)
        if len(saida) >= 15: break
    if len(saida) >= 15: break

pasta = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'local-data')
os.makedirs(pasta, exist_ok=True)
arq = os.path.join(pasta, 'player-by-coords.json')
json.dump({'pid': PID, 'base': hex(base), 'candidatos': saida},
          open(arq, 'w', encoding='utf-8'), indent=1)
print('\nartefato:', arq)
k32.CloseHandle(ctypes.c_void_p(h))
