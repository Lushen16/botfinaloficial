#!/usr/bin/env python3
"""Read-only creature scanner for PokeAlliance_dx.exe."""

import argparse
import ctypes
from ctypes import wintypes
import datetime
import json
import math
from pathlib import Path
import struct
import sys
import time

k32 = ctypes.WinDLL('kernel32', use_last_error=True)
PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010
MEM_COMMIT = 0x1000
PAGE_NOACCESS = 0x01
PAGE_GUARD = 0x100
IMAGE_NAME = "PokeAlliance_dx.exe"

class MEMORY_BASIC_INFORMATION64(ctypes.Structure):
    _fields_ = [
        ("BaseAddress", ctypes.c_uint64),
        ("AllocationBase", ctypes.c_uint64),
        ("AllocationProtect", wintypes.DWORD),
        ("__alignment1", wintypes.DWORD),
        ("RegionSize", ctypes.c_uint64),
        ("State", wintypes.DWORD),
        ("Protect", wintypes.DWORD),
        ("Type", wintypes.DWORD),
        ("__alignment2", wintypes.DWORD),
    ]

def image_for_pid(handle):
    buf = ctypes.create_unicode_buffer(1024)
    size = wintypes.DWORD(len(buf))
    if k32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)) :
        return buf.value
    return IMAGE_NAME

def readable(protect: int) -> bool:
    if protect & (PAGE_GUARD | PAGE_NOACCESS):
        return False
    return bool(protect & 0xEE)

def iter_regions(handle):
    address = 0
    mbi = MEMORY_BASIC_INFORMATION64()
    size = ctypes.sizeof(mbi)
    while address < 0x7FFFFFFFFFFF:
        res = k32.VirtualQueryEx(handle, ctypes.c_uint64(address), ctypes.byref(mbi), size)
        if not res:
            break
        yield mbi
        address = mbi.BaseAddress + mbi.RegionSize

class Layout:
    pos_offset = 0x30
    id_offset = 0x5C
    name_offset = 0x80
    hp_offset = 0xC0
    canattack_offset = 0xC4
    type_offset = 0x186
    z_offset = 0x38
    name_max = 32
    confirmed = ['pos', 'name', 'id', 'healthPercent', 'canAttack']

    def __init__(self, pos_offset=0x30, id_offset=0x5C, name_offset=0x80,
                 hp_offset=0xC0, canattack_offset=0xC4, type_offset=0x186, name_max=32):
        self.pos_offset = pos_offset
        self.z_offset = pos_offset + 8
        self.id_offset = id_offset
        self.name_offset = name_offset
        self.name_max = name_max
        self.hp_offset = hp_offset
        self.canattack_offset = canattack_offset
        self.type_offset = type_offset
        self.confirmed = Layout.confirmed

    @classmethod
    def from_dict(cls, spec):
        """Constroi a partir de creature_identity.layout_for_sha()."""
        return cls(pos_offset=spec['pos'], id_offset=spec['id'], name_offset=spec['name'],
                   hp_offset=spec['hp'], canattack_offset=spec['canAttack'],
                   type_offset=spec['type']) if spec else cls()

class Filters:
    def __init__(self, coord_min=1, coord_max=65535, z_max=15,
                 min_name_len=3, max_name_len=32, require_lowercase=False,
                 allowed_names=None, require_coords=True, enforce_field_ranges=True):
        self.coord_min = coord_min
        self.coord_max = coord_max
        self.z_max = z_max
        self.min_name_len = min_name_len
        self.max_name_len = max_name_len
        self.require_lowercase = require_lowercase
        self.allowed_names = allowed_names or frozenset()
        self.require_coords = require_coords
        self.enforce_field_ranges = enforce_field_ranges

def plausible_name(name, filters):
    if isinstance(name, str):
        name = name.encode('ascii', 'replace')
    if not isinstance(name, (bytes, bytearray)):
        return False
    if len(name) < filters.min_name_len or len(name) > filters.max_name_len:
        return False
    try:
        text = bytes(name).decode('ascii')
    except UnicodeDecodeError:
        return False
    if any(ord(character) < 0x20 or ord(character) > 0x7e for character in text):
        return False
    if filters.require_lowercase and text != text.lower():
        return False
    if filters.allowed_names and text.lower() not in filters.allowed_names:
        return False
    return True

def plausible_coords(x, y, z, filters):
    if not all(isinstance(value, int) for value in (x, y, z)):
        return False
    if not (filters.coord_min <= x <= filters.coord_max
            and filters.coord_min <= y <= filters.coord_max):
        return False
    return 0 <= z <= filters.z_max

def read_i32(data, offset):
    if data is None or offset < 0 or offset + 4 > len(data):
        return None
    return struct.unpack_from("<i", data, offset)[0]

def read_i16(data, offset):
    if data is None or offset < 0 or offset + 2 > len(data):
        return None
    return struct.unpack_from("<h", data, offset)[0]

def read_u32(data, offset):
    if data is None or offset < 0 or offset + 4 > len(data):
        return None
    return struct.unpack_from("<I", data, offset)[0]

def read_u8(data, offset):
    if data is None or offset < 0 or offset + 1 > len(data):
        return None
    return data[offset]

def find_pid_by_name(name):
    import subprocess
    target = str(name).strip()
    try:
        output = subprocess.check_output(
            ["tasklist.exe", "/FI", "IMAGENAME eq " + target, "/FO", "CSV", "/NH"],
            encoding="utf-8", errors="replace", timeout=5)
    except Exception:
        return None
    for line in output.splitlines():
        parts = [part.strip().strip('"') for part in line.split('","')]
        if len(parts) >= 2 and parts[0].lower() == target.lower():
            try:
                return int(parts[1])
            except ValueError:
                continue
    return None

def read_mem(handle, va, size):
    buf = (ctypes.c_char * size)()
    nread = ctypes.c_size_t()
    if k32.ReadProcessMemory(handle, ctypes.c_uint64(va), buf, size, ctypes.byref(nread)):
        return bytes(buf[:nread.value])
    return None

def scan_process(handle, pid, player_name="Nobutdopai"):
    import otclient_rtti as rtti
    import creature_identity as identity
    layout, filters = Layout(), Filters()
    sha = process_sha256(handle)
    if sha:
        layout = Layout.from_dict(identity.layout_for_sha(sha))
        print('[layout] build %s -> pos=%#x name=%#x hp=%#x id=%#x type=%#x'
              % (sha[:12], layout.pos_offset, layout.name_offset,
                 layout.hp_offset, layout.id_offset, layout.type_offset),
              file=sys.stderr, flush=True)
    player = locate_player(handle, pid, player_name, layout, filters)
    profile = resolve_stream_profile(handle, pid, int(player['vtable'], 16))
    addresses = rtti.scan_instances(handle, int(profile['creatureVtable'], 16))
    creatures = read_creatures(handle, addresses, profile, layout, filters)
    player = read_entity(handle, int(player['struct_va'], 16), layout)
    if not valid_player(player, player_name, filters):
        raise ValueError('player identity changed during creature scan')
    player['ownershipVerified'] = True
    return build_creature_snapshot(pid, player, creatures, profile, layout)


def process_sha256(handle):
    try:
        path = process_image_path(handle)
        return file_sha256(path) if path else None
    except OSError:
        return None

def process_image_path(handle):
    size = wintypes.DWORD(32768)
    buffer = ctypes.create_unicode_buffer(size.value)
    fn = k32.QueryFullProcessImageNameW
    fn.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    fn.restype = wintypes.BOOL
    if fn(handle, 0, buffer, ctypes.byref(size)):
        return buffer.value
    return None

def file_sha256(path):
    import hashlib
    digest = hashlib.sha256()
    with open(path, 'rb') as stream:
        for chunk in iter(lambda: stream.read(0x100000), b''):
            digest.update(chunk)
    return digest.hexdigest()

def read_entity(handle, va, layout):
    data = read_mem(handle, va, 0x190)
    if not data or len(data) < 0x190:
        return None
    vtable = struct.unpack_from("<Q", data, 0)[0]
    x, y = struct.unpack_from("<ii", data, layout.pos_offset)
    z = struct.unpack_from("<h", data, layout.z_offset)[0]
    cid = struct.unpack_from("<I", data, layout.id_offset)[0]
    raw_name = data[layout.name_offset:layout.name_offset + 32].split(b"\x00")[0]
    name = raw_name.decode("ascii", "replace")
    hp = data[layout.hp_offset]
    ctype = data[layout.type_offset]
    return {
        "struct_va": hex(va), "vtable": hex(vtable), "id": cid, "name": name,
        "pos": {"x": x, "y": y, "z": z}, "hp": hp, "healthPercent": hp,
        "creatureType": ctype, "canAttack": ctype == 1 and hp > 0,
        "isOwnPokemon": ctype == 3, "is_player": ctype == 0 and bool(name.strip()),
    }

def valid_player(entity, player_name, filters):
    return bool(entity) and entity['creatureType'] == 0 and entity['id'] > 0 \
        and int(entity['vtable'], 16) != 0 \
        and entity['name'].strip().lower() == player_name.strip().lower() \
        and plausible_name(entity['name'], filters) \
        and plausible_coords(entity['pos']['x'], entity['pos']['y'], entity['pos']['z'], filters)

def locate_player(handle, pid, player_name, layout, filters):
    import pointer_scan_entities as pe
    import pka_live_session as live
    if not isinstance(player_name, str) or not player_name.strip():
        raise ValueError('player name is required')
    def _is_client(module):
        name = module['name'].lower()
        return name.startswith('pokealliance') and name.endswith('.exe') and 'launcher' not in name
    module = next(module for module in pe.enum_modules(pid) if _is_client(module))
    candidate = live.resolve_chains(lambda address, size: read_mem(handle, address, size),
        module['base'], live.DEFAULT_CHAINS, layout, filters, player_name)
    if candidate:
        entity = read_entity(handle, int(candidate['struct_va'], 16), layout)
        if valid_player(entity, player_name, filters):
            return entity
    address = pe.locate_by_name(handle, player_name, layout, filters, id_offset=layout.id_offset)
    entity = read_entity(handle, address, layout) if address else None
    if not valid_player(entity, player_name, filters):
        raise ValueError('player not found or identity invalid')
    return entity

def read_creatures(handle, addresses, profile, layout, filters):
    creatures = []
    for address in addresses:
        entity = read_entity(handle, address, layout)
        if not entity or entity['vtable'] != profile['creatureVtable']:
            continue
        control = read_mem(handle, address, 24)
        if (not control or len(control) != 24 or struct.unpack_from('<I', control, 8)[0] == 0
                or struct.unpack_from('<Q', control, 16)[0] != int(profile['monsterVtable'], 16)):
            continue
        if entity['creatureType'] not in (0, 1, 3, 4) or not 0 <= entity['healthPercent'] <= 100:
            continue
        if not plausible_name(entity['name'], filters) or not plausible_coords(
                entity['pos']['x'], entity['pos']['y'], entity['pos']['z'], filters):
            continue
        entity['ownershipVerified'] = True
        creatures.append(entity)
    return creatures

def build_creature_snapshot(pid, player, creatures, profile, layout):
    return {'schema': 2, 'pid': pid, 'player': player,
        'layout': {'id_offset': hex(layout.id_offset), 'hp_offset': hex(layout.hp_offset),
            'canattack_offset': hex(layout.canattack_offset), 'type_offset': hex(layout.type_offset),
            'confirmed': layout.confirmed, 'identityProfile': profile},
        'creatures': creatures, 'generatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}

def identity_profile(handle, pid, creature_vtable, player_vtable):
    import pointer_scan_entities as pe
    module = None
    try:
        module = next(m for m in pe.enum_modules(pid) if m["name"].lower() == IMAGE_NAME.lower())
    except Exception:
        pass
    sha = process_sha256(handle)
    return {
        "executableSha256": sha,
        "typeOffset": hex(Layout.type_offset),
        "creatureVtable": hex(creature_vtable) if creature_vtable else None,
        "playerVtable": hex(player_vtable) if player_vtable else None,
        "moduleBase": hex(module["base"]) if module else None,
    }

def _write_json_atomic(path, value):
    import time
    target = Path(path)
    temporary = target.with_suffix(target.suffix + ".tmp")
    text = json.dumps(value, ensure_ascii=False)
    temporary.write_text(text, encoding="utf-8")
    for _ in range(4):
        try:
            temporary.replace(target)
            return
        except OSError:
            time.sleep(0.015)
    try:
        temporary.replace(target)
    except OSError:
        target.write_text(text, encoding="utf-8")

def resolve_stream_profile(handle, pid, player_vtable):
    import creature_identity as identity
    import pointer_scan_entities as pe
    import otclient_rtti as rtti

    module = next(module for module in pe.enum_modules(pid)
                  if module["name"].lower().startswith('pokealliance')
                  and 'launcher' not in module["name"].lower())
    profile = identity_profile(handle, pid, None, player_vtable)
    profile['layout'] = identity.verified_layout(profile['executableSha256'])
    profile['typeOffset'] = hex(profile['layout']['type'])
    image = rtti.read_module_image(handle, module["base"], module["size"])
    control = rtti.resolve_class(image, module["base"], "?$_Ref_count_obj2@VMonster@@@std")
    monster = rtti.resolve_class(image, module["base"], "Monster")
    if not control or not monster:
        raise ValueError("Monster RTTI unavailable; creature discovery blocked")
    profile["creatureVtable"] = hex(control["vtable"])
    profile["monsterVtable"] = hex(monster["vtable"])
    profile["moduleBase"] = hex(module["base"])
    return profile

def stream_snapshot(handle, pid, player_name, output, interval_ms=300, rescan_ms=8000):
    import threading
    import otclient_rtti as rtti
    filters = Filters()
    player = None
    # Builds >= 2026-11-09 usam layout shifted -0x10. Tentar esse primeiro
    # evita a varredura longa com offsets errados; o default fica de fallback.
    for layout in (Layout(0x20, 0x4C, 0x70, 0xB0, 0xB4, 0x176), Layout()):
        try:
            player = locate_player(handle, pid, player_name, layout, filters)
            break
        except ValueError:
            continue
    if player is None:
        print(json.dumps({'error': 'player not found or identity invalid', 'pid': pid}),
              file=sys.stderr, flush=True)
        return 2
    player_va = int(player['struct_va'], 16)
    profile = resolve_stream_profile(handle, pid, int(player['vtable'], 16))
    creature_vtable = int(profile['creatureVtable'], 16)
    state = {'creature_vas': [], 'player_va': player_va}

    def rescan():
        while True:
            try:
                if not valid_player(read_entity(handle, state['player_va'], layout), player_name, filters):
                    relocated = locate_player(handle, pid, player_name, layout, filters)
                    state['player_va'] = int(relocated['struct_va'], 16)
                state['creature_vas'] = rtti.scan_instances(handle, creature_vtable)
            except Exception:
                pass
            time.sleep(max(1.0, rescan_ms / 1000))

    try:
        state['creature_vas'] = rtti.scan_instances(handle, creature_vtable)
    except Exception:
        pass
    threading.Thread(target=rescan, name='creature-rescan', daemon=True).start()
    try:
        while True:
            try:
                current_player = read_entity(handle, state['player_va'], layout)
                if not valid_player(current_player, player_name, filters):
                    raise ValueError('player identity unavailable; snapshot not refreshed')
                creatures = read_creatures(handle, list(state['creature_vas']), profile, layout, filters)
                current_player['ownershipVerified'] = True
                snapshot = build_creature_snapshot(pid, current_player, creatures, profile, layout)
                _write_json_atomic(output, snapshot)
            except Exception:
                pass
            time.sleep(max(0.05, interval_ms / 1000.0))
    except KeyboardInterrupt:
        return 0

def run_selftest(output_path=None):
    snapshot = {
        "schema": 2,
        "pid": 1234,
        "player": {"name": "Player", "pos": {"x": 120, "y": 456, "z": 7}, "struct_va": "0x123456"},
        "layout": {
            "id_offset": "0x5c",
            "hp_offset": "0xc0",
            "canattack_offset": "0xc4",
            "confirmed": ["pos", "name", "id", "healthPercent", "canAttack"]
        },
        "creatures": [
            {
                "id": 1001,
                "name": "Charizard",
                "pos": {"x": 123, "y": 456, "z": 7},
                "hp": 87,
                "healthPercent": 87,
                "canAttack": True,
                "creatureType": 1,
                "isOwnPokemon": False,
                "is_player": False,
                "struct_va": "0x789abc"
            }
        ],
        "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat()
    }
    if output_path:
        Path(output_path).write_text(json.dumps(snapshot, indent=2), encoding="utf-8")
    return snapshot

def main():
    parser = argparse.ArgumentParser(description="Read-only creature scanner for PokeAlliance_dx.exe")
    parser.add_argument("--pid", type=int, default=25492)
    parser.add_argument("--player-name", default="Nobutdopai")
    parser.add_argument("--count", type=int, default=1)
    parser.add_argument("--output", type=Path, default=None)
    parser.add_argument("--selftest", action="store_true")
    parser.add_argument("--stream", action="store_true")
    parser.add_argument("--interval-ms", type=int, default=300)
    parser.add_argument("--rescan-ms", type=int, default=8000)
    args, unknown = parser.parse_known_args()
    
    if args.selftest:
        snapshot = run_selftest(args.output)
        print(json.dumps(snapshot, indent=2))
        return 0
        
    handle = k32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, args.pid)
    if not handle:
        print(f"Error: cannot open process {args.pid}", file=sys.stderr)
        return 1
        
    try:
        if args.stream:
            return stream_snapshot(handle, args.pid, args.player_name,
                args.output or Path("live-creatures.json"), args.interval_ms, args.rescan_ms)
        for i in range(args.count):
            snapshot = scan_process(handle, args.pid, args.player_name)
            doc_str = json.dumps(snapshot, indent=2)
            if args.output:
                args.output.write_text(doc_str, encoding="utf-8")
            print(doc_str)
            if i < args.count - 1:
                time.sleep(args.interval_ms / 1000.0)
    finally:
        k32.CloseHandle(handle)
    return 0

if __name__ == "__main__":
    sys.exit(main())
