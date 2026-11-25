"""Acha a cadeia de ponteiros de .data ate o objeto LocalPlayer.

Varre o modulo por ponteiros que apontem para o objeto (ou para um objeto
que contenha ponteiro para ele, ate 3 niveis). Reporta os RVAs de .data.

Uso: find_player_chain.py <pid> <va-do-objeto>
"""
import ctypes, struct, sys, json, os
from ctypes import wintypes

PID = int(sys.argv[1])
ALVO = int(sys.argv[2], 16)
MODULE = 'pokealliance_dx.exe'
PROFUNDIDADE = 3

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

def varrer_modulo(procurado):
    """devolve lista de RVAs de .data que contem exatamente `procurado`."""
    achados = []
    addr = base
    while addr < base + size:
        mbi = MBI()
        if not k32.VirtualQueryEx(ctypes.c_void_p(h), ctypes.c_void_p(addr),
                                  ctypes.byref(mbi), ctypes.sizeof(mbi)):
            break
        rbase = int(mbi.BaseAddress); rsize = int(mbi.RegionSize)
        if rsize <= 0: break
        if mbi.State == 0x1000 and (mbi.Protect & 0x0F) in (0x02, 0x04, 0x40, 0x08):
            bloco = rd(rbase, min(rsize, 32 * 1024 * 1024))
            if bloco:
                for off in range(0, len(bloco) - 8, 8):
                    if struct.unpack_from('<Q', bloco, off)[0] == procurado:
                        achados.append((rbase - base) + off)
        addr = rbase + rsize
    return achados

print('objeto alvo: %#x (fora do modulo: %s)' % (ALVO, not (base < ALVO < base + size)))
print('modulo: base=%#x size=%.0f MB' % (base, size / 1024 / 1024))

# nivel 1: quem aponta direto pro objeto
nivel = {ALVO: []}
visitados = {ALVO}
fronteira = [ALVO]

for nivel_atual in range(1, PROFUNDIDADE + 1):
    novo = []
    for alvo in fronteira:
        rvas = varrer_modulo(alvo)
        if rvas:
            nivel[alvo] = rvas
            for rva in rvas:
                va_ponteiro = base + rva
                if va_ponteiro not in visitados:
                    visitados.add(va_ponteiro)
                    novo.append(va_ponteiro)
            print('\nnivel %d: %d ponteiro(s) para %#x' % (nivel_atual, len(rvas), alvo))
            for rva in rvas[:6]:
                print('   rva %#x  (va %#x)' % (rva, base + rva))
    if not novo:
        print('\nnivel %d: nada' % nivel_atual)
        break
    fronteira = novo

# tenta achar um ponteiro ESTAVEL para o objeto, i.e. cujo ponteiro
# (nao o objeto) esteja em .data com RVA plausivel
print('\n=== candidatos a cadeia ===')
saida = []
for alvo, rvas in nivel.items():
    if not rvas: continue
    for rva in rvas:
        # se o ponteiro esta em .data (rva < size), e um bom candidato
        entrada = {'apontaPara': hex(alvo), 'rva': hex(rva),
                   'tipo': 'objeto' if alvo == ALVO else 'intermediario'}
        print(json.dumps(entrada))
        saida.append(entrada)

pasta = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'local-data')
os.makedirs(pasta, exist_ok=True)
arq = os.path.join(pasta, 'player-chain.json')
json.dump({'pid': PID, 'base': hex(base), 'objeto': hex(ALVO),
           'cadeia': saida}, open(arq, 'w', encoding='utf-8'), indent=1)
print('\nartefato:', arq)
k32.CloseHandle(ctypes.c_void_p(h))
