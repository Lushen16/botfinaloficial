"""Delta scan da posicao do LocalPlayer, no build atual.

1. Acha o hwnd do jogo pelo PID.
2. Captura snapshot da memoria privada.
3. Envia tecla de movimento via PostMessageW.
4. Captura de novo e compara.
5. Reporta os enderecos cuja tripla int32 mudou na direcao esperada.

Somente conta descartavel. Leitura de muita memoria = gatilho de ban conhecido.
"""
import ctypes, struct, sys, time, json, os
from ctypes import wintypes

PID = int(sys.argv[1])
MODULE = 'pokealliance_dx.exe'
DIRECAO = int(sys.argv[2]) if len(sys.argv) > 2 else 0  # 0=cima 1=direita 2=baixo 3=esquerda

u32 = ctypes.WinDLL('user32', use_last_error=True)
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

def achar_hwnd(pid):
    janelas = []
    WNDPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def cb(hwnd, _):
        p = wintypes.DWORD()
        u32.GetWindowThreadProcessId(hwnd, ctypes.byref(p))
        if p.value == pid:
            n = u32.GetWindowTextLengthW(hwnd)
            t = ''
            if n > 0:
                b = ctypes.create_unicode_buffer(n + 1)
                u32.GetWindowTextW(hwnd, b, n + 1)
                t = b.value
            janelas.append((hwnd, bool(u32.IsWindowVisible(hwnd)), t))
        return True
    u32.EnumWindows(WNDPROC(cb), 0)
    print('janelas do pid:')
    for h, v, t in janelas:
        print('  %#x visivel=%s %r' % (h, v, t))
    vis = [j for j in janelas if j[1] and j[2]]
    if not vis:
        raise SystemExit('nenhuma janela visivel com titulo')
    vis.sort(key=lambda x: len(x[2]), reverse=True)
    return vis[0][0]

def enviar_tecla(hwnd, vk, scan, extended=False):
    lparam_down = 1 | (scan << 16) | (int(extended) << 24)
    lparam_up = lparam_down | 0xC0000000
    ok1 = u32.PostMessageW(hwnd, 0x0100, vk, lparam_down)
    time.sleep(0.08)
    ok2 = u32.PostMessageW(hwnd, 0x0101, vk, lparam_up)
    return bool(ok1), bool(ok2)

hwnd = achar_hwnd(PID)
print('hwnd escolhido: %#x' % hwnd)

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

def regioes():
    """lista de (base, tamanho) privadas e legiveis."""
    out = []
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
            out.append((rbase, rsize))
        addr = rbase + rsize
    return out

print('enumerando regioes...')
regs = regioes()
total = sum(r[1] for r in regs)
print('%d regioes, %.0f MB' % (len(regs), total / 1024 / 1024))

print('\ncapturando ANTES...')
antes = {}
lidos = 0
for rbase, rsize in regs:
    bloco = rd(rbase, rsize)
    if bloco:
        antes[rbase] = bloco
        lidos += len(bloco)
print('capturado: %.0f MB' % (lidos / 1024 / 1024))

CHAVES = {0: (0x26, 0x48), 1: (0x27, 0x4D), 2: (0x28, 0x50), 3: (0x25, 0x4B)}
VK, SCAN = CHAVES[DIRECAO]
print('\nandando na direcao %d (vk=%#x) por 1.2s...' % (DIRECAO, VK))
u32.PostMessageW(hwnd, 0x0100, VK, 1 | (SCAN << 16))
time.sleep(1.2)
u32.PostMessageW(hwnd, 0x0101, VK, (1 | (SCAN << 16)) | 0xC0000000)
time.sleep(0.4)

print('capturando DEPOIS...')
mudancas = []
for rbase, rsize in regs:
    bloco = rd(rbase, rsize)
    velho = antes.get(rbase)
    if not bloco or velho is None or len(bloco) != len(velho):
        continue
    if bloco == velho:
        continue
    for off in range(0, len(bloco) - 12, 4):
        if bloco[off:off + 4] == velho[off:off + 4]:
            continue
        x1, y1, z1 = struct.unpack_from('<iii', velho, off)
        x2, y2, z2 = struct.unpack_from('<iii', bloco, off)
        if not (0 < x1 < 65535 and 0 < y1 < 65535 and 0 <= z1 < 20): continue
        if not (0 < x2 < 65535 and 0 < y2 < 65535 and 0 <= z2 < 20): continue
        dx, dy = x2 - x1, y2 - y1
        if dx == 0 and dy == 0: continue
        if abs(dx) > 3 or abs(dy) > 3: continue
        mudancas.append({
            'va': hex(rbase + off), 'rva': hex(rbase + off - base),
            'de': [x1, y1, z1], 'para': [x2, y2, z2], 'delta': [dx, dy],
            'noModulo': base < rbase + off < base + 0x663d000,
        })

print('\n=== TRIPLAS QUE MUDARAM: %d ===' % len(mudancas))
for m in mudancas[:20]:
    print(json.dumps(m))

pasta = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'local-data')
os.makedirs(pasta, exist_ok=True)
arq = os.path.join(pasta, 'delta-position.json')
json.dump({'pid': PID, 'direcao': DIRECAO, 'base': hex(base),
           'mudancas': mudancas[:200]}, open(arq, 'w', encoding='utf-8'), indent=1)
print('\nartefato:', arq)
k32.CloseHandle(ctypes.c_void_p(h))
