"""Varre a memoria PRIVADA do processo procurando o nome do personagem.

Le apenas regioes comitadas e legiveis. Para cada ocorrencia, reporta o VA
e procura para tras um ponteiro de vtable. Tambem tenta ler campos em
offsets conhecidos a partir do provavel inicio de objeto.

ATENCAO: leitura de muitas regioes. Gatilho de ban conhecido — usar so em
conta descartavel.
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
print('nome: %r  UTF8=%dB UTF16=%dB' % (NAME, len(nome8), len(nome16)))

achados = []
addr = 0x10000
max_addr = 0x7FFFFFFFFFFF
total = 0
regioes = 0
CHUNK = 8 * 1024 * 1024

while addr < max_addr:
    mbi = MBI()
    if not k32.VirtualQueryEx(ctypes.c_void_p(h), ctypes.c_void_p(addr),
                              ctypes.byref(mbi), ctypes.sizeof(mbi)):
        break
    rbase = int(mbi.BaseAddress); rsize = int(mbi.RegionSize)
    if rsize <= 0: break
    protecao = mbi.Protect & 0x0F
    legivel = (mbi.State == 0x1000 and protecao in (0x02, 0x04, 0x40, 0x08))
    if legivel and not (mbi.Protect & 0x100):
        regioes += 1
        desloc = 0
        while desloc < rsize:
            n = min(CHUNK, rsize - desloc)
            bloco = rd(rbase + desloc, n)
            if bloco:
                total += len(bloco)
                for enc, agulha in (('utf8', nome8), ('utf16', nome16)):
                    pos = 0
                    while True:
                        i = bloco.find(agulha, pos)
                        if i < 0: break
                        va = rbase + desloc + i
                        achados.append({'enc': enc, 'va': va, 'noModulo': base < va < base + size})
                        pos = i + 1
            desloc += n
    addr = rbase + rsize

print('regioes lidas: %d | bytes: %.1f MB' % (regioes, total / 1024 / 1024))
print('ocorrencias: %d' % len(achados))

for a in achados[:20]:
    n = 'MODULO' if a['noModulo'] else 'privado'
    print('  %s %s em VA=%#x' % (a['enc'], n, a['va']))

print('\n=== procurando inicio de objeto antes de cada ocorrencia ===')
resumo = []
for a in achados[:20]:
    va = a['va']
    melhor = None
    for back in range(0x20, 0x400, 0x8):
        obj = va - back
        vptr = rd(obj, 8)
        if len(vptr) != 8: continue
        p = struct.unpack('<Q', vptr)[0]
        if base < p < base + size:
            melhor = (obj, back, p)
            break
    if melhor:
        obj, back, p = melhor
        pos = rd(obj + 0x20, 12)
        ident = rd(obj + 0x4C, 4)
        hp = rd(obj + 0xB0, 4)
        px, py, pz = struct.unpack('<iii', pos) if len(pos) == 12 else (None,)*3
        entry = {
            'vaNome': hex(va), 'obj': hex(obj), 'nameOffset': hex(back),
            'vtable': hex(p), 'vtableRva': hex(p - base),
            'pos': [px, py, pz],
            'id': struct.unpack('<I', ident)[0] if len(ident) == 4 else None,
            'hp': struct.unpack('<I', hp)[0] if len(hp) == 4 else None,
            'noModulo': a['noModulo'],
        }
        print(json.dumps(entry))
        resumo.append(entry)

saida = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                     'local-data', 'process-name-scan.json')
os.makedirs(os.path.dirname(saida), exist_ok=True)
json.dump({'pid': PID, 'name': NAME, 'base': hex(base),
           'ocorrencias': len(achados), 'objetos': resumo},
          open(saida, 'w', encoding='utf-8'), indent=1)
print('\nartefato:', saida)
k32.CloseHandle(ctypes.c_void_p(h))
