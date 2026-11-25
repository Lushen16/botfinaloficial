"""Dumpa o layout de objetos candidatos a LocalPlayer.

Para cada objeto, imprime 0x300 bytes em hex + ascii, e tenta interpretar
campos: 3 ints consecutivos plausiveis (-2..65000) = posicao; nome como
std::string em qualquer offset; u32 pequeno = id/hp.
"""
import ctypes, struct, sys, json, os
from ctypes import wintypes

PID = int(sys.argv[1])
OBJETOS = [int(x, 16) for x in sys.argv[2:]]
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
base = 0
if k32.Module32FirstW(ctypes.c_void_p(snap), ctypes.byref(me)):
    while True:
        if me.szModule.lower() == MODULE:
            base = int(me.modBaseAddr); break
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

def hexdump(data, base_off=0, largura=16):
    linhas = []
    for i in range(0, len(data), largura):
        pedaco = data[i:i + largura]
        hx = ' '.join('%02x' % b for b in pedaco)
        asc = ''.join(chr(b) if 32 <= b < 127 else '.' for b in pedaco)
        linhas.append('  +%04x  %-*s  |%s|' % (base_off + i, largura * 3, hx, asc))
    return linhas

def ler_stdstring(va):
    """std::string MSVC no VA dado: len em +0x10, SSO se <=15."""
    raw = rd(va, 0x20)
    if len(raw) < 0x20: return None
    ln = struct.unpack_from('<Q', raw, 0x10)[0]
    if ln == 0 or ln > 64: return None
    if ln < 16:
        return raw[:ln].decode('utf-8', 'ignore')
    ptr = struct.unpack_from('<Q', raw, 0)[0]
    data = rd(ptr, ln)
    return data.decode('utf-8', 'ignore') if len(data) == ln else None

def achar_posicoes(data):
    """procura 3 int32 consecutivos com valores plausiveis de coordenada."""
    achados = []
    for off in range(0, len(data) - 12, 4):
        x, y, z = struct.unpack_from('<iii', data, off)
        if 0 <= x <= 65000 and 0 <= y <= 65000 and 0 <= z <= 20:
            if x > 0 and y > 0:
                achados.append((off, x, y, z))
    return achados

for obj in OBJETOS:
    data = rd(obj, 0x300)
    print('\n' + '=' * 78)
    print('OBJETO %#x  (rva do objeto: %#x)' % (obj, obj - base))
    if len(data) < 0x300:
        print('  leitura curta: %d bytes' % len(data))
        continue
    vptr = struct.unpack_from('<Q', data, 0)[0]
    print('  vtable: %#x  (rva %#x)' % (vptr, vptr - base))

    print('\n  --- campos name (std::string) detectados ---')
    for off in range(0, 0x300 - 0x20, 8):
        s = ler_stdstring(obj + off)
        if s and len(s) >= 3 and all(32 <= ord(c) < 127 for c in s):
            print('    +%#04x: %r' % (off, s))

    print('\n  --- triplas (x, y, z) plausiveis ---')
    for off, x, y, z in achar_posicoes(data)[:8]:
        print('    +%#04x: (%d, %d, %d)' % (off, x, y, z))

    print('\n  --- u32 pequenos (id/hp candidatos) ---')
    for off in range(0, len(data) - 4, 4):
        v = struct.unpack_from('<I', data, off)[0]
        if 1 <= v <= 200:
            print('    +%#04x: %d' % (off, v))

    print('\n  --- hexdump ---')
    for linha in hexdump(data[:0x140]):
        print(linha)

k32.CloseHandle(ctypes.c_void_p(h))
