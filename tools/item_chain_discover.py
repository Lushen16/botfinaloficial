"""Descobre o container de ITENS/CORPOS no build atual.

Mesma tecnica do creature_chain_discover: procura std::vector em .data/.rdata
cujo conteudo resolva para estruturas com posicao perto do player e id valido.

Criterio refinado:
  - pos plausivel (0 < x,y < 65536, 0 <= z < 16)
  - quando player conhecido: mesmo andar (z == player.z) e dist <= 15
  - exclui familias de criatura/player (0x1, 0x4, 0x8) para escolha de item
  - exige id (0x4C) ou itemId (0xC4/0xD4) nao nulo
  - >= 1 item valido nas 3 amostras a 5 s (estabilidade do RVA)

Protecao anti-ban:
  - Por padrao NAO revarre .data/.rdata quando local-data/item-chain.json ja
    possui candidatos (revalida apenas os RVAs salvos).
  - Usa guarda de 30 min em local-data/chain-scan-guard.json; --fresh forca.
  - --validate-only garante zero varredura de secoes.
"""
import argparse
import json
import struct
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import scan_creatures as sc
import pointer_scan_entities as pe
from tile_items import DEFAULT_TILE_BLOCKS_RVA, ITEM_ID_OFFSET, read_tile_items_around

POS, ID, NAME, HP, CANATTACK, TYPE = 0x20, 0x4C, 0x70, 0xB0, 0xB4, 0x176
ITEM_ID_C4, ITEM_ID_D4 = 0xC4, ITEM_ID_OFFSET
MAX_ITENS = 512
CREATURE_RVA = 0x39fb498          # ja conhecido: nao reportar como item
DEFAULT_PLAYER_RVA = 0x3A03598    # build ed2560a0
CREATURE_FAMILIES = (0x1, 0x4, 0x8)


def _discover_tile_items(read, base, tile_blocks_rva, player_pos, radius=2):
    res = read_tile_items_around(read, base, tile_blocks_rva, player_pos, radius=radius)
    if not res or not res.get('available'):
        return None
    px, py, _ = player_pos
    items = res['items']
    return {
        'mapTileBlocksRva': res['tileBlocksRva'],
        'tileVtableRva': res['tileVtableRva'],
        'tileThingsOffset': res['tileThingsOffset'],
        'tilePosOffset': res['tilePosOffset'],
        'itemVtableRva': res['itemVtableRva'],
        'itemPosOffset': res['itemPosOffset'],
        'itemIdOffset': res['itemIdOffset'],
        'radius': res['radius'],
        'itemsCount': len(items),
        'sampleTopItems': [
            {
                'id': it['id'],
                'stack': it['stack'],
                'pos': [it['pos']['x'], it['pos']['y'], it['pos']['z']],
                'dist': abs(it['pos']['x'] - px) + abs(it['pos']['y'] - py),
                'va': it['va'],
            }
            for it in items if it['stack'] > 0
        ][:12],
    }


def _block_name(read, blk, offset):
    raw = blk[offset:offset + 24]
    inline = raw.split(b'\x00', 1)[0]
    if inline and all(32 <= b < 127 for b in inline):
        return inline.decode('utf-8', 'ignore')
    pointer, length = struct.unpack_from('<Q', raw, 0)[0], struct.unpack_from('<Q', raw, 8)[0]
    if not (0x10000 < pointer < 0x7ff000000000) or not (0 < length <= 32):
        return ''
    heap = read(pointer, int(length))
    if not heap:
        return ''
    text = heap.split(b'\x00', 1)[0]
    if text and all(32 <= b < 127 for b in text):
        return text.decode('utf-8', 'ignore')
    return ''


def read_player_pos(read, base, player_rva):
    raw = read(base + player_rva, 8)
    if not raw or len(raw) < 8:
        return None
    pr = struct.unpack('<Q', raw)[0]
    if not (0x10000 < pr < 0x7ff000000000):
        return None
    blk = read(pr, 0xB8)
    if not blk or len(blk) < POS + 10:
        return None
    x, y, z = struct.unpack_from('<iih', blk, POS)
    if not (0 < x < 65536 and 0 < y < 65536 and 0 <= z < 16):
        return None
    return (x, y, z)


def ler_ent(read, va, player_pos=None, max_dist=15):
    blk = read(va, 0x180)
    if not blk or len(blk) < 0x180:
        return None
    x, y, z = struct.unpack_from('<iih', blk, POS)
    if not (0 < x < 65536 and 0 < y < 65536 and 0 <= z < 16):
        return None
    dist = None
    if player_pos is not None:
        px, py, pz = player_pos
        dist = abs(x - px) + abs(y - py)
        if z != pz or dist > max_dist:
            return None
    iv = struct.unpack_from('<I', blk, ID)[0]
    c4 = struct.unpack_from('<H', blk, ITEM_ID_C4)[0]
    d4 = struct.unpack_from('<H', blk, ITEM_ID_D4)[0]
    if iv == 0xFFFFFFFF:
        return None
    if iv == 0 and c4 == 0 and d4 == 0:
        return None
    nome = _block_name(read, blk, NAME)
    tipo = blk[TYPE]
    return {
        'va': hex(va),
        'id': iv,
        'idHex': hex(iv),
        'c4': c4,
        'd4': d4,
        'name': nome,
        'pos': [x, y, z],
        'dist': dist,
        'type': tipo,
        'isCreatureFamily': (iv >> 28) in CREATURE_FAMILIES,
    }


def ler_vetor(read, bg, en, player_pos=None, max_dist=15):
    if not (0x10000 < bg < 0x7ff000000000 and 0x10000 < en < 0x7ff000000000):
        return []
    d = en - bg
    if d <= 0 or d % 8 or d > MAX_ITENS * 8:
        return []
    dados = read(bg, d)
    if not dados or len(dados) != d:
        return []
    out = []
    for i in range(d // 8):
        p = struct.unpack_from('<Q', dados, i * 8)[0]
        if not (0x10000 < p < 0x7ff000000000):
            continue
        e = ler_ent(read, p, player_pos=player_pos, max_dist=max_dist)
        if e:
            out.append(e)
    return out


def main():
    ap = argparse.ArgumentParser(description='Descobre/valida container de itens/corpos.')
    ap.add_argument('pid', type=int)
    ap.add_argument('--validate-only', action='store_true',
                    help='Nao varre .data/.rdata; revalida apenas RVAs do cache ou --rvas.')
    ap.add_argument('--fresh', action='store_true',
                    help='Ignora cache/guarda e faz nova varredura de .data/.rdata.')
    ap.add_argument('--player-rva', type=lambda v: int(v, 0), default=DEFAULT_PLAYER_RVA)
    ap.add_argument('--tile-blocks-rva', type=lambda v: int(v, 0), default=DEFAULT_TILE_BLOCKS_RVA)
    ap.add_argument('--radius', type=int, default=2)
    ap.add_argument('--max-dist', type=int, default=15)
    ap.add_argument('--rvas', default=None, help='Lista de RVAs hex separados por virgula.')
    args = ap.parse_args()

    h = sc.k32.OpenProcess(sc.PROCESS_QUERY_INFORMATION | sc.PROCESS_VM_READ, False, args.pid)
    if not h:
        raise SystemExit('nao abriu processo')
    mods = [m for m in pe.enum_modules(args.pid)
            if m['name'].lower().startswith('pokealliance') and 'launcher' not in m['name'].lower()]
    if not mods:
        raise SystemExit('modulo pokealliance nao encontrado')
    base = mods[0]['base']
    read = lambda va, n: sc.read_mem(h, va, n)
    img_path = sc.process_image_path(h)
    sha = sc.file_sha256(img_path)

    img = open(img_path, 'rb').read(0x600)
    pe_off = struct.unpack_from('<I', img, 0x3C)[0]
    nsec = struct.unpack_from('<H', img, pe_off + 6)[0]
    opt = struct.unpack_from('<H', img, pe_off + 20)[0]
    sec_off = pe_off + 24 + opt
    secoes = []
    for i in range(nsec):
        off = sec_off + i * 40
        nome = img[off:off + 8].rstrip(b'\x00').decode(errors='ignore')
        vs = struct.unpack_from('<I', img, off + 8)[0]
        rva = struct.unpack_from('<I', img, off + 12)[0]
        secoes.append((nome, rva, vs))

    player_pos = read_player_pos(read, base, args.player_rva)
    print('base %#x | pid %d | sha %s | player %s'
          % (base, args.pid, sha[:12], player_pos))

    raiz = Path(__file__).resolve().parent.parent
    saida = raiz / 'local-data' / 'item-chain.json'
    guard_path = raiz / 'local-data' / 'chain-scan-guard.json'

    cached_rvas = []
    cached_meta = {}
    if saida.is_file():
        try:
            old = json.loads(saida.read_text(encoding='utf-8'))
            old_sha = old.get('sha')
            if old_sha is None or old_sha == sha:
                for c in old.get('candidatos', []):
                    r = int(c['rva'], 16) if isinstance(c['rva'], str) else int(c['rva'])
                    if r != CREATURE_RVA:
                        cached_rvas.append(r)
                        cached_meta[r] = c
        except (OSError, ValueError, KeyError):
            pass

    if args.rvas:
        explicit_rvas = [int(v.strip(), 0) for v in args.rvas.split(',') if v.strip()]
    else:
        explicit_rvas = []

    candidatos = []
    if args.validate_only or (not args.fresh and (explicit_rvas or cached_rvas)):
        rvas_alvo = explicit_rvas or cached_rvas
        if not rvas_alvo:
            raise SystemExit('sem RVAs no cache para validar (use --rvas ou --fresh)')
        print('modo sem varredura: validando %d RVAs conhecidos (z==%s, dist<=%d)'
              % (len(rvas_alvo), player_pos[2] if player_pos else '?', args.max_dist))
        for r in rvas_alvo:
            if r in (CREATURE_RVA, CREATURE_RVA + 8, CREATURE_RVA + 16, CREATURE_RVA + 24):
                continue
            raw = read(base + r, 24)
            ents = []
            n_slots = 0
            if raw and len(raw) == 24:
                bg, en, cp = struct.unpack('<QQQ', raw)
                if 0x10000 < bg < 0x7ff000000000 and en >= bg and (en - bg) % 8 == 0 and (en - bg) <= MAX_ITENS * 8:
                    n_slots = (en - bg) // 8
                    ents = ler_vetor(read, bg, en, player_pos=player_pos, max_dist=args.max_dist)
            items = [e for e in ents if not e['isCreatureFamily']]
            familias = {}
            for e in ents:
                familias[e['id'] >> 28] = familias.get(e['id'] >> 28, 0) + 1
            meta = cached_meta.get(r, {})
            candidatos.append({
                'secao': meta.get('secao', '.data'),
                'rva': r,
                'n': n_slots,
                'validos': len(items),
                'validosComCriatura': len(ents),
                'familias': {hex(k): v for k, v in familias.items()},
                'entidades': ents,
            })
    else:
        if not args.fresh and guard_path.is_file():
            try:
                guard = json.loads(guard_path.read_text(encoding='utf-8'))
                elapsed = time.time() - float(guard.get('at', 0))
                if guard.get('sha') == sha and elapsed < 1800:
                    raise SystemExit('varredura recente (%.0f s) para este build; use --validate-only ou --fresh' % elapsed)
            except (OSError, ValueError):
                pass
        guard_path.parent.mkdir(parents=True, exist_ok=True)
        guard_path.write_text(json.dumps({'sha': sha, 'at': time.time()}), encoding='utf-8')

        for nome, rva, vs in secoes:
            if nome not in ('.data', '.rdata'):
                continue
            bloco = read(base + rva, vs)
            if not bloco:
                continue
            print('varrendo %-8s %.2f MB' % (nome, len(bloco) / 1024 / 1024))
            for i in range(0, len(bloco) - 24, 8):
                bg, en, cp = struct.unpack_from('<QQQ', bloco, i)
                if not (0x10000 < bg < 0x7ff000000000 and en > bg):
                    continue
                d = en - bg
                if d % 8 or d > MAX_ITENS * 8:
                    continue
                ents = ler_vetor(read, bg, en, player_pos=player_pos, max_dist=args.max_dist)
                items = [e for e in ents if not e['isCreatureFamily']]
                if not items:
                    continue
                rva_total = rva + i
                if rva_total in (CREATURE_RVA, CREATURE_RVA + 8, CREATURE_RVA + 16, CREATURE_RVA + 24):
                    continue
                familias = {}
                for e in ents:
                    familias[e['id'] >> 28] = familias.get(e['id'] >> 28, 0) + 1
                candidatos.append({
                    'secao': nome,
                    'rva': rva_total,
                    'n': d // 8,
                    'validos': len(items),
                    'validosComCriatura': len(ents),
                    'familias': {hex(k): v for k, v in familias.items()},
                    'entidades': ents,
                })

    print('\n=== candidatos (excluindo o RVA de criaturas): %d ===' % len(candidatos))
    candidatos.sort(key=lambda c: (-c['validos'], -c['validosComCriatura']))
    for c in candidatos[:12]:
        print('\n  %s rva=%#x n=%d itens=%d total=%d familias=%s'
              % (c['secao'], c['rva'], c['n'], c['validos'], c['validosComCriatura'], c['familias']))
        for e in c['entidades'][:5]:
            print('      id=%s c4=%d d4=%d pos=%s dist=%s type=%s creatureFam=%s name=%r'
                  % (e['idHex'], e['c4'], e['d4'], e['pos'], e['dist'], e['type'], e['isCreatureFamily'], e['name']))

    # estabilidade em 3 amostras, 5 s
    escolhido = None
    estaveis = []
    if candidatos:
        rvas = [c['rva'] for c in candidatos[:12]]
        print('\nvalidando estabilidade (3 amostras, 5 s)...')
        historico = []
        for k in range(3):
            ppos = read_player_pos(read, base, args.player_rva) or player_pos
            snap = {}
            for r in rvas:
                raw = read(base + r, 24)
                if not raw or len(raw) < 24:
                    snap[r] = []
                    continue
                bg, en, cp = struct.unpack('<QQQ', raw)
                ents = ler_vetor(read, bg, en, player_pos=ppos, max_dist=args.max_dist)
                snap[r] = [e for e in ents if not e['isCreatureFamily']]
            historico.append(snap)
            vivos = [r for r in rvas if snap.get(r)]
            print('  amostra %d (player=%s): %d RVAs com item valido' % (k + 1, ppos, len(vivos)))
            if k < 2:
                time.sleep(5)

        estaveis = [r for r in rvas if all(h_.get(r) for h_ in historico)]
        print('\nRVAs estaveis (nao-criatura, mesmo z, dist<=%d): %d' % (args.max_dist, len(estaveis)))
        for r in estaveis:
            ents = historico[-1][r]
            print('  rva=%#x validos=%d' % (r, len(ents)))
            for e in ents[:6]:
                print('      id=%s c4=%d d4=%d pos=%s dist=%s type=%s name=%r'
                      % (e['idHex'], e['c4'], e['d4'], e['pos'], e['dist'], e['type'], e['name']))
        escolhido = estaveis[0] if estaveis else None

    tile_blocks = _discover_tile_items(read, base, args.tile_blocks_rva, player_pos, radius=args.radius)
    if tile_blocks:
        print('\n=== g_map.m_tileBlocks[%d] rva=%#x (raio=%d): %d itens ==='
              % (player_pos[2], args.tile_blocks_rva, args.radius, tile_blocks['itemsCount']))
        for it in tile_blocks['sampleTopItems']:
            print('  item id=%d stack=%d pos=%s dist=%d va=%s'
                  % (it['id'], it['stack'], it['pos'], it['dist'], it['va']))

    saida.parent.mkdir(parents=True, exist_ok=True)
    json.dump({
        'pid': args.pid,
        'base': hex(base),
        'sha': sha,
        'playerPos': list(player_pos) if player_pos else None,
        'maxDist': args.max_dist,
        'escolhido': hex(escolhido) if escolhido else None,
        'estaveis': [hex(r) for r in estaveis],
        'tileBlocks': tile_blocks,
        'candidatos': [{k: (hex(v) if k == 'rva' else v)
                        for k, v in c.items() if k != 'entidades'} for c in candidatos[:12]],
    }, open(saida, 'w', encoding='utf-8'), indent=1)
    print('\nESCOLHIDO: itemChainRva = %#x' % escolhido if escolhido else '\nnenhum vetor plano estavel (itens ficam em m_tileBlocks = %#x)' % args.tile_blocks_rva)
    print('artefato:', saida)


if __name__ == '__main__':
    main()
