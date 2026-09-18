/** Construction des nœuds électriques et normalisation des fils. */

import { type Circuit, type Vec, type Wire, createWire, pointKey, samePoint, terminalPositions } from "./model";

class UnionFind {
  private parent = new Map<string, string>();

  add(k: string): void {
    if (!this.parent.has(k)) this.parent.set(k, k);
  }

  find(k: string): string {
    this.add(k);
    let root = k;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    // compression
    let cur = k;
    while (cur !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }

  keys(): string[] {
    return [...this.parent.keys()];
  }
}

export interface Netlist {
  /** Nombre de nœuds (le nœud 0 est la référence). */
  nodeCount: number;
  /** Nœud associé à chaque point de grille présent dans le circuit. */
  nodeOfPoint: Map<string, number>;
  /** Nœud de chaque terminal : terminalNodes.get(compId)[k]. */
  terminalNodes: Map<string, number[]>;
  /** true si une masse existe. */
  hasGround: boolean;
}

export function buildNetlist(circuit: Circuit): Netlist {
  const uf = new UnionFind();
  for (const w of circuit.wires) {
    uf.union(pointKey(w.a), pointKey(w.b));
  }
  const groundKeys: string[] = [];
  for (const c of circuit.components) {
    for (const t of terminalPositions(c)) uf.add(pointKey(t));
    if (c.type === "ground") groundKeys.push(pointKey(terminalPositions(c)[0]));
  }
  for (let i = 1; i < groundKeys.length; i++) uf.union(groundKeys[0], groundKeys[i]);

  const rootIndex = new Map<string, number>();
  const hasGround = groundKeys.length > 0;
  if (hasGround) rootIndex.set(uf.find(groundKeys[0]), 0);
  for (const k of uf.keys()) {
    const r = uf.find(k);
    if (!rootIndex.has(r)) rootIndex.set(r, rootIndex.size);
  }
  const nodeOfPoint = new Map<string, number>();
  for (const k of uf.keys()) nodeOfPoint.set(k, rootIndex.get(uf.find(k))!);

  const terminalNodes = new Map<string, number[]>();
  for (const c of circuit.components) {
    terminalNodes.set(
      c.id,
      terminalPositions(c).map((t) => nodeOfPoint.get(pointKey(t))!),
    );
  }
  return { nodeCount: rootIndex.size, nodeOfPoint, terminalNodes, hasGround };
}

function onSegmentInterior(p: Vec, w: Wire): boolean {
  if (w.a.x === w.b.x && p.x === w.a.x) {
    const lo = Math.min(w.a.y, w.b.y);
    const hi = Math.max(w.a.y, w.b.y);
    return p.y > lo && p.y < hi;
  }
  if (w.a.y === w.b.y && p.y === w.a.y) {
    const lo = Math.min(w.a.x, w.b.x);
    const hi = Math.max(w.a.x, w.b.x);
    return p.x > lo && p.x < hi;
  }
  return false;
}

/**
 * Normalise les fils : supprime les fils de longueur nulle et les doublons,
 * coupe tout fil dont l'intérieur passe par un terminal ou une extrémité d'un autre fil
 * (pour que le contact crée une connexion), et fusionne les segments alignés bout à bout
 * qui ne se rejoignent qu'entre eux (un fil droit reste un seul segment).
 * `keep` : identifiants à conserver de préférence lors d'une fusion (sélection courante).
 */
export function normalizeWires(circuit: Circuit, keep: Set<string> = new Set()): void {
  // points d'intérêt
  const points: Vec[] = [];
  const seen = new Set<string>();
  const addPoint = (p: Vec) => {
    const k = pointKey(p);
    if (!seen.has(k)) {
      seen.add(k);
      points.push({ x: p.x, y: p.y });
    }
  };
  for (const c of circuit.components) for (const t of terminalPositions(c)) addPoint(t);
  for (const w of circuit.wires) {
    addPoint(w.a);
    addPoint(w.b);
  }

  let wires = circuit.wires.filter((w) => !samePoint(w.a, w.b));
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 50) {
    changed = false;
    const next: Wire[] = [];
    for (const w of wires) {
      const cut = points.find((p) => onSegmentInterior(p, w));
      if (cut) {
        next.push({ id: w.id, a: { ...w.a }, b: { ...cut } });
        next.push(createWire(cut, w.b));
        changed = true;
      } else {
        next.push(w);
      }
    }
    wires = next;
  }
  // doublons
  const keys = new Set<string>();
  const out: Wire[] = [];
  for (const w of wires) {
    const k1 = `${pointKey(w.a)}|${pointKey(w.b)}`;
    const k2 = `${pointKey(w.b)}|${pointKey(w.a)}`;
    if (keys.has(k1) || keys.has(k2)) continue;
    keys.add(k1);
    out.push(w);
  }
  circuit.wires = mergeCollinear({ components: circuit.components, wires: out }, keep);
}

/** Fusionne deux segments alignés qui se rejoignent en un point de degré 2 (sans terminal ni embranchement). */
function mergeCollinear(circuit: Circuit, keep: Set<string>): Wire[] {
  let wires = circuit.wires;
  for (let guard = 0; guard < 500; guard++) {
    const deg = connectionDegrees({ components: circuit.components, wires });
    const byPoint = new Map<string, Wire[]>();
    for (const w of wires) {
      for (const p of [w.a, w.b]) {
        const k = pointKey(p);
        if (!byPoint.has(k)) byPoint.set(k, []);
        byPoint.get(k)!.push(w);
      }
    }
    let merged: { w1: Wire; w2: Wire; far1: Vec; far2: Vec } | null = null;
    for (const [k, list] of byPoint) {
      if (list.length !== 2 || deg.get(k) !== 2) continue;
      const [w1, w2] = list;
      const [x, y] = k.split(",").map(Number);
      const p = { x, y };
      const far1 = samePoint(w1.a, p) ? w1.b : w1.a;
      const far2 = samePoint(w2.a, p) ? w2.b : w2.a;
      const horizontal = far1.y === p.y && far2.y === p.y && (far1.x - p.x) * (far2.x - p.x) < 0;
      const vertical = far1.x === p.x && far2.x === p.x && (far1.y - p.y) * (far2.y - p.y) < 0;
      if (horizontal || vertical) {
        merged = { w1, w2, far1, far2 };
        break;
      }
    }
    if (!merged) return wires;
    const { w1, w2, far1, far2 } = merged;
    const id = keep.has(w2.id) && !keep.has(w1.id) ? w2.id : w1.id;
    wires = wires.filter((w) => w !== w1 && w !== w2);
    wires.push({ id, a: { ...far1 }, b: { ...far2 } });
  }
  return wires;
}

/** Nombre de connexions (fils + terminaux) arrivant à chaque point. */
export function connectionDegrees(circuit: Circuit): Map<string, number> {
  const deg = new Map<string, number>();
  const bump = (p: Vec) => deg.set(pointKey(p), (deg.get(pointKey(p)) ?? 0) + 1);
  for (const w of circuit.wires) {
    bump(w.a);
    bump(w.b);
  }
  for (const c of circuit.components) for (const t of terminalPositions(c)) bump(t);
  return deg;
}
