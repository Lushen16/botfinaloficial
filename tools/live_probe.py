"""Probe de baixo nivel do cliente PokeAlliance. Somente leitura.

Devolve JSON em uma linha no stdout. Cada comando tem um campo `ok` e, quando
falha, `error` + o codigo Win32. Nenhuma falha e' mascarada como lista vazia:

  proc    --pid N                 identidade do processo + modulos (falha explicita)
  entity  --pid N --name X        entidade do jogador pela vtable, com validacao
  sample  --pid N --name X --count C --interval MS
                                  posicoes ao longo do tempo (estabilidade)
  modhash --pid N --module M      hash da IMAGEM carregada (nao do arquivo)

Uso no validador: node tools/live_walk_validate.cjs
"""

import argparse
import ctypes
import hashlib
import json
import os
import struct
import sys
import time
from ctypes import wintypes

PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010
TH32CS_SNAPMODULE = 0x00000008
TH32CS_SNAPMODULE32 = 0x00000010
MEM_COMMIT = 0x1000
PAGE_GUARD = 0x100
READABLE = (0x02, 0x04, 0x20, 0x40, 0x80)  # READONLY/WRITECOPY/EXECUTE_READ/...

OFF_POS = 0x20
OFF_Z = 0x28
OFF_ID = 0x4C
OFF_NAME = 0x70
OFF_HP = 0xB0
OFF_TYPE = 0x176
ENTITY_SIZE = 0x190

# RVAs conhecidas da vtable de LocalPlayer. Sao ATALHO: validadas antes do uso.
PLAYER_VTABLE_RVAS = (0x1FDB2A8, 0x1FB5660, 0x1FAC310, 0x1F3F1F0)

k32 = ctypes.WinDLL('kernel32', use_last_error=True)
k32.OpenProcess.restype = wintypes.HANDLE
k32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE


class MBI(ctypes.Structure):
    _fields_ = [('BaseAddress', ctypes.c_ulonglong), ('AllocationBase', ctypes.c_ulonglong),
                ('AllocationProtect', wintypes.DWORD), ('__a1', wintypes.DWORD),
                ('RegionSize', ctypes.c_ulonglong), ('State', wintypes.DWORD),
                ('Protect', wintypes.DWORD), ('Type', wintypes.DWORD), ('__a2', wintypes.DWORD)]


class MODULEENTRY32(ctypes.Structure):
    _fields_ = [('dwSize', wintypes.DWORD), ('th32ModuleID', wintypes.DWORD),
                ('th32ProcessID', wintypes.DWORD), ('GlblcntUsage', wintypes.DWORD),
                ('ProccntUsage', wintypes.DWORD), ('modBaseAddr', ctypes.c_void_p),
                ('modBaseSize', wintypes.DWORD), ('hModule', wintypes.HMODULE),
                ('szModule', ctypes.c_char * 256), ('szExePath', ctypes.c_char * 260)]


k32.VirtualQueryEx.argtypes = [wintypes.HANDLE, ctypes.c_void_p, ctypes.POINTER(MBI), ctypes.c_size_t]
k32.VirtualQueryEx.restype = ctypes.c_size_t


def fail(error, **extra):
    out = {'ok': False, 'error': error}
    out.update(extra)
    return out


def open_proc(pid, access=None):
    handle = k32.OpenProcess(access or (PROCESS_QUERY_INFORMATION | PROCESS_VM_READ), False, pid)
    return handle or None


def exe_path(pid):
    h = open_proc(pid, PROCESS_QUERY_LIMITED_INFORMATION)
    if not h:
        return None, ctypes.get_last_error()
    buf = ctypes.create_unicode_buffer(1024)
    size = wintypes.DWORD(len(buf))
    ok = k32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size))
    err = ctypes.get_last_error()
    k32.CloseHandle(h)
    if not ok:
        return None, err
    return buf.value, 0


def window_titles(pid):
    user = ctypes.WinDLL('user32', use_last_error=True)
    found = []
    CB = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def cb(hwnd, _lp):
        owner = wintypes.DWORD()
        user.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        if owner.value != pid:
            return True
        title = ctypes.create_unicode_buffer(512)
        user.GetWindowTextW(hwnd, title, 512)
        rect = wintypes.RECT()
        user.GetClientRect(hwnd, ctypes.byref(rect))
        if title.value and rect.right > 0 and rect.bottom > 0:
            found.append({'hwnd': hex(hwnd), 'title': title.value,
                          'width': rect.right, 'height': rect.bottom,
                          'visible': bool(user.IsWindowVisible(hwnd)),
                          'foreground': user.GetForegroundWindow() == hwnd})
        return True

    user.EnumWindows(CB(cb), 0)
    return found


class MODULEENTRY32W(ctypes.Structure):
    _fields_ = [('dwSize', wintypes.DWORD), ('th32ModuleID', wintypes.DWORD),
                ('th32ProcessID', wintypes.DWORD), ('GlblcntUsage', wintypes.DWORD),
                ('ProccntUsage', wintypes.DWORD), ('modBaseAddr', ctypes.c_void_p),
                ('modBaseSize', wintypes.DWORD), ('hModule', wintypes.HMODULE),
                ('szModule', wintypes.WCHAR * 256), ('szExePath', wintypes.WCHAR * 260)]


def module_path_unicode(target_pid, base_addr):
    """Caminho do modulo com a placa de caracteres correta.

    szExePath de MODULEENTRY32 (ANSI) corrompe nomes com acento neste sistema
    (ex.: 'RECONSTRUCAO' vira mojibake) e o arquivo passa a "nao existir".
    GetModuleFileNameExW usa UTF-16 e devolve o caminho certo.
    """
    psapi = ctypes.WinDLL('psapi', use_last_error=True)
    psapi.GetModuleFileNameExW.argtypes = [wintypes.HANDLE, wintypes.HMODULE,
                                           wintypes.LPWSTR, wintypes.DWORD]
    psapi.GetModuleFileNameExW.restype = wintypes.DWORD
    h = open_proc(target_pid, PROCESS_QUERY_INFORMATION | PROCESS_VM_READ)
    if not h:
        return None, ctypes.get_last_error()
    try:
        buf = ctypes.create_unicode_buffer(1024)
        got = psapi.GetModuleFileNameExW(h, wintypes.HMODULE(base_addr), buf, 1024)
        if not got:
            return None, ctypes.get_last_error()
        return buf.value, 0
    finally:
        k32.CloseHandle(h)


def modules(pid, unicode_paths=True):
    """Lista de modulos. Falha de enumeracao NUNCA vira lista vazia."""
    if unicode_paths:
        snap = k32.CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid)
        if not snap or int(snap) == -1:
            return fail('CreateToolhelp32Snapshot', win32=ctypes.get_last_error())
        try:
            entry = MODULEENTRY32W()
            entry.dwSize = ctypes.sizeof(MODULEENTRY32W)
            rows = []
            if not k32.Module32FirstW(snap, ctypes.byref(entry)):
                err = ctypes.get_last_error()
                if err == 18:
                    return {'ok': True, 'modules': [], 'note': 'zero modulos (raro)'}
                return fail('Module32FirstW', win32=err)
            while True:
                path, perr = module_path_unicode(pid, int(entry.modBaseAddr or 0))
                rows.append({'name': entry.szModule,
                             'path': path or entry.szExePath,
                             'pathError': perr or None,
                             'base': int(entry.modBaseAddr or 0),
                             'size': int(entry.modBaseSize)})
                if not k32.Module32NextW(snap, ctypes.byref(entry)):
                    break
            if not rows:
                return fail('enumeracao retornou vazia')
            return {'ok': True, 'modules': rows}
        finally:
            k32.CloseHandle(snap)

    snap = k32.CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid)
    if not snap or int(snap) == -1:
        return fail('CreateToolhelp32Snapshot', win32=ctypes.get_last_error())
    try:
        entry = MODULEENTRY32()
        entry.dwSize = ctypes.sizeof(MODULEENTRY32)
        rows = []
        if not k32.Module32First(snap, ctypes.byref(entry)):
            err = ctypes.get_last_error()
            if err == 18:
                return {'ok': True, 'modules': [], 'note': 'zero modulos (raro)'}
            return fail('Module32First', win32=err)
        while True:
            rows.append({'name': entry.szModule.decode('latin1'),
                         'path': entry.szExePath.decode('latin1'),
                         'base': int(entry.modBaseAddr or 0),
                         'size': int(entry.modBaseSize)})
            if not k32.Module32Next(snap, ctypes.byref(entry)):
                break
        if not rows:
            return fail('enumeracao retornou vazia')
        return {'ok': True, 'modules': rows}
    finally:
        k32.CloseHandle(snap)


class Reader:
    def __init__(self, pid):
        self.pid = pid
        self.h = open_proc(pid)
        self.error = None if self.h else ctypes.get_last_error()
        self.hits = 0

    def read(self, addr, size):
        if not self.h:
            return b''
        buf = ctypes.create_string_buffer(size)
        got = ctypes.c_size_t(0)
        ok = k32.ReadProcessMemory(self.h, ctypes.c_void_p(addr), buf, size, ctypes.byref(got))
        return buf.raw[:got.value] if ok else b''

    def regions(self):
        addr = 0x10000
        limit = 0x7FFFFFFFFFFF
        while addr < limit:
            mbi = MBI()
            if not k32.VirtualQueryEx(self.h, ctypes.c_void_p(addr), ctypes.byref(mbi),
                                      ctypes.sizeof(mbi)):
                break
            base = mbi.BaseAddress
            size = mbi.RegionSize
            if size <= 0:
                break
            if (mbi.State == MEM_COMMIT and mbi.Protect in READABLE
                    and not (mbi.Protect & PAGE_GUARD)):
                yield base, size
            if base + size <= addr:
                break
            addr = base + size

    def close(self):
        if self.h:
            k32.CloseHandle(self.h)
            self.h = None


def game_module(pid):
    mods = modules(pid)
    if not mods['ok']:
        return mods
    for row in mods['modules']:
        if row['name'].lower() == 'pokealliance_dx.exe':
            return {'ok': True, 'module': row}
    return fail('PokeAlliance_dx.exe nao esta na lista de modulos')


def resolve_vtable(reader, base, image_size):
    """RVAs candidatas cujo primeiro slot aponta para dentro da imagem.

    O teste e' fraco e mais de uma RVA passa (0x1FAC310 e' o atalho de um build
    antigo e passava). Por isso devolve TODAS, na ordem fixa, e quem chama tenta
    cada uma ate' achar entidade valida.
    """
    tried = []
    good = []
    for rva in PLAYER_VTABLE_RVAS:
        va = base + rva
        raw = reader.read(va, 8)
        if len(raw) < 8:
            tried.append({'rva': hex(rva), 'error': 'ilegivel'})
            continue
        first = struct.unpack('<Q', raw)[0]
        inside = base <= first < base + image_size
        tried.append({'rva': hex(rva), 'firstSlot': hex(first), 'insideImage': inside})
        if inside:
            good.append(va)
    if not good:
        return fail('nenhuma vtable candidata valida', tried=tried)
    return {'ok': True, 'vtables': good, 'tried': tried}


def read_name(rd, raw, off):
    """Nome da entidade: ponteiro quando cap >= 16 (size pode ser 0)."""
    if off + 0x18 > len(raw):
        return ''
    ptr, size, cap = struct.unpack('<QQQ', raw[off:off + 0x18])
    if 16 <= cap <= 4096:
        want = size if 0 < size <= 32 else min(cap, 32)
        data = rd.read(ptr, want) or b''
        return data.split(b'\x00')[0].decode('latin1', 'replace')
    return raw[off:off + 32].split(b'\x00')[0].decode('latin1', 'replace')


def entity(pid, wanted, reader=None, base_info=None):
    own = reader is None
    rd = reader or Reader(pid)
    try:
        if not rd.h:
            return fail('OpenProcess', win32=rd.error)
        info = base_info
        if info is None:
            gm = game_module(pid)
            if not gm['ok']:
                return gm
            info = gm['module']
        base = info['base']
        size = info['size']
        vt = resolve_vtable(rd, base, size)
        if not vt['ok']:
            return vt
        valid = []
        rejected = []
        candidates = []
        used_vtable = None
        for vtable in vt['vtables']:
            pattern = struct.pack('<Q', vtable)
            candidates = []
            for rbase, rsize in rd.regions():
                off = 0
                while off < rsize:
                    chunk = min(0x100000, rsize - off)
                    data = rd.read(rbase + off, chunk)
                    if data:
                        pos = 0
                        while True:
                            idx = data.find(pattern, pos)
                            if idx < 0:
                                break
                            candidates.append(rbase + off + idx)
                            pos = idx + 1
                    off += chunk
            for va in candidates:
                raw = rd.read(va, ENTITY_SIZE)
                if len(raw) < ENTITY_SIZE:
                    rejected.append({'va': hex(va), 'vtable': hex(vtable), 'why': 'curto'})
                    continue
                x, y = struct.unpack('<ii', raw[OFF_POS:OFF_POS + 8])
                z = struct.unpack('<h', raw[OFF_Z:OFF_Z + 2])[0]
                eid = struct.unpack('<I', raw[OFF_ID:OFF_ID + 4])[0]
                name = read_name(rd, raw, OFF_NAME)
                hp = raw[OFF_HP]
                etype = raw[OFF_TYPE]
                reasons = []
                if not name:
                    reasons.append('sem nome')
                elif name.lower() != wanted.lower():
                    reasons.append('nome=' + name)
                if etype != 0:
                    reasons.append('type=' + str(etype))
                if eid == 0:
                    reasons.append('id=0')
                if not (0 <= x <= 65534 and 0 <= y <= 65534):
                    reasons.append('xy fora do mapa')
                if not (0 <= z <= 15):
                    reasons.append('z=' + str(z))
                if not (0 <= hp <= 100):
                    reasons.append('hp=' + str(hp))
                if reasons:
                    rejected.append({'va': hex(va), 'vtable': hex(vtable), 'why': ','.join(reasons)})
                    continue
                valid.append({'va': hex(va), 'id': eid, 'name': name,
                              'pos': {'x': x, 'y': y, 'z': z}, 'hp': hp, 'type': etype})
            if valid:
                used_vtable = vtable
                break
        if not valid:
            return fail('entidade do jogador nao encontrada',
                        vtable=hex(used_vtable or vt['vtables'][0]), candidates=len(candidates),
                        rejected=rejected[:6])
        positions = {json.dumps(v['pos'], sort_keys=True) for v in valid}
        if len(positions) > 1:
            return fail('instancias divergentes', instances=valid)
        first = dict(valid[0])
        first['instances'] = len(valid)
        first['candidates'] = len(candidates)
        return {'ok': True, 'entity': first, 'all': valid}
    finally:
        if own:
            rd.close()


def loaded_module_hash(pid, module_name):
    """Identidade do modulo carregado.

    NAO compara com o arquivo em disco: a imagem em memoria tem relocations
    aplicadas e ocupa SizeOfImage, enquanto o arquivo tem o layout de secoes e
    o tamanho do PE. Os dois hashes NUNCA batem por construcao — tratar isso
    como "versao diferente" seria erro de leitura.

    Em vez disso, devolve:
      - sha256 da imagem em memoria (base atual, relocations aplicadas);
      - sha256 do ARQUIVO que o loader teria aberto (via GetModuleFileNameEx),
        que e' a identidade real do artefato;
      - o RVA da primeira instrucao exportada, para correlacionar com o build.
    """
    mods = modules(pid)
    if not mods['ok']:
        return mods
    target = None
    for row in mods['modules']:
        if row['name'].lower() == module_name.lower():
            target = row
            break
    if target is None:
        return fail('modulo nao carregado', module=module_name)

    rd = Reader(pid)
    try:
        if not rd.h:
            return fail('OpenProcess', win32=rd.error)
        size = target['size']
        digest = hashlib.sha256()
        off = 0
        while off < size:
            chunk = min(0x100000, size - off)
            data = rd.read(target['base'] + off, chunk)
            if not data:
                return fail('leitura da imagem falhou', offset=hex(off))
            digest.update(data)
            off += len(data)
        image_hash = digest.hexdigest()
    finally:
        rd.close()

    # Hash do arquivo que o loader abriu (pode diferir do arquivo em disco hoje,
    # se ele foi substituido depois da injecao).
    disk = None
    disk_error = None
    try:
        with open(target['path'], 'rb') as fh:
            disk = hashlib.sha256(fh.read()).hexdigest()
    except OSError as exc:
        disk_error = str(exc)

    return {
        'ok': True,
        'module': target['name'],
        'path': target['path'],
        'base': hex(target['base']),
        'imageSize': size,
        'loadedImageSha256': image_hash,
        'fileOnDiskSha256': disk,
        'fileOnDiskError': disk_error,
        'comparable': False,
        'note': ('loadedImageSha256 e fileOnDiskSha256 NAO sao comparaveis: '
                 'a imagem tem relocations aplicadas e tamanho SizeOfImage. '
                 'Use fileOnDiskSha256 como identidade do artefato.'),
    }


def cmd_proc(args):
    path, err = exe_path(args.pid)
    mods = modules(args.pid)
    out = {'ok': True, 'pid': args.pid,
           'executable': os.path.basename(path) if path else None,
           'path': path, 'pathError': err or None,
           'windows': window_titles(args.pid),
           'moduleEnumeration': {'ok': mods['ok'],
                                 'error': mods.get('error'),
                                 'count': len(mods.get('modules', []))}}
    if mods['ok']:
        out['modules'] = [m['name'] for m in mods['modules']]
        out['suspicious'] = [m['name'] for m in mods['modules']
                             if any(k in m['name'].lower() for k in ('pka', 'shiba', 'tap', 'msftedit'))]
    return out


def cmd_entity(args):
    return entity(args.pid, args.name)


def cmd_sample(args):
    """Amostragem de estabilidade com criterios explicitos e mensuraveis.

    O gate NAO e' "100%" nem "80%" soltos. Ele exige, todos juntos:
      minValid    : leituras validas >= este numero (padrao 6)
      coverage    : janela observada >= minCoverageMs (padrao 1000ms)
      maxGap      : nenhuma lacuna entre leituras VALIDAS acima de maxGapMs
      singlePos   : todas as leituras validas na mesma posicao
      sameEntity  : mesmo id de criatura em todas as leituras validas

    Uma leitura indisponivel e' observacao perdida, nao movimento: ela e'
    contada como lacuna (que tem limite), nao como falha de estabilidade nem
    como prova de que o personagem ficou parado.

    DESEMPENHO: resolver a entidade exige VARRER a memoria do processo (~3 s).
    Fazer isso em cada amostra produz lacunas de segundos e torna `maxGap`
    inutil. Por isso: resolve UMA vez (varredura completa, com validacao) e
    depois relê o MESMO VA em modo rapido. A releitura valida nome, id, tipo,
    posicao e hp; se algo divergir, marca a amostra como `identityChanged` em
    vez de aceitar posicao de uma entidade diferente.
    """
    rd = Reader(args.pid)
    try:
        if not rd.h:
            return fail('OpenProcess', win32=rd.error)
        first = entity(args.pid, args.name, reader=rd)
        if not first.get('ok'):
            return first
        anchor = first['entity']
        anchor_va = int(anchor['va'], 16)
        anchor_id = anchor['id']
    finally:
        rd.close()

    samples = []

    def quick_read():
        """Rele o VA ancorado. Retorna dict no formato de `entity()`."""
        r = Reader(args.pid)
        try:
            if not r.h:
                return fail('OpenProcess', win32=r.error)
            raw = r.read(anchor_va, ENTITY_SIZE)
            name = read_name(r, raw, OFF_NAME) if len(raw) >= ENTITY_SIZE else ''
        finally:
            r.close()
        if len(raw) < ENTITY_SIZE:
            return fail('leitura curta no VA ancorado')
        x, y = struct.unpack('<ii', raw[OFF_POS:OFF_POS + 8])
        z = struct.unpack('<h', raw[OFF_Z:OFF_Z + 2])[0]
        eid = struct.unpack('<I', raw[OFF_ID:OFF_ID + 4])[0]
        hp = raw[OFF_HP]
        etype = raw[OFF_TYPE]
        reasons = []
        if not name or name.lower() != args.name.lower():
            reasons.append('nome=' + repr(name))
        if etype != 0:
            reasons.append('type=' + str(etype))
        if eid != anchor_id:
            reasons.append('id ' + str(eid) + ' != ' + str(anchor_id))
        if not (0 <= x <= 65534 and 0 <= y <= 65534):
            reasons.append('xy fora do mapa')
        if not (0 <= z <= 15):
            reasons.append('z=' + str(z))
        if not (0 <= hp <= 100):
            reasons.append('hp=' + str(hp))
        if reasons:
            return fail('identidade mudou: ' + ','.join(reasons),
                        identityChanged=True)
        return {'ok': True, 'entity': {'va': hex(anchor_va), 'id': eid, 'name': name,
                                       'pos': {'x': x, 'y': y, 'z': z}, 'hp': hp,
                                       'type': etype}}

    for i in range(args.count):
        if i == 0:
            res = {'ok': True, 'entity': anchor}
        else:
            res = quick_read()
        samples.append({'i': i, 'at': round(time.time(), 3), 'result': res})
        if i + 1 < args.count:
            time.sleep(args.interval / 1000.0)

    valid = [s for s in samples if s['result'].get('ok')]
    positions = []
    entity_ids = set()
    for s in valid:
        pos = s['result']['entity']['pos']
        key = (pos['x'], pos['y'], pos['z'])
        if not positions or positions[-1] != key:
            positions.append(key)
        entity_ids.add(s['result']['entity']['id'])

    sequence = [{'x': p[0], 'y': p[1], 'z': p[2]} for p in positions]

    coverage_ms = 0
    if len(samples) >= 2:
        coverage_ms = int(round((samples[-1]['at'] - samples[0]['at']) * 1000))

    gaps = []
    for a, b in zip(valid, valid[1:]):
        gaps.append(int(round((b['at'] - a['at']) * 1000)))
    max_gap = max(gaps) if gaps else coverage_ms

    checks = {
        'minValid': len(valid) >= args.min_valid,
        'coverage': coverage_ms >= args.min_coverage_ms,
        'maxGap': (max_gap <= args.max_gap_ms) if len(valid) >= 2 else False,
        'singlePos': len(sequence) == 1,
        'sameEntity': len(entity_ids) == 1,
    }

    return {
        'ok': all(checks.values()),
        'stable': all(checks.values()),
        'validReads': len(valid),
        'total': len(samples),
        'coverageMs': coverage_ms,
        'maxGapMs': max_gap,
        'checks': checks,
        'thresholds': {
            'minValid': args.min_valid,
            'minCoverageMs': args.min_coverage_ms,
            'maxGapMs': args.max_gap_ms,
        },
        'anchor': {'va': anchor['va'], 'id': anchor_id},
        'positions': [json.dumps({'x': p[0], 'y': p[1], 'z': p[2]}, sort_keys=True)
                      for p in positions],
        'sequence': sequence,
        'moved': len(sequence) > 1,
        'entityIds': sorted(entity_ids),
        'samples': [{'at': s['at'],
                     'pos': s['result']['entity']['pos'] if s['result'].get('ok') else None,
                     'id': s['result']['entity']['id'] if s['result'].get('ok') else None,
                     'error': s['result'].get('error')} for s in samples],
    }


def cmd_modhash(args):
    return loaded_module_hash(args.pid, args.module)


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('proc'); p.add_argument('--pid', type=int, required=True)
    p = sub.add_parser('entity'); p.add_argument('--pid', type=int, required=True)
    p.add_argument('--name', required=True)
    p = sub.add_parser('sample'); p.add_argument('--pid', type=int, required=True)
    p.add_argument('--name', required=True); p.add_argument('--count', type=int, default=8)
    p.add_argument('--interval', type=int, default=200)
    p.add_argument('--min-valid', dest='min_valid', type=int, default=6)
    p.add_argument('--min-coverage-ms', dest='min_coverage_ms', type=int, default=1000)
    p.add_argument('--max-gap-ms', dest='max_gap_ms', type=int, default=600)
    p = sub.add_parser('modhash'); p.add_argument('--pid', type=int, required=True)
    p.add_argument('--module', required=True)
    args = parser.parse_args()
    handler = {'proc': cmd_proc, 'entity': cmd_entity,
               'sample': cmd_sample, 'modhash': cmd_modhash}[args.cmd]
    try:
        result = handler(args)
    except Exception as exc:  # noqa: BLE001 - vira JSON de falha, nunca silencio
        result = fail('excecao', detail=repr(exc))
    # stdout sem BOM: quem consome e' Node, que trata o BOM como caractere.
    sys.stdout.write(json.dumps(result, ensure_ascii=False) + '\n')
    sys.stdout.flush()
    return 0 if result.get('ok') else 1


if __name__ == '__main__':
    sys.exit(main())
