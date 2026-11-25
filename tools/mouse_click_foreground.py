"""Testa clique com cursor real e jogo em foreground, na mesma sequencia.

Se o cliente le GetCursorPos() em vez do lParam do WM_LBUTTONDOWN, apenas
PostMessage nunca funciona: precisa posicionar o cursor de verdade.

Sequencia por teste:
  1. SetForegroundWindow + BringWindowToTop + SetFocus
  2. confirma que ficou em foreground (senao aborta)
  3. SetCursorPos para a coordenada de cliente convertida
  4. mouse_event LEFTDOWN/LEFTUP
  5. espera e le a posicao
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

HWND_TOPMOST = -1
SW_RESTORE = 9


def achar(pid):
    CB = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    out = {}
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
                    out['h'] = hwnd
                    return False
        return True
    u32.EnumWindows(cb, 0)
    return out.get('h')


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


def focar(hwnd):
    u32.ShowWindow(hwnd, SW_RESTORE)
    u32.BringWindowToTop(hwnd)
    ok = u32.SetForegroundWindow(hwnd)
    u32.SetFocus(hwnd)
    time.sleep(0.3)
    return u32.GetForegroundWindow() == hwnd


def clicar(hwnd, x, y):
    pt = wintypes.POINT(x, y)
    if not u32.ClientToScreen(hwnd, ctypes.byref(pt)):
        raise ValueError('ClientToScreen falhou')
    if not u32.SetCursorPos(pt.x, pt.y):
        raise ValueError('SetCursorPos falhou')
    time.sleep(0.08)
    # confirma onde o cursor realmente esta (SetCursorPos pode ser freado)
    atual = wintypes.POINT()
    u32.GetCursorPos(ctypes.byref(atual))
    if (atual.x, atual.y) != (pt.x, pt.y):
        raise ValueError('cursor nao chegou: pedido (%d,%d) real (%d,%d)'
                         % (pt.x, pt.y, atual.x, atual.y))
    u32.mouse_event(0x0002, 0, 0, 0, 0)   # LEFTDOWN
    time.sleep(0.08)
    u32.mouse_event(0x0004, 0, 0, 0, 0)   # LEFTUP
    return (pt.x, pt.y)


def main():
    pid = int(sys.argv[1])
    hwnd = achar(pid)
    if not hwnd:
        raise SystemExit('janela nao encontrada')
    rect = wintypes.RECT()
    u32.GetClientRect(hwnd, ctypes.byref(rect))
    W, H = rect.right, rect.bottom
    cx, cy = W // 2, H // 2
    print('hwnd=%#x cliente=%dx%d centro=(%d,%d)' % (hwnd, W, H, cx, cy))

    for nome, dx, dy in (('direita +1 tile', 32, 0),
                         ('baixo +1 tile', 0, 32),
                         ('esquerda -1 tile', -32, 0),
                         ('acima -1 tile', 0, -32)):
        antes = pos(pid)
        ok = focar(hwnd)
        if not ok:
            print('  %-20s SEM FOREGROUND — pulando' % nome)
            continue
        try:
            alvo = clicar(hwnd, cx + dx, cy + dy)
        except Exception as e:
            print('  %-20s ERRO %s' % (nome, e))
            continue
        time.sleep(1.0)
        depois = pos(pid)
        delta = (depois[0] - antes[0], depois[1] - antes[1])
        print('  %-20s fg=OK clique=%s  %s -> %s delta=%s %s'
              % (nome, alvo, antes[:2], depois[:2], delta,
                 'MOVEU' if delta != (0, 0) else 'parado'))
        time.sleep(0.5)


if __name__ == '__main__':
    main()
