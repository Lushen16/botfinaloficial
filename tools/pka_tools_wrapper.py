"""Entrypoint empacotado: le cadeia do player, criaturas e itens em modo GUI (sem console).

Feito para PyInstaller --windowed (GUI subsystem, sem console), replicando o
setup que sobreviveu nos testes de antiban.

Suporta dois modos:
  1. Streaming live para o app via --stream-port <porta> (--minutes 0 = continuo,
     sem IO em disco por amostra).
  2. Coleta offline com resumo/JSONL gravados uma unica vez ao encerrar (--out / --jsonl).
"""
import argparse, ctypes, json, os, socket, struct, sys, time
from pathlib import Path
from ctypes import wintypes

if getattr(sys, 'frozen', False):
    RAIZ = Path(sys._MEIPASS) if hasattr(sys, '_MEIPASS') else Path(sys.executable).parent
    TOOLS = RAIZ / 'tools'
    if not TOOLS.is_dir():
        TOOLS = Path(sys.executable).parent / 'tools'
else:
    TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))

try:
    import scan_creatures as sc
    import pointer_scan_entities as pe
    from chain_sampler import collect_creatures
    from tile_items import MAX_TILE_RADIUS, read_tile_items_around
except Exception as erro:                                  # pragma: no cover
    alvo = Path(os.environ.get('TEMP', '.')) / 'pka-tools-erro.json'
    alvo.write_text(json.dumps({'erro': 'import: %s' % erro, 'tools': str(TOOLS)}), encoding='utf-8')
    raise SystemExit(2)

POS, ID, NAME, HP, CANATTACK, TYPE = 0x20, 0x4C, 0x70, 0xB0, 0xB4, 0x176
_U32_STATE = {}


def _window_title_for_pid(pid):
    try:
        if 'u32' not in _U32_STATE:
            u32 = ctypes.WinDLL('user32', use_last_error=True)
            cb_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
            u32.OpenWindowStationW.argtypes = [wintypes.LPCWSTR, wintypes.BOOL, wintypes.DWORD]
            u32.OpenWindowStationW.restype = wintypes.HANDLE
            u32.SetProcessWindowStation.argtypes = [wintypes.HANDLE]
            u32.SetProcessWindowStation.restype = wintypes.BOOL
            u32.OpenDesktopW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
            u32.OpenDesktopW.restype = wintypes.HANDLE
            u32.SetThreadDesktop.argtypes = [wintypes.HANDLE]
            u32.SetThreadDesktop.restype = wintypes.BOOL
            u32.EnumDesktopWindows.argtypes = [wintypes.HANDLE, cb_type, wintypes.LPARAM]
            u32.EnumDesktopWindows.restype = wintypes.BOOL
            u32.EnumWindows.argtypes = [cb_type, wintypes.LPARAM]
            u32.EnumWindows.restype = wintypes.BOOL
            u32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
            u32.GetWindowThreadProcessId.restype = wintypes.DWORD
            u32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
            u32.GetWindowTextW.restype = wintypes.c_int
            u32.IsWindowVisible.argtypes = [wintypes.HWND]
            u32.IsWindowVisible.restype = wintypes.BOOL
            hwinsta = u32.OpenWindowStationW('WinSta0', False, 0x037F)
            if hwinsta:
                u32.SetProcessWindowStation(hwinsta)
            hdesk = u32.OpenDesktopW('Default', 0, False, 0x01FF)
            if hdesk:
                u32.SetThreadDesktop(hdesk)
            _U32_STATE.update(u32=u32, cb_type=cb_type, hdesk=hdesk)

        u32 = _U32_STATE['u32']
        cb_type = _U32_STATE['cb_type']
        hdesk = _U32_STATE['hdesk']
        found = []

        @cb_type
        def cb(hwnd, _lp):
            wpid = wintypes.DWORD(0)
            u32.GetWindowThreadProcessId(hwnd, ctypes.byref(wpid))
            if wpid.value == pid:
                buf = ctypes.create_unicode_buffer(256)
                n = u32.GetWindowTextW(hwnd, buf, 256)
                if n > 0:
                    found.append((bool(u32.IsWindowVisible(hwnd)), buf.value))
            return True

        if hdesk:
            u32.EnumDesktopWindows(hdesk, cb, 0)
        if not found:
            u32.EnumWindows(cb, 0)
        for vis, title in found:
            if vis:
                return title
        return found[0][1] if found else ''
    except Exception:
        return ''


def _resolve_name(read, bloco):
    raw = bloco[NAME:NAME + 24]
    inline = raw.split(b'\x00', 1)[0]
    if inline and all(32 <= b < 127 for b in inline):
        return inline.decode('utf-8', 'ignore')
    ptr, ln = struct.unpack_from('<Q', raw, 0)[0], struct.unpack_from('<Q', raw, 8)[0]
    if 0x10000 < ptr < 0x7ff000000000 and 0 < ln <= 32:
        heap = read(ptr, int(ln))
        if heap:
            return heap.split(b'\x00', 1)[0].decode('utf-8', 'ignore')
    return ''


def saida(caminho, dados):
    Path(caminho).parent.mkdir(parents=True, exist_ok=True)
    Path(caminho).write_text(json.dumps(dados, indent=1, ensure_ascii=False), encoding='utf-8')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--pid', type=int, required=True)
    ap.add_argument('--name', default=None)
    ap.add_argument('--chain-rva', type=lambda v: int(v, 0), default=0x3A03598)
    ap.add_argument('--creatures', action='store_true')
    ap.add_argument('--creature-chain-rva', type=lambda v: int(v, 0), default=None)
    ap.add_argument('--creature-list-kind', choices=('vector', 'array'), default='vector')
    ap.add_argument('--items', action='store_true')
    ap.add_argument('--tile-blocks-rva', type=lambda v: int(v, 0), default=None)
    ap.add_argument('--tile-radius', type=int, default=2)
    ap.add_argument('--minutes', type=float, default=10.0)
    ap.add_argument('--interval-ms', type=int, default=5000)
    ap.add_argument('--no-scan', action='store_true', help='proibe fallback de varredura de memoria')
    ap.add_argument('--stream-port', type=int, default=None)
    ap.add_argument('--out', default=None)
    ap.add_argument('--jsonl', default=None)
    args, _ = ap.parse_known_args()

    interval_ms = max(5000, int(args.interval_ms))
    tile_radius = max(0, min(int(args.tile_radius), MAX_TILE_RADIUS))
    keep_records = bool(args.jsonl)
    out = args.out
    inicio = time.time()
    amostras, com_player, sem_player, erros = 0, 0, 0, []
    primeira = ultima = None
    registros = []
    title_saw_valid = False
    title_lost_streak = 0
    abort_reason = None

    stream_sock = None
    if args.stream_port:
        try:
            stream_sock = socket.create_connection(('127.0.0.1', int(args.stream_port)), timeout=5.0)
        except Exception as e:
            if out:
                saida(out, {'erro': 'stream-connect: %s' % e, 'pid': args.pid})
            return 5

    handle = sc.k32.OpenProcess(sc.PROCESS_QUERY_INFORMATION | sc.PROCESS_VM_READ, False, args.pid)
    if not handle:
        if stream_sock:
            try:
                stream_sock.sendall((json.dumps({'seq': 1, 'sampledAtMs': int(time.time() * 1000),
                                                 'pid': args.pid, 'player': None, 'abort': 'open-process-failed'}) + '\n').encode('utf-8'))
            except Exception:
                pass
            stream_sock.close()
        if out:
            saida(out, {'erro': 'OpenProcess negado', 'pid': args.pid, 'inicio': inicio, 'fim': time.time()})
        return 3

    mods = [m for m in pe.enum_modules(args.pid)
            if m['name'].lower().startswith('pokealliance') and 'launcher' not in m['name'].lower()]
    if not mods:
        if stream_sock:
            stream_sock.close()
        if out:
            saida(out, {'erro': 'modulo nao encontrado', 'pid': args.pid})
        return 4
    base = mods[0]['base']
    read = lambda va, n: sc.read_mem(handle, va, n)

    try:
        while args.minutes <= 0 or (time.time() - inicio < args.minutes * 60):
            t = time.time()
            amostras += 1
            player = None
            player_stream = None
            creatures = []
            creatures_available = False
            items = []
            items_available = False
            title = _window_title_for_pid(args.pid)
            try:
                raw = read(base + args.chain_rva, 8)
                if raw and len(raw) == 8:
                    va = struct.unpack('<Q', raw)[0]
                    bloco = read(va, 0xB8)              # UMA leitura por amostra
                    if bloco and len(bloco) >= 0xB8:
                        x, y, z = struct.unpack_from('<iih', bloco, POS)
                        iv = struct.unpack_from('<I', bloco, ID)[0]
                        hp = bloco[HP]
                        nm = _resolve_name(read, bloco)
                        if 0 < x < 65536 and 0 < y < 65536 and 0 <= z < 16:
                            hp_val = hp if hp <= 100 else None
                            player = {'id': iv, 'name': nm, 'pos': [x, y, z], 'hp': hp_val}
                            player_stream = {
                                'id': iv, 'name': nm,
                                'pos': {'x': x, 'y': y, 'z': z},
                                'hp': hp_val, 'healthPercent': hp_val,
                                'struct_va': hex(va),
                            }
                if args.creatures and args.creature_chain_rva is not None:
                    creatures, creatures_available = collect_creatures(
                        read, base, args.creature_chain_rva, args.creature_list_kind
                    )
                if player_stream and args.items and args.tile_blocks_rva is not None:
                    p = player_stream['pos']
                    res = read_tile_items_around(
                        read, base, args.tile_blocks_rva, (p['x'], p['y'], p['z']), radius=tile_radius
                    )
                    items = res['items']
                    items_available = res['available'] is True
            except Exception as e:
                if len(erros) < 5:
                    erros.append(str(e)[:120])

            matched = bool(player and (args.name is None or player['name'].lower() == args.name.lower()))
            if matched:
                com_player += 1
                if primeira is None:
                    primeira = player
                ultima = player
                sem_player = 0
            else:
                player_stream = None
                sem_player += 1

            char_name = args.name or (player['name'] if player else '')
            expected_tag = (' - ' + char_name).lower() if char_name else ' - '
            if title and expected_tag in title.lower():
                title_saw_valid = True
                title_lost_streak = 0
            elif title or title_saw_valid:
                title_lost_streak += 1

            if stream_sock:
                frame = {
                    'seq': amostras,
                    'sampledAtMs': int(time.time() * 1000),
                    'pid': args.pid,
                    'player': player_stream,
                }
                if args.creatures:
                    frame['creatures'] = creatures
                    frame['creaturesAvailable'] = creatures_available
                if args.items:
                    frame['items'] = items
                    frame['itemsAvailable'] = items_available
                if title_lost_streak >= 2:
                    frame['abort'] = 'window-title-lost'
                elif sem_player >= 3:
                    frame['abort'] = 'null-streak'
                try:
                    stream_sock.sendall((json.dumps(frame, ensure_ascii=False) + '\n').encode('utf-8'))
                except Exception:
                    abort_reason = 'stream-closed'
                    break

            if keep_records:
                registros.append({
                    't': round(time.time(), 3),
                    'player': player,
                    'itemsAvailable': items_available,
                    'itemsCount': len(items),
                    'items': items,
                    'title': title,
                })

            if sem_player >= 3:
                abort_reason = 'null-streak'
                erros.append('3 amostras null seguidas; abortando')
                break
            if title_lost_streak >= 2:
                abort_reason = 'window-title-lost'
                erros.append('titulo sem - <Char> em 2 leituras; abortando')
                break

            espera = (interval_ms / 1000.0) - (time.time() - t)
            if espera > 0:
                time.sleep(espera)
    finally:
        if stream_sock:
            try:
                stream_sock.close()
            except Exception:
                pass
        try:
            sc.k32.CloseHandle(ctypes.c_void_p(handle))
        except Exception:
            pass
        if args.jsonl and registros:
            jp = Path(args.jsonl)
            jp.parent.mkdir(parents=True, exist_ok=True)
            jp.write_text('\n'.join(json.dumps(r, ensure_ascii=False) for r in registros) + '\n', encoding='utf-8')

    fim = time.time()
    if out or not args.stream_port:
        out_path = out or str(Path(os.environ.get('TEMP', '.')) / 'pka-tools-resumo.json')
        saida(out_path, {
            'pid': args.pid, 'chainRva': hex(args.chain_rva),
            'tileBlocksRva': hex(args.tile_blocks_rva) if args.tile_blocks_rva is not None else None,
            'inicio': inicio, 'fim': fim,
            'duracaoMin': round((fim - inicio) / 60, 2),
            'intervaloMs': interval_ms,
            'amostras': amostras, 'comPlayer': com_player,
            'primeira': primeira, 'ultima': ultima,
            'abortReason': abort_reason,
            'noScan': bool(args.no_scan),
            'erros': erros,
            'frozen': bool(getattr(sys, 'frozen', False)),
            'executavel': sys.executable,
        })
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
