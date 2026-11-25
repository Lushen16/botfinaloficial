"""Descobre o RVA do ponteiro do LocalPlayer no .data do build atual.

Metodo: varre APENAS a secao .data (poucos MB) procurando ponteiros que
apontem para um objeto cujo offset 0x70 contenha o nome do personagem como
std::string (SSO inline ou heap). Valida o candidato lendo pos/id/hp.

Somente leitura. Nao envia tecla. Nao varre a memoria toda.
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

print('modulo base=%#x size=%#x (%d MB)' % (base, size, size // 1024 // 1024))
if not base:
    print('modulo nao encontrado'); raise SystemExit(2)

h = k32.OpenProcess(0x10 | 0x1000, False, PID)

def rd(va, n):
    buf = ctypes.create_string_buffer(n); got = ctypes.c_size_t(0)
    if not k32.ReadProcessMemory(ctypes.c_void_p(h), ctypes.c_void_p(va),
                                 buf, n, ctypes.byref(got)):
        return b''
    return buf.raw[:got.value]

def read_wstr(va, maxlen=64):
    data = rd(va, maxlen * 2)
    if not data: return None
    try:
        s = data.decode('utf-16-le', 'ignore')
        cut = s.find('\x00')
        if cut >= 0: s = s[:cut]
        return s
    except Exception:
        return None

def read_name_at(obj):
    """offset 0x70 e std::string do MSVC: SSO inline (<=15 bytes) ou ponteiro."""
    raw = rd(obj + 0x70, 0x20)
    if len(raw) < 0x20: return None
    ln = struct.unpack_from('<Q', raw, 0x10)[0]
    if ln == 0 or ln > 40: return None
    if ln < 16:
        return raw[:ln].decode('utf-8', 'ignore')
    ptr = struct.unpack_from('<Q', raw, 0)[0]
    if ptr < 0x10000: return None
    data = rd(ptr, ln)
    return data.decode('utf-8', 'ignore') if len(data) == ln else None

print('varrendo .data por ponteiros para "%s" em +0x70...' % NAME)
alvo = NAME
candidatos = []
addr = base
fim = base + size
lidos = 0
while addr < fim:
    mbi = MBI(); mbi.BaseAddress = ctypes.c_void_p(addr)
    if not k32.VirtualQueryEx(ctypes.c_void_p(h), ctypes.c_void_p(addr),
                              ctypes.byref(mbi), ctypes.sizeof(mbi)):
        break
    rbase = int(mbi.BaseAddress);
    rsize = int(mbi.RegionSize)
    if mbi.State == 0x1000 and (mbi.Protect & 0x0F) in (0x02, 0x04, 0x40, 0x08):
        chunk = rd(rbase, min(rsize, 8 * 1024 * 1024))
        lidos += len(chunk)
        if len(chunk) >= 8:
            for off in range(0, len(chunk) - 8, 8):
                ptr = struct.unpack_from('<Q', chunk, off)[0]
                if not (base < ptr < base + size):
                    continue
                nm = read_name_at(ptr)
                if nm == alvo:
                    rva = (rbase - base) + off
                    candidatos.append((rva, ptr))
                    print('  CANDIDATO rva=%#x -> obj=%#x' % (rva, ptr))
                    if len(candidatos) >= 5:
                        break
        if len(candidatos) >= 5:
            break
    addr = rbase + rsize

print('bytes lidos do modulo: %d (%.1f MB)' % (lidos, lidos / 1024 / 1024))
print('candidatos: %d' % len(candidatos))

resultado = []
for rva, obj in candidatos:
    pos = rd(obj + 0x20, 12)
    pid_off = rd(obj + 0x4C, 4)
    hp = rd(obj + 0xB0, 4)
    tipo = rd(obj + 0x176, 1)
    px, py, pz = struct.unpack('<iii', pos) if len(pos) == 12 else (None, None, None)
    entry = {
        'rva': hex(rva), 'obj': hex(obj),
        'pos': [px, py, pz],
        'id': struct.unpack('<I', pid_off)[0] if len(pid_off) == 4 else None,
        'hp': struct.unpack('<I', hp)[0] if len(hp) == 4 else None,
        'type': tipo[0] if tipo else None,
        'posValida': px is not None and px not in (0, -1, 65535),
    }
    print(json.dumps(entry))
    resultado.append(entry)

saida = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                     'local-data', 'chain-discovery.json')
os.makedirs(os.path.dirname(saida), exist_ok=True)
json.dump({'pid': PID, 'module': MODULE, 'base': hex(base),
           'name': NAME, 'candidatos': resultado},
          open(saida, 'w', encoding='utf-8'), indent=1)
print('artefato:', saida)
k32.CloseHandle(ctypes.c_void_p(h))
