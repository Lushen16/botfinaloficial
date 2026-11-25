"""Onde o nome do personagem aparece na memoria? Descobre o layout novo.

1. Localiza o texto do nome (UTF-8 e UTF-16) em todo o heap do processo.
2. Para cada ocorrencia, calcula o offset relativo de objetos proximos.
3. Reporta os offsets mais frequentes -> provavel offset do campo name.

Somente leitura.
"""
import ctypes, struct, sys, json, os
from ctypes import wintypes

PID = int(sys.argv[1])
NAME = sys.argv[2]
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

nome8 = NAME.encode('utf-8')
nome16 = NAME.encode('utf-16-le')
print('procurando UTF-8 (%d B) e UTF-16 (%d B) no modulo' % (len(nome8), len(nome16)))

achados = []
addr = base
fim = base + size
total = 0
while addr < fim:
    mbi = MBI(); mbi.BaseAddress = ctypes.c_void_p(addr)
    if not k32.VirtualQueryEx(ctypes.c_void_p(h), ctypes.c_void_p(addr),
                              ctypes.byref(mbi), ctypes.sizeof(mbi)):
        break
    rbase = int(mbi.BaseAddress); rsize = int(mbi.RegionSize)
    if mbi.State == 0x1000 and (mbi.Protect & 0x0F) in (0x02, 0x04, 0x40, 0x08):
        bloco = rd(rbase, min(rsize, 16 * 1024 * 1024))
        total += len(bloco)
        for enc, agulha in (('utf8', nome8), ('utf16', nome16)):
            pos = 0
            while True:
                i = bloco.find(agulha, pos)
                if i < 0: break
                achados.append({'enc': enc, 'va': rbase + i,
                                'rva': (rbase - base) + i,
                                'noModulo': True})
                pos = i + 1
    addr = rbase + rsize

print('bytes lidos: %d (%.1f MB)' % (total, total / 1024 / 1024))
print('ocorrencias: %d' % len(achados))

# para cada ocorrencia, olhar 0x200 bytes antes procurando vtable plausivel
print('\n=== analise de contexto (procurando inicio de objeto) ===')
for a in achados[:12]:
    va = a['va']
    print('\n%s em %#x (rva %#x)' % (a['enc'], va, a['rva']))
    # candidatos a inicio de objeto: offsets alinhados antes do nome
    for back in range(0x20, 0x300, 0x8):
        obj = va - back
        vptr = rd(obj, 8)
        if len(vptr) != 8: continue
        p = struct.unpack('<Q', vptr)[0]
        # vtable plausivel: dentro do modulo
        if base < p < base + size:
            print('  obj=%#x (nome +%#x)  vtable=%#x (rva %#x)'
                  % (obj, back, p, p - base))

saida = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                     'local-data', 'name-occurrences.json')
os.makedirs(os.path.dirname(saida), exist_ok=True)
json.dump({'pid': PID, 'name': NAME, 'base': hex(base),
           'ocorrencias': [{'enc': a['enc'], 'va': hex(a['va']), 'rva': hex(a['rva'])}
                           for a in achados]},
          open(saida, 'w', encoding='utf-8'), indent=1)
print('\nartefato:', saida)
k32.CloseHandle(ctypes.c_void_p(h))
