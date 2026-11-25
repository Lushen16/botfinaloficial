"""Descobre o container de criaturas por ESTABILIDADE entre amostras.

O vetor tem slots fantasmas (ponteiros reciclados, posicao lixo). Exigir
"2 entidades validas" num unico snapshot rejeita o container real.

Metodo correto:
  1. lista candidatos: pares begin/end plausiveis em .data/.rdata cujo
     vetor contenha >=1 entidade com id 0x40xxxxxx e pos plausivel
  2. reamostra 3x a 5 s: o RVA verdadeiro e' o que CONTINUA valido,
     mesmo que o numero de entidades validas mude

Somente .data/.rdata. Leitura <=0,5 Hz (5 s) entre amostras.
"""
import ctypes, struct, sys, json, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import scan_creatures as sc
import pointer_scan_entities as pe

POS, ID, NAME, HP, CANATTACK, TYPE = 0x20, 0x4C, 0x70, 0xB0, 0xB4, 0x176
MAX_ITENS = 512


def ler_ent(read, va):
    pos = read(va + POS, 10)
    ident = read(va + ID, 4)
    if not pos or len(pos) < 10 or not ident or len(ident) < 4:
        return None
    x, y, z = struct.unpack('<iih', pos)
    if not (0 < x < 65536 and 0 < y < 65536 and 0 <= z < 16):
        return None
    iv = struct.unpack('<I', ident)[0]
    if (iv >> 28) not in (0x1, 0x4, 0x8):
        return None
    nm_raw = read(va + NAME, 32)
    nome = ''
    if nm_raw and len(nm_raw) >= 24:
        ln = struct.unpack_from('<Q', nm_raw, 0x10)[0]
        if 0 < ln <= 32:
            cand = nm_raw[:ln] if ln < 16 else (
                read(struct.unpack_from('<Q', nm_raw, 0)[0], ln)
                if 0x10000 < struct.unpack_from('<Q', nm_raw, 0)[0] < 0x7ff000000000 else b'')
            if cand and all(32 <= b < 127 for b in cand):
                nome = cand.decode('utf-8', 'ignore')
    tipo = read(va + TYPE, 1)
    hpr = read(va + HP, 4)
    ca = read(va + CANATTACK, 1)
    return {'va': hex(va), 'id': iv, 'idHex': hex(iv), 'name': nome,
            'pos': [x, y, z], 'type': tipo[0] if tipo else None,
            'hp': struct.unpack('<I', hpr)[0] if hpr and len(hpr) == 4 else None,
            'canAttack': ca[0] if ca else None}


def ler_vetor(read, bg, en):
    if not (0x10000 < bg < 0x7ff000000000 and 0x10000 < en < 0x7ff000000000): return []
    d = en - bg
    if d <= 0 or d % 8 or d > MAX_ITENS * 8: return []
    dados = read(bg, d)
    if not dados or len(dados) != d: return []
    out = []
    for i in range(d // 8):
        p = struct.unpack_from('<Q', dados, i * 8)[0]
        if not (0x10000 < p < 0x7ff000000000): continue
        e = ler_ent(read, p)
        if e: out.append(e)
    return out


def snapshot(pid, base, read, rvas):
    """le um conjunto de RVAs e devolve {rva: entidades_validas}."""
    res = {}
    for rva in rvas:
        raw = read(base + rva, 24)
        if not raw or len(raw) < 24:
            res[rva] = []
            continue
        bg, en, cp = struct.unpack('<QQQ', raw)
        res[rva] = ler_vetor(read, bg, en)
    return res


def main():
    pid = int(sys.argv[1])
    h = sc.k32.OpenProcess(sc.PROCESS_QUERY_INFORMATION | sc.PROCESS_VM_READ, False, pid)
    if not h: raise SystemExit('nao abriu processo')
    mods = [m for m in pe.enum_modules(pid)
            if m['name'].lower().startswith('pokealliance') and 'launcher' not in m['name'].lower()]
    base = mods[0]['base']
    read = lambda va, n: sc.read_mem(h, va, n)

    img = open(sc.process_image_path(h), 'rb').read(0x600)
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

    print('base %#x | pid %d' % (base, pid))

    sha = sc.file_sha256(sc.process_image_path(h))
    cache_path = Path(__file__).resolve().parent.parent / 'local-data' / 'creature-chain.json'
    guard_path = Path(__file__).resolve().parent.parent / 'local-data' / 'chain-scan-guard.json'
    candidatos_cache = None
    if '--fresh' not in sys.argv:
        try:
            cached = json.loads(cache_path.read_text(encoding='utf-8'))
            if cached.get('sha') == sha and cached.get('escolhido'):
                print('cache hit: sha %s rva %s (nenhuma varredura feita)'
                      % (sha[:12], cached['escolhido']['rva']))
                return
            if cached.get('sha') == sha and cached.get('candidatos'):
                candidatos_cache = cached['candidatos']
                print('cache de candidatos: %d RVAs (sem varrer secoes)' % len(candidatos_cache))
        except (OSError, ValueError):
            pass
        try:
            guard = json.loads(guard_path.read_text(encoding='utf-8'))
            if guard.get('sha') == sha and time.time() - float(guard.get('at', 0)) < 1800:
                print('varredura recente (%.0f s) para este build; use --fresh para repetir'
                      % (time.time() - float(guard['at'])))
                return
        except (OSError, ValueError):
            pass
    guard_path.parent.mkdir(parents=True, exist_ok=True)
    guard_path.write_text(json.dumps({'sha': sha, 'at': time.time()}), encoding='utf-8')

    # 1. candidatos: qualquer vetor com >=1 criatura (familia 0x4)
    candidatos = []
    for nome, rva, vs in ([] if candidatos_cache is not None else secoes):
        if nome not in ('.data', '.rdata'): continue
        bloco = read(base + rva, vs)
        if not bloco: continue
        print('varrendo %-8s %.2f MB' % (nome, len(bloco) / 1024 / 1024))
        for i in range(0, len(bloco) - 24, 8):
            bg, en, cp = struct.unpack_from('<QQQ', bloco, i)
            if not (0x10000 < bg < 0x7ff000000000 and en > bg): continue
            d = en - bg
            if d % 8 or d > MAX_ITENS * 8: continue
            ents = ler_vetor(read, bg, en)
            if any((e['id'] >> 28) == 0x4 for e in ents):
                candidatos.append((rva + i, len(ents)))

    if candidatos_cache is not None:
        candidatos = [tuple(c) for c in candidatos_cache]
    print('\ncandidatos com familia 0x4: %d' % len(candidatos))
    for rva, n in candidatos[:10]:
        print('  rva=%#x validos=%d' % (rva, n))

    if not candidatos:
        print('\nNENHUM candidato. Sem descoberta.')
        return

    # 2. estabilidade: 3 amostras a 5 s
    rvas = [r for r, _ in candidatos[:40]]
    print('\nvalidando estabilidade (3 amostras, 5 s)...')
    historico = []
    for k in range(3):
        s = snapshot(pid, base, read, rvas)
        historico.append(s)
        vivos = [r for r in rvas if len(s.get(r, [])) >= 1
                 and any((e['id'] >> 28) == 0x4 for e in s[r])]
        print('  amostra %d: %d RVAs com criatura' % (k + 1, len(vivos)))
        if k < 2: time.sleep(5)

    # 3. o RVA que apareceu nas 3 amostras
    estaveis = [r for r in rvas
                if all(len(h_.get(r, [])) >= 1 and any((e['id'] >> 28) == 0x4 for e in h_[r])
                       for h_ in historico)]
    print('\nRVAs estaveis nas 3 amostras: %d' % len(estaveis))
    for r in estaveis:
        ents = historico[-1][r]
        fam = {}
        for e in ents: fam[e['id'] >> 28] = fam.get(e['id'] >> 28, 0) + 1
        print('  rva=%#x validos=%d familias=%s' % (r, len(ents), {hex(k): v for k, v in fam.items()}))
        for e in ents[:5]:
            print('      id=%s pos=%s type=%s hp=%s name=%r'
                  % (e['idHex'], e['pos'], e['type'], e['hp'], e['name']))

    escolhido = estaveis[0] if estaveis else None
    saida = Path(__file__).resolve().parent.parent / 'local-data' / 'creature-chain.json'
    saida.parent.mkdir(parents=True, exist_ok=True)
    json.dump({'pid': pid, 'base': hex(base), 'sha': sha,
               'escolhido': ({'rva': hex(escolhido),
                              'entidades': historico[-1][escolhido]} if escolhido else None),
               'candidatos': [list(c) for c in candidatos[:40]],
               'estaveis': [hex(r) for r in estaveis],
               'amostras': [{hex(r): len(v.get(r, [])) for r in rvas if v.get(r)}
                            for v in historico]},
              open(saida, 'w', encoding='utf-8'), indent=1)
    if escolhido:
        print('\n=== ESCOLHIDO: creatureChainRva = %#x ===' % escolhido)
    else:
        print('\nnenhum RVA estavel nas 3 amostras')
    print('artefato:', saida)


if __name__ == '__main__':
    main()
