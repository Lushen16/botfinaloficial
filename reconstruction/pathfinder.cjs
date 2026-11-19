'use strict';

/**
 * Planejador de passo sobre o mapa OTMM.
 *
 * POR QUE EXISTE: o walker era guloso (`direction(pos, alvo)`) com contorno
 * `clockwise` depois de STUCK_LIMIT. Isso atravessa campo aberto, mas para em
 * parede, canto de sala e corredor com curva — justamente o que uma rota real
 * tem. O `otmm` ja' era lido pela interface (previa do mapa) e tem
 * `walkable` por tile; aqui ele vira decisao de passo.
 *
 * CONTRATO: `plan(from, to)` devolve `{ direction, remaining }` ou `null`.
 *   - `direction` 0..7 no vocabulario do protocolo;
 *   - `remaining` e' o CUSTO DO CAMINHO depois do primeiro passo, nao a
 *     distancia em linha reta. O walker usa isso na guarda de orbita: desviar
 *     de uma parede pode aumentar a distancia euclidiana e ainda assim estar
 *     progredindo.
 *   - `null` = sem mapa, sem rota, andar diferente ou limite de nos estourado.
 *     O walker cai no comportamento guloso.
 *
 * TILE:
 *   - bloco ausente ou tile nao visto -> PASSAVEL com penalidade (o minimapa
 *     so' conhece o que foi visto; tratar o desconhecido como parede impediria
 *     qualquer exploracao);
 *   - tile visto e nao caminhavel -> PAREDE;
 *   - tile visto e caminhavel -> livre.
 *
 * DIAGONAL: so' entra se os dois ortogonais tambem passarem. Sem isso o corpo
 * corta quina de parede.
 */

const CARDINAL = 10;
const DIAGONAL = 14;
const UNKNOWN_PENALTY = 10;
const MAX_NODES_DEFAULT = 6000;
const CACHE_MS_DEFAULT = 750;

const NEIGHBORS = [
  [0, -1, 0, CARDINAL],
  [1, 0, 1, CARDINAL],
  [0, 1, 2, CARDINAL],
  [-1, 0, 3, CARDINAL],
  [1, -1, 4, DIAGONAL],
  [1, 1, 5, DIAGONAL],
  [-1, 1, 6, DIAGONAL],
  [-1, -1, 7, DIAGONAL],
];
const CARDINAL_NEIGHBORS = NEIGHBORS.slice(0, 4);

const keyOf = (x, y, z) => x + ',' + y + ',' + z;

/* Fila de prioridade minima simples: o pior caso e' mapa pequeno e limite de
 * nos, entao o custo de um heap binario aqui e' irrelevante. */
class Heap {
  constructor() { this.items = []; }
  get size() { return this.items.length; }
  push(node) {
    const items = this.items;
    items.push(node);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (items[parent].f <= node.f) break;
      items[i] = items[parent];
      i = parent;
    }
    items[i] = node;
  }
  pop() {
    const items = this.items;
    const first = items[0];
    const last = items.pop();
    if (items.length && last) {
      let i = 0;
      for (;;) {
        const left = i * 2 + 1;
        const right = left + 1;
        if (left >= items.length) break;
        const child = right < items.length && items[right].f < items[left].f ? right : left;
        if (items[child].f >= last.f) break;
        items[i] = items[child];
        i = child;
      }
      items[i] = last;
    }
    return first;
  }
}

function octile(ax, ay, bx, by) {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return CARDINAL * (dx + dy) + (DIAGONAL - 2 * CARDINAL) * Math.min(dx, dy);
}

/**
 * @param {object} options
 * @param {() => object|null} options.getMap devolve um leitor OTMM (ou null).
 * @param {() => number} [options.now]
 * @param {number} [options.maxNodes]
 * @param {number} [options.cacheMs]
 */
function createPathPlanner(options = {}) {
  if (typeof options.getMap !== 'function') throw Error('Planejador exige getMap().');
  const getMap = options.getMap;
  const neighbors = options.cardinalOnly ? CARDINAL_NEIGHBORS : NEIGHBORS;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const maxNodes = Number.isInteger(options.maxNodes) && options.maxNodes > 0
    ? options.maxNodes : MAX_NODES_DEFAULT;
  const cacheMs = Number.isFinite(options.cacheMs) && options.cacheMs >= 0
    ? options.cacheMs : CACHE_MS_DEFAULT;
  let cache = { key: null, at: -Infinity, map: null, result: null };

  function classify(map, x, y, z) {
    if (x < 0 || x >= 65535 || y < 0 || y >= 65535) return -1;
    const tile = map.tile({ x, y, z });
    if (!tile) return 1;                 // bloco ausente: desconhecido
    if (!tile.seen) return 1;            // ainda nao visto
    return tile.walkable ? 0 : -1;       // -1 = parede
  }

  function search(map, from, goal) {
    if (classify(map, goal.x, goal.y, goal.z) < 0) return null;
    if (samePosition(from, goal)) return { direction: null, remaining: 0 };

    const startKey = keyOf(from.x, from.y, from.z);
    const goalKey = keyOf(goal.x, goal.y, goal.z);
    const open = new Heap();
    const gScore = new Map([[startKey, 0]]);
    const came = new Map();
    const closed = new Set();
    open.push({ x: from.x, y: from.y, f: octile(from.x, from.y, goal.x, goal.y), g: 0 });
    let nodes = 0;
    let found = false;

    while (open.size) {
      const current = open.pop();
      const currentKey = keyOf(current.x, current.y, from.z);
      if (closed.has(currentKey)) continue;
      closed.add(currentKey);
      if (currentKey === goalKey) { found = true; break; }
      if (++nodes > maxNodes) return null;

      for (const [dx, dy, dir, stepCost] of neighbors) {
        const x = current.x + dx;
        const y = current.y + dy;
        const diagonal = dx !== 0 && dy !== 0;
        if (diagonal) {
          /* Nao cortar quina: os dois ortogonais precisam passar. */
          if (classify(map, current.x + dx, current.y, from.z) < 0) continue;
          if (classify(map, current.x, current.y + dy, from.z) < 0) continue;
        }
        const kind = classify(map, x, y, from.z);
        if (kind < 0) continue;
        const neighborKey = keyOf(x, y, from.z);
        if (closed.has(neighborKey)) continue;
        const cost = current.g + stepCost + (kind === 1 ? UNKNOWN_PENALTY : 0);
        if (cost >= (gScore.get(neighborKey) ?? Infinity)) continue;
        gScore.set(neighborKey, cost);
        came.set(neighborKey, { key: currentKey, dir, cost: stepCost + (kind === 1 ? UNKNOWN_PENALTY : 0) });
        open.push({ x, y, f: cost + octile(x, y, goal.x, goal.y), g: cost });
      }
    }
    if (!found) return null;

    /* Reconstroi a lista start -> goal e devolve so' o primeiro passo.
     * `remaining` e' a soma dos custos DEPOIS do primeiro passo, para a guarda
     * de progresso do walker. */
    const dirs = [];
    const costs = [];
    let cursor = goalKey;
    while (cursor !== startKey) {
      const previous = came.get(cursor);
      if (!previous) return null;
      dirs.push(previous.dir);
      costs.push(previous.cost);
      cursor = previous.key;
    }
    dirs.reverse();
    costs.reverse();
    return { direction: dirs[0], remaining: costs.slice(1).reduce((total, cost) => total + cost, 0) };
  }

  function plan(from, to) {
    if (!isPosition(from) || !isPosition(to)) return null;
    if (from.z !== to.z) return null;
    const map = getMap();
    if (!map || typeof map.tile !== 'function') return null;
    const key = keyOf(from.x, from.y, from.z) + '>' + keyOf(to.x, to.y, to.z);
    const at = now();
    if (cache.key === key && cache.map === map && at - cache.at <= cacheMs) return cache.result;
    let result = null;
    try { result = search(map, from, to); } catch { result = null; }
    cache = { key, at, map, result };
    return result;
  }

  function canStep(from, direction) {
    const map = getMap();
    const offset = NEIGHBORS[direction];
    if (!map || !offset) return true;
    const [dx, dy] = offset;
    try {
      return classify(map, from.x + dx, from.y + dy, from.z) >= 0
        && (!dx || !dy || (classify(map, from.x + dx, from.y, from.z) >= 0
          && classify(map, from.x, from.y + dy, from.z) >= 0));
    } catch { return true; }
  }

  return { plan, canStep };
}

function samePosition(a, b) { return a.x === b.x && a.y === b.y && a.z === b.z; }
function isPosition(value) {
  return Boolean(value) && [value.x, value.y, value.z].every(Number.isInteger);
}

module.exports = { createPathPlanner };
