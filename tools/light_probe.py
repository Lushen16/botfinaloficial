"""Leitor leve: acha o player uma vez e depois só relê posição/hp/id.

Diferente de `scan_creatures.py` (RTTI sobre a imagem inteira + varredura de
instâncias a cada 8 s), aqui:
  - vtable do player vem por RVA do build (atalho), validado no ponteiro;
  - a busca inicial é por varredura de vtable (8 bytes), não por RTTI de imagem;
  - a amostragem lê só 0x200 bytes da entidade, com checagem de vtable/id.

Uso:
  python tools/light_probe.py --pid 123 --name Char --count 600 --interval 300
  python tools/light_probe.py --pid 123 --name Char --stream
"""

import argparse
import ctypes
import json
import struct
import sys
import time
from ctypes import wintypes

PLAYER_VTABLE_RVAS = (0x1FDB2A8,)  # build 2026-11-20
POS = 0x20
HP = 0xB0
ID = 0x4C
NAME = 0x70
TYPE = 0x176
SIZE = 0x200
MONSTER_VTABLE_RVA = 0x1FD9C48


def open_process(pid, limited=False):
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    handle = kernel.OpenProcess(0x1010 if limited else 0x0410, False, pid)  # LIMITED ou QUERY_INFORMATION | VM_READ
    if not handle:
        raise OSError('OpenProcess falhou: ' + str(ctypes.get_last_error()))
    return kernel, handle


def module_base(kernel, pid):
    TH32CS_SNAPMODULE = 0x8

    class ME(ctypes.Structure):
        _fields_ = [('dwSize', wintypes.DWORD), ('a', wintypes.DWORD), ('b', wintypes.DWORD),
                    ('c', wintypes.DWORD), ('d', wintypes.DWORD), ('modBaseAddr', ctypes.c_void_p),
                    ('modBaseSize', wintypes.DWORD), ('hModule', wintypes.HMODULE),
                    ('szModule', ctypes.c_char * 256), ('szExePath', ctypes.c_char * 260)]

    snap = kernel.CreateToolhelp32Snapshot(TH32CS_SNAPMODULE, pid)
    entry = ME()
    entry.dwSize = ctypes.sizeof(ME)
    while kernel.Module32Next(snap, ctypes.byref(entry)):
        name = entry.szModule.decode(errors='ignore').lower()
        if name.startswith('pokealliance') and 'launcher' not in name:
            kernel.CloseHandle(snap)
            return entry.modBaseAddr
    kernel.CloseHandle(snap)
    raise OSError('modulo do cliente nao encontrado')


def make_reader(kernel, handle):
    def read(address, size):
        buf = ctypes.create_string_buffer(size)
        got = ctypes.c_size_t()
        if not kernel.ReadProcessMemory(handle, ctypes.c_void_p(address), buf, size, ctypes.byref(got)):
            return None
        return buf.raw[:got.value]
    return read


class MBI(ctypes.Structure):
    _fields_ = [('BaseAddress', ctypes.c_void_p), ('AllocationBase', ctypes.c_void_p),
                ('AllocationProtect', wintypes.DWORD), ('RegionSize', ctypes.c_size_t),
                ('State', wintypes.DWORD), ('Protect', wintypes.DWORD), ('Type', wintypes.DWORD)]


def locate_by_vtable(kernel, handle, base, rva, name):
    """Varre regiões legíveis atrás do ponteiro de vtable. Leitura em blocos."""
    read = make_reader(kernel, handle)
    needle = struct.pack('<Q', base + rva)
    address = 0x10000
    limit = 0x7FFFFFFFFFFF
    while address < limit:
        mbi = MBI()
        if not kernel.VirtualQueryEx(handle, ctypes.c_void_p(address), ctypes.byref(mbi), ctypes.sizeof(mbi)):
            break
        region = mbi.BaseAddress or 0
        size = mbi.RegionSize
        readable = mbi.State == 0x1000 and (mbi.Protect & 0xEE)
        if readable and size <= 0x8000000:
            data = read(region, size)
            if data:
                start = 0
                while True:
                    index = data.find(needle, start)
                    if index < 0:
                        break
                    start = index + 1
                    entity = read(region + index, SIZE)
                    if not entity or len(entity) < SIZE:
                        continue
                    if struct.unpack('<Q', entity[:8])[0] != base + rva:
                        continue
                    raw = entity[NAME:NAME + 32].split(b'\0')[0]
                    if name.encode() not in raw:
                        continue
                    x, y = struct.unpack('<ii', entity[POS:POS + 8])
                    z = struct.unpack('<H', entity[POS + 8:POS + 10])[0]
                    if not (0 < x < 65535 and 0 < y < 65535 and z <= 15):
                        continue
                    return region + index
        address = region + size
    return None


def scan_hits(kernel, handle, base, vtable_rva):
    read = make_reader(kernel, handle)
    needle = struct.pack('<Q', base + vtable_rva)
    address = 0x10000
    limit = 0x7FFFFFFFFFFF
    found = []
    while address < limit:
        mbi = MBI()
        if not kernel.VirtualQueryEx(handle, ctypes.c_void_p(address), ctypes.byref(mbi), ctypes.sizeof(mbi)):
            break
        region = mbi.BaseAddress or 0
        size = mbi.RegionSize
        if mbi.State == 0x1000 and (mbi.Protect & 0xEE) and size <= 0x8000000:
            data = read(region, size)
            if data:
                start = 0
                while True:
                    index = data.find(needle, start)
                    if index < 0:
                        break
                    start = index + 1
                    hit = region + index
                    raw = read(hit, SIZE)
                    if not raw or len(raw) < SIZE:
                        continue
                    if struct.unpack('<Q', raw[:8])[0] != base + vtable_rva:
                        continue
                    x, y = struct.unpack('<ii', raw[POS:POS + 8])
                    z = struct.unpack('<H', raw[POS + 8:POS + 10])[0]
                    if not (0 < x < 65535 and 0 < y < 65535 and z <= 15):
                        continue
                    kind = raw[TYPE]
                    if kind not in (1, 3):
                        continue
                    found.append(hit)
        address = region + size
    return found


def crawl_creatures(read, player_va, base):
    """Le a lista de criaturas pelos containers do Tile do player, sem varrer a
    memoria: alguns ponteiros do Tile apontam para arrays de criaturas."""
    mon = base + MONSTER_VTABLE_RVA
    tile = struct.unpack('<Q', read(player_va + 0x9A8, 8))[0]
    if not tile:
        return []
    body = read(tile, 0x1000)
    if not body:
        return []
    found = {}
    seen = set()
    budget = 400

    def harvest(start):
        nonlocal budget
        data = read(start, 0x2000)
        if not data:
            return
        for i in range(0, len(data), 8):
            if struct.unpack('<Q', data[i:i + 8])[0] != mon:
                continue
            row = creature_row(read, start + i, mon)
            if row:
                row['_va'] = start + i
                found[row['id']] = row

    first_level = []
    for off in range(0, len(body), 8):
        ptr = struct.unpack('<Q', body[off:off + 8])[0]
        if not (0x1000000000 < ptr < 0x7f0000000000) or ptr in seen:
            continue
        seen.add(ptr)
        first_level.append(ptr)
        if budget <= 0:
            break
        budget -= 1
        harvest(ptr)
    # segundo nivel: containers dentro dos containers
    for ptr in first_level:
        inner = read(ptr, 0x1000)
        if not inner:
            continue
        for off in range(0, len(inner), 8):
            child = struct.unpack('<Q', inner[off:off + 8])[0]
            if not (0x1000000000 < child < 0x7f0000000000) or child in seen:
                continue
            seen.add(child)
            if budget <= 0:
                break
            budget -= 1
            harvest(child)
    return list(found.values())


def creature_row(read, address, vtable):
    raw = read(address, SIZE)
    if not raw or len(raw) < SIZE or struct.unpack('<Q', raw[:8])[0] != vtable:
        return None
    x, y = struct.unpack('<ii', raw[POS:POS + 8])
    z = struct.unpack('<H', raw[POS + 8:POS + 10])[0]
    if not (0 < x < 65535 and 0 < y < 65535 and z <= 15):
        return None
    return {'id': struct.unpack('<I', raw[ID:ID + 4])[0], 'type': raw[TYPE], 'hp': raw[HP],
            'pos': {'x': x, 'y': y, 'z': z},
            'name': raw[NAME:NAME + 32].split(b'\0')[0].decode(errors='replace')}


def snapshot(read, address, vtable):
    raw = read(address, SIZE)
    if not raw or len(raw) < SIZE:
        return None
    if struct.unpack('<Q', raw[:8])[0] != vtable:
        return None
    x, y = struct.unpack('<ii', raw[POS:POS + 8])
    z = struct.unpack('<H', raw[POS + 8:POS + 10])[0]
    hp = raw[HP]
    ident = struct.unpack('<I', raw[ID:ID + 4])[0]
    name = raw[NAME:NAME + 32].split(b'\0')[0].decode(errors='replace')
    if not (0 < x < 65535 and 0 < y < 65535 and z <= 15):
        return None
    return {'pos': {'x': x, 'y': y, 'z': z}, 'hp': hp, 'id': ident, 'name': name}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--pid', type=int, required=True)
    parser.add_argument('--name', required=True)
    parser.add_argument('--count', type=int, default=0)
    parser.add_argument('--interval', type=int, default=300)
    parser.add_argument('--stream', action='store_true')
    parser.add_argument('--creatures', action='store_true')
    parser.add_argument('--crawl', action='store_true')
    parser.add_argument('--limited', action='store_true')
    parser.add_argument('--rescan-ms', type=int, default=8000)
    args = parser.parse_args()

    kernel, handle = open_process(args.pid, args.limited)
    try:
        base = module_base(kernel, args.pid)
        read = make_reader(kernel, handle)
        address = None
        for rva in PLAYER_VTABLE_RVAS:
            address = locate_by_vtable(kernel, handle, base, rva, args.name)
            if address:
                vtable = base + rva
                break
        if not address:
            print(json.dumps({'ok': False, 'error': 'player nao encontrado'}))
            return 2
        print(json.dumps({'ok': True, 'va': hex(address), 'vtable': hex(vtable)}), flush=True)

        creature_vtable = base + MONSTER_VTABLE_RVA if args.creatures else None
        cached = []
        next_scan = 0.0
        limit = args.count if not args.stream else 10 ** 9
        done = 0
        last = None
        while done < limit:
            if args.crawl:
                now = time.time()
                if now >= next_scan or not cached:
                    cached = crawl_creatures(read, address, base)
                    next_scan = now + max(0.5, args.rescan_ms / 1000)
                creatures = [row for row in (creature_row(read, row['_va'], base + MONSTER_VTABLE_RVA)
                            for row in cached if row.get('_va')) if row] or cached
            elif creature_vtable is not None:
                now = time.time()
                if now >= next_scan or not cached:
                    cached = scan_hits(kernel, handle, base, MONSTER_VTABLE_RVA)
                    next_scan = now + max(1.0, args.rescan_ms / 1000)
                creatures = [row for row in (creature_row(read, va, creature_vtable) for va in cached) if row]
            elif creature_vtable is None:
                creatures = None
            sample = snapshot(read, address, vtable)
            if sample:
                if creatures is not None:
                    sample['creatures'] = creatures
                last = sample
                print(json.dumps({'at': time.time(), **sample}), flush=True)
                done += 1
            else:
                address = locate_by_vtable(kernel, handle, base, vtable - base, args.name)
                if not address:
                    print(json.dumps({'ok': False, 'error': 'entidade perdida'}), flush=True)
                    return 3
            time.sleep(max(0.05, args.interval / 1000))
        print(json.dumps({'ok': True, 'samples': done, 'last': last}))
        return 0
    finally:
        kernel.CloseHandle(handle)


if __name__ == '__main__':
    sys.exit(main())
