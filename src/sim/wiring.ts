/**
 * Câblage : routage orthogonal des fils, déplacement des jonctions (élastique), chemins de fils reliés.
 *
 * Les fils restent des segments individuels dans le modèle (le solveur ne voit que des points de grille),
 * mais l'éditeur les manipule comme un ensemble : déplacer une jonction déplace toutes les extrémités qui
 * s'y trouvent, un fil qui s'éloigne d'un terminal reste raccordé par un nouveau segment, et les segments
 * reliés bout à bout (sans embranchement) forment un « chemin » sélectionné et déplacé d'un bloc.
 */

import { type Circuit, type Component, type Rot, type Vec, type Wire, DEFS, createWire, pointKey, rotateVec, samePoint, terminalPositions } from "./model";

export function addVec(a: Vec, b: Vec): Vec {
  return { x: a.x + b.x, y: a.y + b.y };
}

/** Direction unitaire, vers l'extérieur, de la patte du terminal k d'un composant. */
export function leadDirection(c: Pick<Component, "type" | "rot">, k: number): Vec {
  const t = DEFS[c.type].terminals[k];
  const local = t.x !== 0 ? { x: Math.sign(t.x), y: 0 } : { x: 0, y: Math.sign(t.y) || -1 };
  return rotateVec(local, c.rot);
}

/** Terminal (composant, index, direction de patte) situé au point p, s'il existe. */
export function terminalAt(circuit: Circuit, p: Vec, except?: string): { c: Component; k: number; lead: Vec } | null {
  for (const c of circuit.components) {
    if (c.id === except) continue;
    const k = terminalPositions(c).findIndex((t) => samePoint(t, p));
    if (k >= 0) return { c, k, lead: leadDirection(c, k) };
  }
  return null;
}

function dedupe(pts: Vec[]): Vec[] {
  const out: Vec[] = [];
  for (const p of pts) if (out.length === 0 || !samePoint(out[out.length - 1], p)) out.push({ x: p.x, y: p.y });
  return out;
}

/** Polyligne orthogonale de `from` à `to` ; le premier segment suit l'axe `axis`. */
export function routeL(from: Vec, to: Vec, axis: "x" | "y" = "x"): Vec[] {
  if (from.x === to.x || from.y === to.y) return dedupe([from, to]);
  const corner = axis === "x" ? { x: to.x, y: from.y } : { x: from.x, y: to.y };
  return dedupe([from, corner, to]);
}

/**
 * Polyligne orthogonale de `from` vers le terminal `term` dont la patte pointe vers `d` (unitaire) :
 * le dernier segment arrive par l'extérieur, le long de la patte, sans traverser le corps du composant.
 */
export function routeToTerminal(from: Vec, term: Vec, d: Vec): Vec[] {
  if (samePoint(from, term)) return [{ ...from }];
  const rel = { x: from.x - term.x, y: from.y - term.y };
  const along = rel.x * d.x + rel.y * d.y;
  const n = { x: -d.y, y: d.x };
  const lateral = rel.x * n.x + rel.y * n.y;
  if (along >= 0) {
    // Devant le terminal : on longe la patte jusqu'à la hauteur de `from`, puis on rejoint `from` de côté.
    const corner = { x: term.x + d.x * along, y: term.y + d.y * along };
    return dedupe([from, corner, term]);
  }
  // Derrière le terminal : on sort d'une unité, puis on contourne le composant.
  const stub = addVec(term, d);
  if (lateral !== 0) {
    const p1 = { x: stub.x + n.x * lateral, y: stub.y + n.y * lateral };
    return dedupe([from, p1, stub, term]);
  }
  const off = 2;
  const p1 = { x: stub.x + n.x * off, y: stub.y + n.y * off };
  const p2 = { x: from.x + n.x * off, y: from.y + n.y * off };
  return dedupe([from, p2, p1, stub, term]);
}

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Boîte (ouverte, en unités de grille) du corps d'un composant : un fil ne doit pas la traverser. */
export function bodyBox(c: Pick<Component, "type" | "pos" | "rot">): Box {
  let hw = 2;
  let hh = 0.8;
  let cx = 0;
  let cy = 0;
  if (c.type === "vcvs" || c.type === "vccs" || c.type === "ccvs" || c.type === "cccs") hh = 1.5;
  else if (c.type === "ground") {
    hw = 0.7;
    hh = 0.8;
    cy = -0.15;
  }
  const a = rotateVec({ x: cx - hw, y: cy - hh }, c.rot);
  const b = rotateVec({ x: cx + hw, y: cy + hh }, c.rot);
  return {
    x0: c.pos.x + Math.min(a.x, b.x),
    y0: c.pos.y + Math.min(a.y, b.y),
    x1: c.pos.x + Math.max(a.x, b.x),
    y1: c.pos.y + Math.max(a.y, b.y),
  };
}

export interface RouteContext {
  circuit: Circuit;
  /** Fils à ignorer comme obstacles (ceux qu'on est en train de déplacer ou de re-router). */
  ignoreWires?: Set<string>;
  /** Points où une connexion est voulue (les extrémités du trajet le sont toujours). */
  allowPoints?: Vec[];
}

interface Obstacles {
  boxes: Box[];
  points: Vec[];
  segments: { a: Vec; b: Vec }[];
  allowed: Set<string>;
}

function buildObstacles(ctx: RouteContext, from: Vec, to: Vec): Obstacles {
  const ignore = ctx.ignoreWires ?? new Set<string>();
  const allowed = new Set([from, to, ...(ctx.allowPoints ?? [])].map(pointKey));
  const points: Vec[] = [];
  const boxes: Box[] = [];
  for (const c of ctx.circuit.components) {
    boxes.push(bodyBox(c));
    for (const t of terminalPositions(c)) if (!allowed.has(pointKey(t))) points.push(t);
  }
  const segments: { a: Vec; b: Vec }[] = [];
  for (const w of ctx.circuit.wires) {
    if (ignore.has(w.id)) continue;
    segments.push({ a: w.a, b: w.b });
    for (const p of [w.a, w.b]) if (!allowed.has(pointKey(p))) points.push(p);
  }
  return { boxes, points, segments, allowed };
}

function onSegment(p: Vec, a: Vec, b: Vec): boolean {
  if (a.x === b.x) return p.x === a.x && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y);
  if (a.y === b.y) return p.y === a.y && p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x);
  return false;
}

function crossesBox(a: Vec, b: Vec, box: Box): boolean {
  if (a.y === b.y) return a.y > box.y0 && a.y < box.y1 && Math.max(Math.min(a.x, b.x), box.x0) < Math.min(Math.max(a.x, b.x), box.x1);
  if (a.x === b.x) return a.x > box.x0 && a.x < box.x1 && Math.max(Math.min(a.y, b.y), box.y0) < Math.min(Math.max(a.y, b.y), box.y1);
  return true;
}

/** Deux segments alignés qui se recouvrent sur une longueur non nulle (la normalisation les fusionnerait). */
function overlaps(a: Vec, b: Vec, c: Vec, d: Vec): boolean {
  if (a.y === b.y && c.y === d.y && a.y === c.y) return Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)) < Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x));
  if (a.x === b.x && c.x === d.x && a.x === c.x) return Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)) < Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y));
  return false;
}

/** Supprime les points intermédiaires alignés ; renvoie null si la polyligne revient sur ses pas. */
function simplify(pts: Vec[]): Vec[] | null {
  const p = dedupe(pts);
  const out: Vec[] = [];
  for (const q of p) {
    while (out.length >= 2) {
      const a = out[out.length - 2];
      const b = out[out.length - 1];
      const d1 = { x: Math.sign(b.x - a.x), y: Math.sign(b.y - a.y) };
      const d2 = { x: Math.sign(q.x - b.x), y: Math.sign(q.y - b.y) };
      if (d1.x === d2.x && d1.y === d2.y) out.pop();
      else if (d1.x === -d2.x && d1.y === -d2.y) return null;
      else break;
    }
    out.push(q);
  }
  return out;
}

function polylineValid(pts: Vec[], obs: Obstacles): boolean {
  for (let k = 0; k + 1 < pts.length; k++) {
    const a = pts[k];
    const b = pts[k + 1];
    if (a.x !== b.x && a.y !== b.y) return false;
    for (const box of obs.boxes) if (crossesBox(a, b, box)) return false;
    for (const p of obs.points) if (onSegment(p, a, b)) return false;
    for (const s of obs.segments) if (overlaps(a, b, s.a, s.b)) return false;
  }
  for (let k = 1; k + 1 < pts.length; k++) {
    const v = pts[k];
    if (obs.allowed.has(pointKey(v))) continue;
    for (const s of obs.segments) if (onSegment(v, s.a, s.b)) return false;
  }
  return true;
}

function length(pts: Vec[]): number {
  let l = 0;
  for (let k = 0; k + 1 < pts.length; k++) l += Math.abs(pts[k + 1].x - pts[k].x) + Math.abs(pts[k + 1].y - pts[k].y);
  return l;
}

function leavesAlong(p: Vec, q: Vec, d: Vec): boolean {
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  return (dx === 0 || Math.sign(dx) === d.x) && (dy === 0 || Math.sign(dy) === d.y) && (dx !== 0 || dy !== 0);
}

/**
 * Meilleur trajet orthogonal de `from` à `to` : parmi des candidats (ligne droite, coudes, baïonnettes avec
 * une ligne intermédiaire décalée, départ / arrivée le long des pattes), le plus court de ceux qui ne
 * traversent aucun corps de composant, ne touchent aucun terminal ni fil étranger, avec le moins de segments
 * possible. `leadFrom` / `leadTo` : direction des pattes si les extrémités sont des terminaux.
 */
export function bestRoute(from: Vec, to: Vec, ctx: RouteContext, leadFrom?: Vec, leadTo?: Vec): Vec[] {
  if (samePoint(from, to)) return [{ ...from }];
  const obs = buildObstacles(ctx, from, to);
  const stubs = (p: Vec, d?: Vec): Vec[] => (d ? [1, 2, 3].map((k) => ({ x: p.x + d.x * k, y: p.y + d.y * k })).concat([p]) : [p]);
  let best: Vec[] | null = null;
  let bestScore = Infinity;
  const consider = (raw: Vec[]) => {
    const pts = simplify(raw);
    if (!pts || pts.length < 2) return;
    const segs = pts.length - 1;
    let score = segs * 100 + length(pts);
    if (leadFrom && !leavesAlong(pts[0], pts[1], leadFrom)) score += 40;
    if (leadTo && !leavesAlong(pts[pts.length - 1], pts[pts.length - 2], leadTo)) score += 40;
    if (score >= bestScore) return;
    if (!polylineValid(pts, obs)) return;
    best = pts;
    bestScore = score;
  };
  const offsets = [0, 1, -1, 2, -2, 3, -3];
  for (const S of stubs(from, leadFrom)) {
    for (const E of stubs(to, leadTo)) {
      consider([from, S, E, to]);
      consider([from, S, { x: E.x, y: S.y }, E, to]);
      consider([from, S, { x: S.x, y: E.y }, E, to]);
      const xs = new Set<number>([Math.round((S.x + E.x) / 2)]);
      const ys = new Set<number>([Math.round((S.y + E.y) / 2)]);
      for (const o of offsets) {
        xs.add(S.x + o);
        xs.add(E.x + o);
        ys.add(S.y + o);
        ys.add(E.y + o);
      }
      for (const m of xs) consider([from, S, { x: m, y: S.y }, { x: m, y: E.y }, E, to]);
      for (const m of ys) consider([from, S, { x: S.x, y: m }, { x: E.x, y: m }, E, to]);
    }
  }
  if (best) return best;
  // Aucun trajet sans obstacle : on garde le plus simple (l'utilisateur verra le conflit).
  if (leadTo) return routeToTerminal(from, to, leadTo);
  if (leadFrom) return routeToTerminal(to, from, leadFrom).reverse();
  return routeL(from, to, "x");
}

/**
 * Trajet d'un nouveau fil entre deux points : part le long de la patte quand une extrémité est un terminal,
 * contourne les composants et évite de toucher les autres fils.
 */
export function routeWire(circuit: Circuit, a: Vec, b: Vec): Vec[] {
  const ta = terminalAt(circuit, a);
  const tb = terminalAt(circuit, b);
  return bestRoute(a, b, { circuit }, ta?.lead, tb?.lead);
}

/** Segments correspondant à une polyligne (les points confondus sont ignorés). */
export function polylineWires(pts: Vec[], firstId?: string): Wire[] {
  const out: Wire[] = [];
  const p = dedupe(pts);
  for (let k = 0; k + 1 < p.length; k++) {
    const w = createWire(p[k], p[k + 1]);
    if (k === 0 && firstId) w.id = firstId;
    out.push(w);
  }
  return out;
}

/** Remplace un fil par une polyligne (le premier segment garde son identifiant). */
function replaceWire(circuit: Circuit, w: Wire, pts: Vec[]): void {
  const idx = circuit.wires.indexOf(w);
  if (idx < 0) return;
  circuit.wires.splice(idx, 1, ...polylineWires(pts, w.id));
}

/** Vrai si p est sur un fil (extrémité ou intérieur d'un segment orthogonal). */
export function pointOnWire(circuit: Circuit, p: Vec): boolean {
  for (const w of circuit.wires) {
    if (samePoint(p, w.a) || samePoint(p, w.b)) return true;
    if (w.a.x === w.b.x && p.x === w.a.x && p.y > Math.min(w.a.y, w.b.y) && p.y < Math.max(w.a.y, w.b.y)) return true;
    if (w.a.y === w.b.y && p.y === w.a.y && p.x > Math.min(w.a.x, w.b.x) && p.x < Math.max(w.a.x, w.b.x)) return true;
  }
  return false;
}

export interface JunctionMove {
  from: Vec;
  to: Vec;
  /** Direction de la patte si la jonction est un terminal qui se déplace : les fils y arrivent par l'extérieur. */
  lead?: Vec;
}

export interface MoveOptions {
  /** Fils déplacés d'un bloc par l'appelant : leurs extrémités ne sont pas re-routées. */
  movingWires?: Set<string>;
  /** Composant en déplacement : ses terminaux ne reçoivent pas de fil de raccord. */
  movingComponent?: string;
  /** Si vrai, un terminal resté sur `from` n'est pas raccordé à `to` (on détache le fil). */
  detach?: boolean;
}

/**
 * Déplace des jonctions : chaque extrémité de fil (hors fils déplacés en bloc) située sur `from` est amenée
 * en `to` puis le fil est re-routé orthogonalement depuis son autre extrémité ; un terminal resté sur `from`
 * est raccordé à `to` par un nouveau fil (sauf `detach`). Tout est planifié sur la géométrie d'origine :
 * une extrémité n'est jamais déplacée deux fois, même si `to` d'un déplacement est `from` d'un autre.
 */
export function applyJunctionMoves(circuit: Circuit, moves: JunctionMove[], opts: MoveOptions = {}): void {
  const moving = opts.movingWires ?? new Set<string>();
  const findMove = (p: Vec) => moves.find((m) => samePoint(m.from, p));

  const plan: { w: Wire; a?: JunctionMove; b?: JunctionMove }[] = [];
  for (const w of circuit.wires) {
    if (moving.has(w.id)) continue;
    const a = findMove(w.a);
    const b = findMove(w.b);
    if (a || b) plan.push({ w, a, b });
  }
  const stubs: { c: Component; k: number; mv: JunctionMove }[] = [];
  if (!opts.detach) {
    for (const c of circuit.components) {
      if (c.id === opts.movingComponent) continue;
      terminalPositions(c).forEach((t, k) => {
        const mv = findMove(t);
        if (mv) stubs.push({ c, k, mv });
      });
    }
  }

  // Obstacles : tout sauf les fils en mouvement ou re-routés ; les jonctions déplacées sont des connexions voulues.
  const ignoreWires = new Set([...moving, ...plan.map((p) => p.w.id)]);
  const allowPoints = moves.flatMap((m) => [m.from, m.to]);
  const ctx: RouteContext = { circuit, ignoreWires, allowPoints };
  const leadAt = (p: Vec) => terminalAt(circuit, p, opts.movingComponent)?.lead;

  for (const { w, a, b } of plan) {
    if (a && b) {
      replaceWire(circuit, w, bestRoute(a.to, b.to, ctx, a.lead, b.lead));
      continue;
    }
    const mv = (a ?? b)!;
    const fixed = a ? w.b : w.a;
    replaceWire(circuit, w, bestRoute(fixed, mv.to, ctx, leadAt(fixed), mv.lead));
  }
  for (const { c, k, mv } of stubs) {
    const t = terminalPositions(c)[k];
    if (pointOnWire(circuit, t)) continue;
    circuit.wires.push(...polylineWires(bestRoute(mv.to, t, ctx, mv.lead, leadDirection(c, k))));
  }
}

/**
 * Déplace / pivote un composant en gardant ses fils raccordés. Une extrémité de fil posée sur une position
 * qui reste un terminal du composant après la transformation (rotation de 180°) ne bouge pas : le fil change
 * simplement de terminal, comme quand on retourne une pile ou une diode dans un circuit.
 */
export function relocateComponent(circuit: Circuit, c: Component, pos: Vec, rot: Rot): void {
  const before = terminalPositions(c);
  const next = { ...c, pos, rot };
  const after = terminalPositions(next);
  const inPlace = samePoint(pos, c.pos);
  const moves: JunctionMove[] = [];
  before.forEach((p, k) => {
    if (samePoint(p, after[k])) return;
    // Rotation sur place où la position reste un terminal (180°) : le fil y reste et change de terminal.
    if (inPlace && after.some((q) => samePoint(q, p))) return;
    moves.push({ from: p, to: after[k], lead: leadDirection(next, k) });
  });
  // Rotation sur place : un fil voisin (non raccordé directement) sur lequel tombe un terminal serait relié
  // par la normalisation — c'est presque toujours un fil du même composant, donc un court-circuit. On le
  // détournera autour du terminal une fois la rotation faite.
  const bypass: Wire[] = [];
  if (inPlace) {
    for (const w of circuit.wires) {
      if (before.some((p) => samePoint(p, w.a) || samePoint(p, w.b))) continue;
      if (moves.some((m) => onSegment(m.to, w.a, w.b) && !samePoint(m.to, w.a) && !samePoint(m.to, w.b))) bypass.push(w);
    }
  }
  c.pos = { ...pos };
  c.rot = rot;
  applyJunctionMoves(circuit, moves, { movingComponent: c.id });
  for (const w of bypass) {
    const ctx: RouteContext = { circuit, ignoreWires: new Set([w.id]) };
    replaceWire(circuit, w, bestRoute(w.a, w.b, ctx, terminalAt(circuit, w.a)?.lead, terminalAt(circuit, w.b)?.lead));
  }
}

/** Translate des fils d'un bloc ; les fils voisins suivent et les terminaux quittés sont raccordés (sauf `detach`). */
export function translateWires(circuit: Circuit, ids: string[], delta: Vec, opts: { detach?: boolean } = {}): void {
  if (delta.x === 0 && delta.y === 0) return;
  const moving = new Set(ids);
  const wires = circuit.wires.filter((w) => moving.has(w.id));
  const seen = new Set<string>();
  const moves: JunctionMove[] = [];
  for (const w of wires) {
    for (const p of [w.a, w.b]) {
      const k = pointKey(p);
      if (seen.has(k)) continue;
      seen.add(k);
      moves.push({ from: { ...p }, to: addVec(p, delta) });
    }
  }
  for (const w of wires) {
    w.a = addVec(w.a, delta);
    w.b = addVec(w.b, delta);
  }
  applyJunctionMoves(circuit, moves, { movingWires: moving, detach: opts.detach });
}

/**
 * Déplace une extrémité de fil. Avec `group`, toutes les extrémités de fils réunies en ce point suivent
 * (on déplace la jonction) ; sinon seul ce fil est détaché. Un terminal quitté n'est jamais raccordé.
 */
export function moveWireEnd(circuit: Circuit, id: string, end: "a" | "b", to: Vec, opts: { group?: boolean } = {}): void {
  const w = circuit.wires.find((x) => x.id === id);
  if (!w) return;
  const from = w[end];
  if (samePoint(from, to)) return;
  if (opts.group) {
    applyJunctionMoves(circuit, [{ from: { ...from }, to }], { detach: true });
    return;
  }
  const fixed = end === "a" ? w.b : w.a;
  const ctx: RouteContext = { circuit, ignoreWires: new Set([w.id]), allowPoints: [from] };
  replaceWire(circuit, w, bestRoute(fixed, to, ctx, terminalAt(circuit, fixed)?.lead, terminalAt(circuit, to)?.lead));
}

/** Fils par point d'extrémité. */
function wiresByPoint(circuit: Circuit): Map<string, Wire[]> {
  const map = new Map<string, Wire[]>();
  for (const w of circuit.wires) {
    for (const p of [w.a, w.b]) {
      const k = pointKey(p);
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(w);
    }
  }
  return map;
}

/**
 * Chemin de fils reliés bout à bout à partir d'un segment : on prolonge tant que le point atteint ne relie
 * que deux fils (ni embranchement, ni terminal, ni extrémité libre). C'est ce que l'utilisateur perçoit comme
 * « un fil », même s'il est fait de plusieurs segments.
 */
export function wirePath(circuit: Circuit, id: string): string[] {
  const start = circuit.wires.find((w) => w.id === id);
  if (!start) return [];
  const byPoint = wiresByPoint(circuit);
  const terminals = new Set<string>();
  for (const c of circuit.components) for (const t of terminalPositions(c)) terminals.add(pointKey(t));
  const ids = [start.id];
  const visited = new Set(ids);
  const walk = (p: Vec, prepend: boolean) => {
    for (;;) {
      const k = pointKey(p);
      if (terminals.has(k)) return;
      const here = byPoint.get(k) ?? [];
      if (here.length !== 2) return;
      const next = here.find((w) => !visited.has(w.id));
      if (!next) return;
      visited.add(next.id);
      if (prepend) ids.unshift(next.id);
      else ids.push(next.id);
      p = samePoint(next.a, p) ? next.b : next.a;
    }
  };
  walk(start.b, false);
  walk(start.a, true);
  return ids;
}

/** Points extrêmes d'un chemin (utile pour l'affichage ou les mesures). */
export function pathPoints(circuit: Circuit, ids: string[]): Vec[] {
  const pts: Vec[] = [];
  for (const id of ids) {
    const w = circuit.wires.find((x) => x.id === id);
    if (w) pts.push(w.a, w.b);
  }
  return pts;
}
