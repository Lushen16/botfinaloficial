"""Descoberta completa numa passada: acha o LocalPlayer pela posicao,
confirma o vtable, e acha a cadeia de ponteiros ate .data.

Tudo dentro de uma janela curta para o heap nao reciclar.

Uso: discover_chain_full.py <pid> [xmin xmax ymin ymax zmin zmax]
"""
import ctypes, struct, sys, json, os
from ctypes import wintypes

PID = int(sys.argv[1])
if len(sys.argv) >= 8:
    XMIN, XMAX, YMIN, YMAX, ZMIN, ZMAX = (int(v) for v in sys.argv[2:8])
else:
    XMIN, XMAX, YMIN, YMAX, ZMIN, ZMAX = 2000, 4500, 1500, 2800, 0, 12

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

# ---- 1. achar candidatos por posicao
print('faixa: x %d..%d | y %d..%d | z %d..%d' % (XMIN, XMAX, YMIN, YMAX, ZMIN, ZMAX))
candidatos = []
addr = 0x10000
while addr < 0x7FFFFFFFFFFF:
    mbi = MBI()
    if not k32.VirtualQueryEx(ctypes.c_void_p(h), ctypes.c_void_p(addr),
                              ctypes.byref(mbi), ctypes.sizeof(mbi)):
        break
    rbase = int(mbi.BaseAddress); rsize = int(mbi.RegionSize)
    if rsize <= 0: break
    if (mbi.State == 0x1000 and (mbi.Protect & 0x0F) in (0x02, 0x04, 0x40, 0x08)
            and not (mbi.Protect & 0x100) and rsize <= 64 * 1024 * 1024):
        bloco = rd(rbase, rsize)
        if bloco and len(bloco) >= 12:
            for off in range(0, len(bloco) - 12, 4):
                x, y, z = struct.unpack_from('<iii', bloco, off)
                if XMIN <= x <= XMAX and YMIN <= y <= YMAX and ZMIN <= z <= ZMAX:
                    va = rbase + off
                    for back in range(8, 0x100, 8):
                        obj = va - back
                        rva = vtable_rva(obj)
                        if rva is not None:
                            candidatos.append({'obj': obj, 'posVa': va,
                                               'posOffset': back, 'pos': (x, y, z),
                                               'vtableRva': rva})
                            break
    addr = rbase + rsize

print('candidatos com vtable: %d' % len(candidatos))

# agrupar por vtable para ver o padrao
from collections import defaultdict
por_vt = defaultdict(list)
for c in candidatos:
    por_vt[c['vtableRva']].append(c)
print('\nvtables encontradas:')
for vt, lista in sorted(por_vt.items(), key=lambda kv: -len(kv[1]))[:8]:
    print('  vtableRva %#x : %d objetos | offset pos mais comum: %#x'
          % (vt, len(lista),
             max(set(c['posOffset'] for c in lista),
                 key=[c['posOffset'] for c in lista].count)))

# ---- 2. para a vtable mais frequente em faixa de mapa, achar cadeia
alvos = [c['obj'] for c in candidatos[:20]]
print('\nprocurando ponteiros para os %d primeiros objetos...' % len(alvos))
alvo_set = set(alvos)
achados = []
addr = base
while addr < base + size:
    bloco = rd(addr, min(32 * 1024 * 1024, base + size - addr))
    if not bloco: break
    for off in range(0, len(bloco) - 8, 8):
        if struct.unpack_from('<Q', bloco, off)[0] in alvo_set:
            achados.append((addr - base) + off)
    addr += len(bloco)

print('ponteiros em .data para esses objetos: %d' % len(achados))
for rva in achados[:10]:
    print('  RVA %#x' % rva)

saida = {'pid': PID, 'base': hex(base),
         'faixa': [XMIN, XMAX, YMIN, YMAX, ZMIN, ZMAX],
         'candidatos': [{'obj': hex(c['obj']), 'vtableRva': hex(c['vtableRva']),
                         'pos': list(c['pos']), 'posOffset': hex(c['posOffset'])}
                        for c in candidatos[:40]],
         'dataPointers': [hex(r) for r in achados[:40]]}
pasta = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'local-data')
os.makedirs(pasta, exist_ok=True)
arq = os.path.join(pasta, 'chain-full.json')
json.dump(saida, open(arq, 'w', encoding='utf-8'), indent=1)
print('\nartefato:', arq)
k32.CloseHandle(ctypes.c_void_p(h))
