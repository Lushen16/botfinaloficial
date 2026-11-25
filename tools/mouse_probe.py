"""Testa qual mecanismo de mouse o cliente aceita.

Variantes:
  A) WM_MOUSEMOVE + WM_LBUTTONDOWN/UP  (PostMessage, sem cursor real)
  B) WM_ACTIVATE + WM_SETFOCUS + A
  C) SetCursorPos + mouse_event (cursor real, precisa foreground)
  D) A no ponto exato do tile do player (controle)

Cada variante e' seguida de leitura de posicao por cadeia. Em OTClient,
clicar no chao faz o personagem ANDAR 1 tile. Movimento = variante aceita.

Uso: python tools/mouse_probe.py <pid>
"""
import ctypes, struct, sys, time
from ctypes import wintypes
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import scan_creatures as sc
import pointer_scan_entities as pe

CHAIN_RVA = 0x3A03598
POS = 0x20
u32 = ctypes.WinDLL('user32', use_last_error=True)


def janela(pid):
    CB = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    achado = {}
    @CB
    def cb(hwnd, _):
        p = wintypes.DWORD()
        u32.GetWindowThreadProcessId(hwnd, ctypes.byref(p))
        if p.value == pid and u32.IsWindowVisible(hwnd):
            n = u32.GetWindowTextLengthW(hwnd)
            if n > 0:
                b = ctypes.create_unicode_buffer(n + 1)
                u32.GetWindowTextW(hwnd, b, n + 1)
                if 'PokeAlliance' in b.value:
                    achado['hwnd'] = hwnd
                    return False
        return True
    u32.EnumWindows(cb, 0)
    return achado.get('hwnd')


def pos(pid):
    h = sc.k32.OpenProcess(sc.PROCESS_QUERY_INFORMATION | sc.PROCESS_VM_READ, False, pid)
    mods = [m for m in pe.enum_modules(pid)
            if m['name'].lower().startswith('pokealliance') and 'launcher' not in m['name'].lower()]
    base = mods[0]['base']
    read = lambda va, n: sc.read_mem(h, va, n)
    p = struct.unpack('<Q', read(base + CHAIN_RVA, 8))[0]
    x, y, z = struct.unpack('<iih', read(p + POS, 10))
    sc.k32.CloseHandle(ctypes.c_void_p(h))
    return (x, y, z)


def variante_a(hwnd, x, y):
    """PostMessage puro."""
    lp = (y << 16) | (x & 0xFFFF)
    u32.PostMessageW(hwnd, 0x0200, 0, lp)
    time.sleep(0.02)
    u32.PostMessageW(hwnd, 0x0201, 1, lp)
    time.sleep(0.05)
    u32.PostMessageW(hwnd, 0x0202, 0, lp)


def variante_b(hwnd, x, y):
    """Ativa + foca antes."""
    u32.PostMessageW(hwnd, 0x0006, 1, 0)          # WM_ACTIVATE
    u32.PostMessageW(hwnd, 0x0007, 0, 0)          # WM_SETFOCUS
    time.sleep(0.05)
    variante_a(hwnd, x, y)


def variante_c(hwnd, x, y):
    """Cursor real + mouse_event (precisa foreground)."""
    u32.SetForegroundWindow(hwnd)
    time.sleep(0.15)
    pt = wintypes.POINT(x, y)
    u32.ClientToScreen(hwnd, ctypes.byref(pt))
    u32.SetCursorPos(pt.x, pt.y)
    time.sleep(0.05)
    u32.mouse_event(0x0002, 0, 0, 0, 0)           # LEFTDOWN
    time.sleep(0.06)
    u32.mouse_event(0x0004, 0, 0, 0, 0)           # LEFTUP


def main():
    pid = int(sys.argv[1])
    hwnd = janela(pid)
    if not hwnd:
        raise SystemExit('janela nao encontrada')
    print('hwnd=%#x' % hwnd)

    rect = wintypes.RECT()
    u32.GetClientRect(hwnd, ctypes.byref(rect))
    W = rect.right
    H = rect.bottom
    cx, cy = W // 2, H // 2
    TILE = 32
    print('cliente %dx%d  centro (%d,%d)' % (W, H, cx, cy))

    for nome, fn, alvo in (
        ('A PostMessage (dir)', variante_a, (cx + TILE, cy)),
        ('B Activate+Message (dir)', variante_b, (cx + TILE, cy)),
        ('C Cursor real (dir)', variante_c, (cx + TILE, cy)),
        ('A PostMessage (baixo)', variante_a, (cx, cy + TILE)),
        ('C Cursor real (baixo)', variante_c, (cx, cy + TILE)),
    ):
        antes = pos(pid)
        try:
            fn(hwnd, alvo[0], alvo[1])
        except Exception as e:
            print('  %-28s ERRO %s' % (nome, e))
            continue
        time.sleep(0.9)
        depois = pos(pid)
        delta = (depois[0] - antes[0], depois[1] - antes[1])
        marca = 'MOVEU' if delta != (0, 0) else 'parado'
        print('  %-28s %s -> %s  delta=%s  %s'
              % (nome, antes[:2], depois[:2], delta, marca))
        time.sleep(0.4)


if __name__ == '__main__':
    main()
