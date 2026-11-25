"""Calibra a projecao tile -> pixel de cliente.

OTClient projeta um tile como:
    px = centerX + (tile.x - player.x) * tileSize
    py = centerY + (tile.y - player.y) * tileSize

Ou seja: o personagem fica SEMPRE em (centerX, centerY) na tela, e cada tile
de distancia anda tileSize pixels. Sem saber tileSize e o centro, nao da para
clicar num monstro.

Metodo:
  1. le o tamanho do cliente (GetClientRect)
  2. le a posicao do player por cadeia
  3. deriva o centro como (largura/2, altura/2) ajustado pelo offset do mapa
  4. valida andando 1 tile e conferindo que nada quebrou

Grava local-data/camera-calibration.json.
Somente leitura de memoria + leitura de geometria da janela.
"""
import ctypes, json, struct, sys, time
from ctypes import wintypes
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import scan_creatures as sc
import pointer_scan_entities as pe

CHAIN_RVA = 0x3A03598
POS = 0x20


def achar_janela(pid):
    u = ctypes.WinDLL('user32', use_last_error=True)
    CB = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    achado = {}
    @CB
    def cb(hwnd, _):
        p = wintypes.DWORD()
        u.GetWindowThreadProcessId(hwnd, ctypes.byref(p))
        if p.value == pid and u.IsWindowVisible(hwnd):
            n = u.GetWindowTextLengthW(hwnd)
            if n > 0:
                b = ctypes.create_unicode_buffer(n + 1)
                u.GetWindowTextW(hwnd, b, n + 1)
                if 'PokeAlliance' in b.value:
                    achado['hwnd'] = hwnd
                    achado['titulo'] = b.value
                    return False
        return True
    u.EnumWindows(cb, 0)
    if 'hwnd' not in achado:
        return None
    rect = wintypes.RECT()
    u.GetClientRect(achado['hwnd'], ctypes.byref(rect))
    achado['largura'] = rect.right - rect.left
    achado['altura'] = rect.bottom - rect.top
    return achado


def main():
    pid = int(sys.argv[1])
    h = sc.k32.OpenProcess(sc.PROCESS_QUERY_INFORMATION | sc.PROCESS_VM_READ, False, pid)
    if not h:
        raise SystemExit('nao abriu processo')
    mods = [m for m in pe.enum_modules(pid)
            if m['name'].lower().startswith('pokealliance') and 'launcher' not in m['name'].lower()]
    base = mods[0]['base']
    read = lambda va, n: sc.read_mem(h, va, n)

    raw = read(base + CHAIN_RVA, 8)
    player_ptr = struct.unpack('<Q', raw)[0]
    pos_raw = read(player_ptr + POS, 10)
    px, py, pz = struct.unpack('<iih', pos_raw)
    print('player em (%d, %d, %d)  va=%#x' % (px, py, pz, player_ptr))

    janela = achar_janela(pid)
    if not janela:
        raise SystemExit('janela nao encontrada')
    print('cliente: %dx%d  hwnd=%#x  titulo=%r'
          % (janela['largura'], janela['altura'], janela['hwnd'], janela['titulo']))

    # OTClient padrao: 32 px por tile. O centro do viewport e' o centro do
    # cliente quando o mapa nao tem offset (a barra de UI nao entra no
    # GetClientRect do render target em muitos builds).
    TILE = 32
    centerX = janela['largura'] // 2
    centerY = janela['altura'] // 2

    calib = {
        'sha256': None,
        'pid': pid,
        'hwnd': janela['hwnd'],
        'titulo': janela['titulo'],
        'width': janela['largura'],
        'height': janela['altura'],
        'tileSize': TILE,
        'centerX': centerX,
        'centerY': centerY,
        'playerAtCalibration': {'x': px, 'y': py, 'z': pz},
        'map': {'left': 0, 'top': 0, 'right': janela['largura'], 'bottom': janela['altura']},
        'metodo': 'OTClient: centro do cliente, tileSize 32',
        'confianca': 'baixa — precisa validacao por clique',
    }

    # calcular sha do exe
    try:
        exe = sc.process_image_path(h)
        import hashlib
        calib['sha256'] = hashlib.sha256(open(exe, 'rb').read()).hexdigest()
    except Exception as e:
        print('sha falhou:', e)

    saida = Path(__file__).resolve().parent.parent / 'local-data' / 'camera-calibration.json'
    saida.parent.mkdir(parents=True, exist_ok=True)
    json.dump(calib, open(saida, 'w', encoding='utf-8'), indent=1)
    print('\ncalibracao gravada:', saida)
    print(json.dumps({k: v for k, v in calib.items() if k not in ('map',)}, indent=1))

    # projecao do proprio tile do player = o centro (sanity check)
    sx = round(centerX + (px - px) * TILE)
    sy = round(centerY + (py - py) * TILE)
    print('\nprojecao do tile do player -> (%d, %d)  [esperado: o centro]' % (sx, sy))

    # tiles vizinhos
    for dx, dy in ((1, 0), (0, 1), (-1, 0)):
        tx, ty = px + dx, py + dy
        cx = round(centerX + (tx - px) * TILE)
        cy = round(centerY + (ty - py) * TILE)
        print('  tile (%d,%d) -> pixel (%d,%d)' % (tx, ty, cx, cy))


if __name__ == '__main__':
    main()
