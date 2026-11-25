"""Acha o container da lista de criaturas (RVA do .data) e o LocalPlayer.

Recebe VAs de objetos de criatura e procura ponteiros para eles em todo
o modulo. O endereco que contem varios desses ponteiros e a lista; o campo
perto dela costuma ser o LocalPlayer.
"""
import ctypes, struct, sys, json, os
from ctypes import wintypes

PID = int(sys.argv[1])
ALVOS = [int(x, 16) for x in sys.argv[2:]]
MODULE = 'pokealliance_dx.exe'

k32 = ctypes.WinDLL('kernel32', use_last_error=True)
k32.OpenProcess.restype = wintypes.HANDLE
k32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE

class ME(ctypes.Structure):
    _fields_ = [('dwSize', wintypes.DWORD), ('th32ModuleID', wintypes.DWORD),
                ('th32ProcessID', wintypes.DWORD), ('GlblcntUsage', wintypes.DWORD),
                ('ProccntUsage', wintypes.DWORD), ('modBaseAddr', ctypes.c_void_p),
                ('modBaseSize', wintypes.DWORD), ('hModule', wintypes.HMODULE),
                ('szModule', wintypes.WCHAR * 256), ('szExePath', wintypes.WCHAR * 260)]

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

if not ALVOS:
    print('uso: find_container.py <pid> <va1> <va2> ...'); raise SystemExit(64)

h = k32.OpenProcess(0x10 | 0x1000, False, PID)

def rd(va, n):
    buf = ctypes.create_string_buffer(n); got = ctypes.c_size_t(0)
    if not k32.ReadProcessMemory(ctypes.c_void_p(h), ctypes.c_void_p(va),
                                 buf, n, ctypes.byref(got)):
        return b''
    return buf.raw[:got.value]

alvo_set = set(ALVOS)
print('procurando ponteiros para %d objetos no modulo (%.0f MB)...'
      % (len(alvos := ALVOS), size / 1024 / 1024))

ocorrencias = {}
bloco_tam = 16 * 1024 * 1024
addr = base
while addr < base + size:
    bloco = rd(addr, min(bloco_tam, base + size - addr))
    if not bloco: break
    for off in range(0, len(bloco) - 8, 8):
        p = struct.unpack_from('<Q', bloco, off)[0]
        if p in alvo_set:
            rva = (addr - base) + off
            ocorrencias.setdefault(rva, []).append(p)
    addr += len(bloco)

print('enderecos de ponteiro encontrados: %d' % len(ocorrencias))
ordenado = sorted(ocorrencias.items(), key=lambda kv: -len(kv[1]))
for rva, ptrs in ordenado[:10]:
    print('  rva %#x: %d ponteiros' % (rva, len(ptrs)))

# para o melhor, dumpa a vizinhanca procurando o LocalPlayer
if ordenado:
    rva_melhor = ordenado[0][0]
    va_lista = base + rva_melhor
    print('\n=== vizinhanca da lista (rva %#x) ===' % rva_melhor)
    for desloc in range(-0x80, 0x100, 8):
        va = va_lista + desloc
        raw = rd(va, 8)
        if len(raw) != 8: continue
        p = struct.unpack('<Q', raw)[0]
        marca = ''
        if p in alvo_set: marca = ' <- criatura'
        elif base < p < base + size:
            marca = ' (ponteiro p/ modulo)'
            vt = rd(p, 8)
            if len(vt) == 8:
                v = struct.unpack('<Q', vt)[0]
                if base < v < base + size:
                    marca += ' vtableRva=%#x' % (v - base)
                    # tenta posicao
                    pos = rd(p + 0x20, 12)
                    if len(pos) == 12:
                        x, y, z = struct.unpack('<iii', pos)
                        if 0 < x < 65535 and 0 < y < 65535 and 0 <= z < 20:
                            marca += ' pos=(%d,%d,%d)' % (x, y, z)
        elif p != 0:
            marca = ' (outro)'
        print('  %+#06x  %#018x%s' % (desloc, p, marca))

k32.CloseHandle(ctypes.c_void_p(h))
