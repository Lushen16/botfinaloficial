"""Valida um candidato a endereco de posicao: le em tempo real enquanto
envia teclas em 4 direcoes. So confirma se o endereco acompanhar o movimento.

Uso: validate_position.py <pid> <va-hex>
"""
import ctypes, struct, sys, time
from ctypes import wintypes

PID = int(sys.argv[1])
VA = int(sys.argv[2], 16)
MODULE = 'pokealliance_dx.exe'

u32 = ctypes.WinDLL('user32', use_last_error=True)
k32 = ctypes.WinDLL('kernel32', use_last_error=True)
k32.OpenProcess.restype = wintypes.HANDLE

h = k32.OpenProcess(0x10 | 0x1000, False, PID)

def rd(va, n):
    buf = ctypes.create_string_buffer(n); got = ctypes.c_size_t(0)
    if not k32.ReadProcessMemory(ctypes.c_void_p(h), ctypes.c_void_p(va),
                                 buf, n, ctypes.byref(got)):
        return b''
    return buf.raw[:got.value]

def ler(va):
    raw = rd(va, 12)
    if len(raw) != 12: return None
    return struct.unpack('<iii', raw)

def achar_hwnd(pid):
    janelas = []
    WNDPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def cb(hwnd, _):
        p = wintypes.DWORD()
        u32.GetWindowThreadProcessId(hwnd, ctypes.byref(p))
        if p.value == pid:
            n = u32.GetWindowTextLengthW(hwnd)
            if n > 0 and u32.IsWindowVisible(hwnd):
                b = ctypes.create_unicode_buffer(n + 1)
                u32.GetWindowTextW(hwnd, b, n + 1)
                janelas.append((hwnd, b.value))
        return True
    u32.EnumWindows(WNDPROC(cb), 0)
    return janelas[0][0] if janelas else None

hwnd = achar_hwnd(PID)
print('hwnd: %#x | monitorando VA %#x' % (hwnd, VA))

inicial = ler(VA)
print('leitura inicial: %s' % (inicial,))
if not inicial:
    raise SystemExit('nao consegui ler')

CHAVES = {0: (0x26, 0x48, 'cima'), 1: (0x27, 0x4D, 'direita'),
          2: (0x28, 0x50, 'baixo'), 3: (0x25, 0x4B, 'esquerda')}

for direcao in (1, 3, 0, 2):
    VK, SCAN, nome = CHAVES[direcao]
    antes = ler(VA)
    lparam = 1 | (SCAN << 16)
    u32.PostMessageW(hwnd, 0x0100, VK, lparam)
    time.sleep(0.9)
    u32.PostMessageW(hwnd, 0x0101, VK, lparam | 0xC0000000)
    time.sleep(0.35)
    depois = ler(VA)
    if antes and depois:
        d = tuple(b - a for a, b in zip(antes, depois))
        mudou = 'MUDOU' if d != (0, 0, 0) else 'parado'
        print('  %-9s %s -> %s  delta=%s  %s'
              % (nome, antes, depois, d, mudou))

final = ler(VA)
print('\nleitura final: %s' % (final,))
print('deslocamento total desde o inicio: %s'
      % (tuple(f - i for i, f in zip(inicial, final)),))
k32.CloseHandle(ctypes.c_void_p(h))
