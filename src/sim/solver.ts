/**
 * Moteur de simulation : analyse nodale modifiée (MNA) en régime transitoire.
 * - Condensateurs / bobines : intégration trapézoïdale (Euler implicite au premier pas).
 * - Diodes : Newton-Raphson avec limitation de tension.
 * - Sources dépendantes (VCVS, VCCS, CCVS, CCCS) : éléments à 4 terminaux.
 * - Toute valeur peut être une expression de t.
 * - Fils : courant calculé a posteriori par résolution d'un laplacien par nœud.
 */

import { evalValue } from "./expr";
import { type Circuit, type Component, isDependentSource, pointKey, terminalPositions } from "./model";
import { type Netlist, buildNetlist } from "./netlist";

export interface ComponentResult {
  /** Courant traversant le composant du terminal 0 vers le terminal 1 (A). */
  i: number;
  /** Tension V(terminal 0) − V(terminal 1) (V). */
  v: number;
  /** Puissance absorbée (W), négative si le composant fournit. */
  p: number;
  /** Courant de commande (sources dépendantes), du terminal 2 vers le 3. */
  ic?: number;
  /** Tension de commande V(t2) − V(t3). */
  vc?: number;
}

interface DynState {
  vPrev: number;
  iPrev: number;
  vDiode: number;
}

const GMIN = 1e-12;
const VT = 0.025852; // kT/q à 300 K
const MAX_NEWTON = 60;

export function solveLinear(A: Float64Array[], z: Float64Array, n: number): Float64Array | null {
  // Élimination de Gauss avec pivot partiel (modifie A et z).
  for (let col = 0; col < n; col++) {
    let piv = col;
    let best = Math.abs(A[col][col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(A[r][col]);
      if (v > best) {
        best = v;
        piv = r;
      }
    }
    if (best < 1e-14) return null;
    if (piv !== col) {
      const tmp = A[piv];
      A[piv] = A[col];
      A[col] = tmp;
      const tz = z[piv];
      z[piv] = z[col];
      z[col] = tz;
    }
    const prow = A[col];
    const pv = prow[col];
    for (let r = col + 1; r < n; r++) {
      const row = A[r];
      const f = row[col] / pv;
      if (f === 0) continue;
      for (let c = col; c < n; c++) row[c] -= f * prow[c];
      z[r] -= f * z[col];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = z[r];
    const row = A[r];
    for (let c = r + 1; c < n; c++) s -= row[c] * x[c];
    x[r] = s / row[r];
  }
  return x;
}

function pnjlim(vnew: number, vold: number, vt: number, vcrit: number): number {
  if (vnew > vcrit && Math.abs(vnew - vold) > vt + vt) {
    if (vold > 0) {
      const arg = 1 + (vnew - vold) / vt;
      vnew = arg > 0 ? vold + vt * Math.log(arg) : vcrit;
    } else {
      vnew = vt * Math.log(vnew / vt);
    }
  }
  return vnew;
}

/** Composants dont la sortie est une branche de tension (inconnue de courant). */
function hasOutputBranch(c: Component): boolean {
  return (
    c.type === "battery" ||
    c.type === "acsource" ||
    c.type === "vfunc" ||
    c.type === "ammeter" ||
    c.type === "vcvs" ||
    c.type === "ccvs" ||
    (c.type === "switch" && !!c.closed)
  );
}

/** Composants dont la commande est une branche de courant (court-circuit mesuré). */
function hasControlBranch(c: Component): boolean {
  return c.type === "ccvs" || c.type === "cccs";
}

function isDiode(c: Component): boolean {
  return c.type === "diode" || c.type === "led";
}

export class Simulator {
  circuit: Circuit;
  netlist: Netlist;
  time = 0;
  /** Pas de temps courant (s). */
  dt = 2e-5;
  nodeVoltages = new Float64Array(0);
  results = new Map<string, ComponentResult>();
  wireCurrents = new Map<string, number>();
  error: string | null = null;
  warning: string | null = null;
  private states = new Map<string, DynState>();
  private branchIndex = new Map<string, number>();
  private forceBackwardEuler = true;
  private size = 0;

  constructor(circuit: Circuit) {
    this.circuit = circuit;
    this.netlist = buildNetlist(circuit);
    this.rebuild();
  }

  /** À appeler après tout changement de topologie ou de valeur. Conserve les états dynamiques. */
  rebuild(): void {
    this.netlist = buildNetlist(this.circuit);
    this.branchIndex.clear();
    let idx = Math.max(0, this.netlist.nodeCount - 1);
    for (const c of this.circuit.components) {
      if (hasOutputBranch(c)) this.branchIndex.set(c.id, idx++);
      if (hasControlBranch(c)) this.branchIndex.set(c.id + ":c", idx++);
    }
    this.size = idx;
    const alive = new Set(this.circuit.components.map((c) => c.id));
    for (const k of [...this.states.keys()]) if (!alive.has(k)) this.states.delete(k);
    if (this.nodeVoltages.length !== this.netlist.nodeCount) {
      this.nodeVoltages = new Float64Array(this.netlist.nodeCount);
    }
    this.forceBackwardEuler = true;
    this.error = null;
    this.solveOperatingPoint();
  }

  /** Remise à zéro : t = 0, condensateurs déchargés, bobines sans courant. */
  reset(): void {
    this.time = 0;
    this.states.clear();
    this.forceBackwardEuler = true;
    this.rebuild();
  }

  private state(id: string): DynState {
    let s = this.states.get(id);
    if (!s) {
      s = { vPrev: 0, iPrev: 0, vDiode: 0 };
      this.states.set(id, s);
    }
    return s;
  }

  /** Valeur d'une propriété à l'instant t (expression évaluée). */
  prop(c: Component, key: string, t: number): number {
    const v = evalValue(c.props[key], t);
    return Number.isFinite(v) ? v : 0;
  }

  /** Recalcule les tensions à l'instant courant sans avancer le temps (pour l'affichage après édition). */
  private solveOperatingPoint(): void {
    this.solveStep(this.time, 0, false);
  }

  step(): void {
    if (this.error) return;
    const ok = this.solveStep(this.time + this.dt, this.dt, true);
    if (ok) this.time += this.dt;
  }

  /**
   * Résout le système à l'instant t. Si commit, met à jour les états dynamiques.
   * dt = 0 signifie "point de fonctionnement" : les condensateurs gardent leur tension, les bobines leur courant.
   */
  private solveStep(t: number, dt: number, commit: boolean): boolean {
    const n = this.size;
    const nl = this.netlist;
    if (n === 0 || nl.nodeCount === 0) {
      this.results.clear();
      this.wireCurrents.clear();
      this.nodeVoltages = new Float64Array(nl.nodeCount);
      return true;
    }
    const comps = this.circuit.components;
    const useBE = this.forceBackwardEuler || dt === 0;
    const diodes = comps.filter(isDiode);
    const nodeIdx = (node: number) => node - 1; // le nœud 0 est la référence

    // Estimation initiale des tensions de diodes
    const vd = new Map<string, number>();
    for (const d of diodes) vd.set(d.id, this.state(d.id).vDiode);

    // Valeurs de propriétés évaluées à t (une fois par pas)
    const P = (c: Component, key: string) => this.prop(c, key, t);

    let x: Float64Array | null = null;
    let converged = diodes.length === 0;
    for (let iter = 0; iter < MAX_NEWTON; iter++) {
      const A: Float64Array[] = [];
      for (let r = 0; r < n; r++) A.push(new Float64Array(n));
      const z = new Float64Array(n);
      for (let k = 0; k < nl.nodeCount - 1; k++) A[k][k] += GMIN;

      const stampG = (a: number, b: number, g: number) => {
        const ia = nodeIdx(a);
        const ib = nodeIdx(b);
        if (ia >= 0) A[ia][ia] += g;
        if (ib >= 0) A[ib][ib] += g;
        if (ia >= 0 && ib >= 0) {
          A[ia][ib] -= g;
          A[ib][ia] -= g;
        }
      };
      // courant I injecté dans le nœud a et extrait du nœud b (circule de b vers a dans le composant)
      const stampI = (a: number, b: number, i: number) => {
        const ia = nodeIdx(a);
        const ib = nodeIdx(b);
        if (ia >= 0) z[ia] += i;
        if (ib >= 0) z[ib] -= i;
      };
      // branche de tension : V(a) − V(b) = e, courant de branche circulant de a vers b dans le composant
      const stampV = (a: number, b: number, br: number, e: number) => {
        const ia = nodeIdx(a);
        const ib = nodeIdx(b);
        if (ia >= 0) {
          A[ia][br] += 1;
          A[br][ia] += 1;
        }
        if (ib >= 0) {
          A[ib][br] -= 1;
          A[br][ib] -= 1;
        }
        z[br] += e;
      };

      let shorted: Component | null = null;
      for (const c of comps) {
        const tn = nl.terminalNodes.get(c.id)!;
        const a = tn[0];
        const b = tn[1];
        switch (c.type) {
          case "resistor":
          case "lamp":
          case "voltmeter":
            stampG(a, b, 1 / Math.max(P(c, "R"), 1e-9));
            break;
          case "capacitor": {
            const s = this.state(c.id);
            const C = Math.max(P(c, "C"), 1e-18);
            if (dt === 0) {
              const g = 1e3;
              stampG(a, b, g);
              stampI(a, b, g * s.vPrev);
            } else if (useBE) {
              const g = C / dt;
              stampG(a, b, g);
              stampI(a, b, g * s.vPrev);
            } else {
              const g = (2 * C) / dt;
              stampG(a, b, g);
              stampI(a, b, g * s.vPrev + s.iPrev);
            }
            break;
          }
          case "inductor": {
            const s = this.state(c.id);
            const L = Math.max(P(c, "L"), 1e-15);
            if (dt === 0) {
              const g = 1e-3;
              stampG(a, b, g);
              stampI(a, b, -s.iPrev);
            } else if (useBE) {
              const g = dt / L;
              stampG(a, b, g);
              stampI(a, b, -s.iPrev);
            } else {
              const g = dt / (2 * L);
              stampG(a, b, g);
              stampI(a, b, -(s.iPrev + g * s.vPrev));
            }
            break;
          }
          case "currentsource":
          case "ifunc":
            // le courant sort par le terminal 1 (pointe de la flèche)
            stampI(b, a, P(c, "I"));
            break;
          case "battery":
          case "acsource":
          case "vfunc":
          case "ammeter":
          case "switch": {
            if (!hasOutputBranch(c)) break; // interrupteur ouvert
            const br = this.branchIndex.get(c.id)!;
            if (a === b) {
              if (c.type !== "ammeter" && c.type !== "switch") shorted = c;
              A[br][br] += 1; // branche court-circuitée : i = 0, matrice régulière
              break;
            }
            let e = 0;
            if (c.type === "battery" || c.type === "vfunc") e = P(c, "V");
            else if (c.type === "acsource")
              e = P(c, "A") * Math.sin(2 * Math.PI * P(c, "f") * t + (P(c, "phi") * Math.PI) / 180) + P(c, "off");
            stampV(a, b, br, e);
            break;
          }
          case "vcvs": {
            const br = this.branchIndex.get(c.id)!;
            const cp = nodeIdx(tn[2]);
            const cm = nodeIdx(tn[3]);
            const E = P(c, "gain");
            if (a === b) {
              A[br][br] += 1;
              break;
            }
            stampV(a, b, br, 0);
            if (cp >= 0) A[br][cp] -= E;
            if (cm >= 0) A[br][cm] += E;
            break;
          }
          case "vccs": {
            const ia = nodeIdx(a);
            const ib = nodeIdx(b);
            const cp = nodeIdx(tn[2]);
            const cm = nodeIdx(tn[3]);
            const G = P(c, "gain");
            // courant G·(Vcp − Vcm) circulant de a vers b dans la source
            if (ia >= 0 && cp >= 0) A[ia][cp] += G;
            if (ia >= 0 && cm >= 0) A[ia][cm] -= G;
            if (ib >= 0 && cp >= 0) A[ib][cp] -= G;
            if (ib >= 0 && cm >= 0) A[ib][cm] += G;
            break;
          }
          case "ccvs": {
            const br = this.branchIndex.get(c.id)!;
            const brc = this.branchIndex.get(c.id + ":c")!;
            const H = P(c, "gain");
            if (tn[2] === tn[3]) A[brc][brc] += 1;
            else stampV(tn[2], tn[3], brc, 0);
            if (a === b) {
              A[br][br] += 1;
              break;
            }
            stampV(a, b, br, 0);
            A[br][brc] -= H;
            break;
          }
          case "cccs": {
            const brc = this.branchIndex.get(c.id + ":c")!;
            const F = P(c, "gain");
            if (tn[2] === tn[3]) A[brc][brc] += 1;
            else stampV(tn[2], tn[3], brc, 0);
            const ia = nodeIdx(a);
            const ib = nodeIdx(b);
            // courant F·ic circulant de a vers b dans la source
            if (ia >= 0) A[ia][brc] += F;
            if (ib >= 0) A[ib][brc] -= F;
            break;
          }
          case "diode":
          case "led": {
            const nvt = VT * P(c, "n");
            const is = P(c, "Is");
            const v = vd.get(c.id)!;
            const ex = Math.exp(Math.min(v / nvt, 80));
            const id = is * (ex - 1);
            const g = (is * ex) / nvt + GMIN;
            stampG(a, b, g);
            stampI(b, a, id - g * v);
            break;
          }
          case "ground":
            break;
        }
      }
      if (shorted) {
        this.error = `Source de tension court-circuitée (${shortLabel(shorted)}).`;
        return false;
      }

      x = solveLinear(A, z, n);
      if (!x) {
        this.error = "Circuit impossible à résoudre : sources de tension en conflit (parallèle ou boucle).";
        return false;
      }

      if (diodes.length === 0) {
        converged = true;
        break;
      }
      let maxDelta = 0;
      for (const d of diodes) {
        const tn = nl.terminalNodes.get(d.id)!;
        const va = tn[0] > 0 ? x[tn[0] - 1] : 0;
        const vb = tn[1] > 0 ? x[tn[1] - 1] : 0;
        const nvt = VT * P(d, "n");
        const vcrit = nvt * Math.log(nvt / (Math.SQRT2 * P(d, "Is")));
        const old = vd.get(d.id)!;
        const vnew = pnjlim(va - vb, old, nvt, vcrit);
        maxDelta = Math.max(maxDelta, Math.abs(vnew - old));
        vd.set(d.id, vnew);
      }
      if (maxDelta < 1e-6) {
        converged = true;
        break;
      }
    }
    if (!x) return false;
    this.warning = converged ? null : "Convergence difficile (diodes).";

    // Tensions de nœuds
    const volts = new Float64Array(nl.nodeCount);
    for (let k = 1; k < nl.nodeCount; k++) volts[k] = x[k - 1];
    this.nodeVoltages = volts;
    let maxV = 0;
    for (const v of volts) maxV = Math.max(maxV, Math.abs(v));
    if (maxV > 1e7) this.warning = "Tensions énormes : une source de courant est-elle en circuit ouvert ?";

    // Résultats par composant
    for (const c of comps) {
      const tn = nl.terminalNodes.get(c.id)!;
      if (tn.length < 2) {
        this.results.set(c.id, { i: 0, v: 0, p: 0 });
        continue;
      }
      const v = volts[tn[0]] - volts[tn[1]];
      let i = 0;
      let ic: number | undefined;
      let vc: number | undefined;
      switch (c.type) {
        case "resistor":
        case "lamp":
        case "voltmeter":
          i = v / Math.max(P(c, "R"), 1e-9);
          break;
        case "capacitor": {
          const s = this.state(c.id);
          const C = Math.max(P(c, "C"), 1e-18);
          if (dt === 0) i = s.iPrev;
          else if (useBE) i = (C / dt) * (v - s.vPrev);
          else i = ((2 * C) / dt) * (v - s.vPrev) - s.iPrev;
          if (commit) {
            s.vPrev = v;
            s.iPrev = i;
          }
          break;
        }
        case "inductor": {
          const s = this.state(c.id);
          const L = Math.max(P(c, "L"), 1e-15);
          if (dt === 0) i = s.iPrev;
          else if (useBE) i = s.iPrev + (dt / L) * v;
          else i = s.iPrev + (dt / (2 * L)) * (v + s.vPrev);
          if (commit) {
            s.vPrev = v;
            s.iPrev = i;
          }
          break;
        }
        case "currentsource":
        case "ifunc":
          i = P(c, "I");
          break;
        case "battery":
        case "acsource":
        case "vfunc":
        case "ammeter":
        case "switch":
        case "vcvs":
        case "ccvs": {
          const br = this.branchIndex.get(c.id);
          i = br === undefined ? 0 : x[br];
          break;
        }
        case "vccs":
          break;
        case "cccs":
          break;
        case "diode":
        case "led": {
          const nvt = VT * P(c, "n");
          const vdv = vd.get(c.id)!;
          i = P(c, "Is") * (Math.exp(Math.min(vdv / nvt, 80)) - 1);
          if (commit || dt === 0) this.state(c.id).vDiode = vdv;
          break;
        }
        default:
          i = 0;
      }
      if (isDependentSource(c.type)) {
        vc = volts[tn[2]] - volts[tn[3]];
        if (hasControlBranch(c)) {
          ic = x[this.branchIndex.get(c.id + ":c")!];
          if (c.type === "cccs") i = P(c, "gain") * ic;
        } else {
          ic = 0;
          if (c.type === "vccs") i = P(c, "gain") * vc;
        }
      }
      this.results.set(c.id, { i, v, p: v * i, ic, vc });
    }
    if (commit) this.forceBackwardEuler = false;
    return true;
  }

  /** Tension d'un point de grille (ou null si aucun nœud). */
  voltageAt(key: string): number | null {
    const node = this.netlist.nodeOfPoint.get(key);
    if (node === undefined) return null;
    return this.nodeVoltages[node] ?? 0;
  }

  /**
   * Calcule le courant dans chaque fil (de a vers b) en répartissant les courants
   * des terminaux par un laplacien (fils de même résistance par unité de longueur).
   */
  computeWireCurrents(): void {
    const nl = this.netlist;
    const circuit = this.circuit;
    this.wireCurrents.clear();
    if (this.error) return;

    const wiresByNode = new Map<number, typeof circuit.wires>();
    for (const w of circuit.wires) {
      const node = nl.nodeOfPoint.get(pointKey(w.a));
      if (node === undefined) continue;
      let arr = wiresByNode.get(node);
      if (!arr) {
        arr = [];
        wiresByNode.set(node, arr);
      }
      arr.push(w);
    }
    // Injection de courant dans chaque point de grille par les terminaux
    const injection = new Map<string, number>();
    const inject = (k: string, i: number) => injection.set(k, (injection.get(k) ?? 0) + i);
    for (const c of circuit.components) {
      const res = this.results.get(c.id);
      if (!res) continue;
      const tps = terminalPositions(c);
      if (tps.length < 2) continue;
      inject(pointKey(tps[0]), -res.i);
      inject(pointKey(tps[1]), res.i);
      if (tps.length === 4 && res.ic !== undefined) {
        inject(pointKey(tps[2]), -res.ic);
        inject(pointKey(tps[3]), res.ic);
      }
    }

    for (const wires of wiresByNode.values()) {
      const vertices: string[] = [];
      const vidx = new Map<string, number>();
      const vid = (k: string) => {
        let i = vidx.get(k);
        if (i === undefined) {
          i = vertices.length;
          vidx.set(k, i);
          vertices.push(k);
        }
        return i;
      };
      const edges = wires.map((w) => {
        const len = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1;
        return { w, ia: vid(pointKey(w.a)), ib: vid(pointKey(w.b)), g: 1 / len };
      });
      const m = vertices.length;
      if (m < 2) continue;
      const n = m - 1; // le dernier sommet sert de référence
      const A: Float64Array[] = [];
      for (let r = 0; r < n; r++) A.push(new Float64Array(n));
      const z = new Float64Array(n);
      for (const e of edges) {
        if (e.ia < n) A[e.ia][e.ia] += e.g;
        if (e.ib < n) A[e.ib][e.ib] += e.g;
        if (e.ia < n && e.ib < n) {
          A[e.ia][e.ib] -= e.g;
          A[e.ib][e.ia] -= e.g;
        }
      }
      for (let k = 0; k < n; k++) {
        A[k][k] += 1e-12;
        z[k] = injection.get(vertices[k]) ?? 0;
      }
      const phi = solveLinear(A, z, n);
      if (!phi) continue;
      const pot = (i: number) => (i < n ? phi[i] : 0);
      for (const e of edges) {
        this.wireCurrents.set(e.w.id, e.g * (pot(e.ia) - pot(e.ib)));
      }
    }
  }
}

function shortLabel(c: Component): string {
  if (c.type === "battery") return `pile ${c.props.V} V`;
  if (c.type === "vfunc") return "source v(t)";
  return "source CA";
}
