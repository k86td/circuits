/**
 * Moteur de simulation : analyse nodale modifiée (MNA) en régime transitoire.
 * - Condensateurs / bobines : intégration trapézoïdale (Euler implicite au premier pas).
 * - Diodes : Newton-Raphson avec limitation de tension.
 * - Sources dépendantes (VCVS, VCCS, CCVS, CCCS) : éléments à 4 terminaux.
 * - Toute valeur peut être une expression de t et des grandeurs d'autres composants (i_R1, v_R1). Pour les sources
 *   de tension / courant, ces dépendances sont linéarisées (dérivées numériques) et intégrées à la matrice à chaque
 *   itération de Newton : une expression linéaire est résolue exactement, une non linéaire converge par Newton.
 * - Fils : courant calculé a posteriori par résolution d'un laplacien par nœud.
 */

import { type QuantityCtx, type QuantityRef, evalValue, exprRefs } from "./expr";
import { type Circuit, type Component, displayName, isDependentSource, pointKey, terminalPositions } from "./model";
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

/** Forme linéarisée d'une grandeur : q = Σ coef·x[col] + k. */
interface Lin {
  cols: [number, number][];
  k: number;
}

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
    c.type === "vexpr" ||
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
  /** Composants par nom affiché (pour i_R1, v_R1 dans les expressions). */
  private byName = new Map<string, Component>();
  /** Grandeurs référencées par chaque propriété exprimée (id → clé → références). */
  private propRefs = new Map<string, Map<string, QuantityRef[]>>();
  /** Solution précédente (point de départ des itérations). */
  private lastX: Float64Array = new Float64Array(0);

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
    this.byName.clear();
    this.propRefs.clear();
    for (const c of this.circuit.components) {
      this.byName.set(displayName(c), c);
      for (const [key, val] of Object.entries(c.props)) {
        const refs = exprRefs(val);
        if (refs.length === 0) continue;
        if (!this.propRefs.has(c.id)) this.propRefs.set(c.id, new Map());
        this.propRefs.get(c.id)!.set(key, refs);
      }
    }
    if (this.lastX.length !== this.size) this.lastX = new Float64Array(this.size);
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

  /** Valeur d'une propriété à l'instant t (expression évaluée avec les grandeurs du circuit). */
  prop(c: Component, key: string, t: number, ctx?: QuantityCtx): number {
    const v = evalValue(c.props[key], t, ctx);
    return Number.isFinite(v) ? v : 0;
  }

  /** Signe du sens de référence d'un composant (les expressions i_X / v_X utilisent les valeurs affichées). */
  private refSign(c: Component): number {
    return c.flipRef ? -1 : 1;
  }

  /** Grandeur d'un composant nommé d'après les derniers résultats (pour l'affichage et les expressions hors solveur). */
  refValue: QuantityCtx = (kind, name) => {
    const c = this.byName.get(name);
    const r = c ? this.results.get(c.id) : undefined;
    if (!c || !r) return 0;
    return this.refSign(c) * (kind === "i" ? r.i : r.v);
  };

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

    const hasRefs = this.propRefs.size > 0;
    // Itéré courant des inconnues (point de départ : solution précédente)
    let xk: Float64Array = this.lastX.length === n ? this.lastX : new Float64Array(n);

    /**
     * Linéarisation d'une grandeur (courant ou tension d'un composant) autour de l'itéré courant, en fonction des
     * inconnues x (tensions de nœuds, courants de branches). Les sources de courant sont prises constantes.
     */
    const lin = (kind: "i" | "v", c: Component, ctx: QuantityCtx): Lin => {
      const tn = nl.terminalNodes.get(c.id);
      if (!tn || tn.length < 2) return { cols: [], k: 0 };
      const ia = nodeIdx(tn[0]);
      const ib = nodeIdx(tn[1]);
      const across = (g: number, k = 0): Lin => {
        const cols: [number, number][] = [];
        if (ia >= 0) cols.push([ia, g]);
        if (ib >= 0) cols.push([ib, -g]);
        return { cols, k };
      };
      if (kind === "v") return across(1);
      const Pc = (key: string) => this.prop(c, key, t, ctx);
      switch (c.type) {
        case "resistor":
        case "lamp":
        case "voltmeter":
          return across(1 / Math.max(Pc("R"), 1e-9));
        case "capacitor": {
          const st = this.state(c.id);
          const C = Math.max(Pc("C"), 1e-18);
          if (dt === 0) return { cols: [], k: st.iPrev };
          if (useBE) return across(C / dt, -(C / dt) * st.vPrev);
          return across((2 * C) / dt, -((2 * C) / dt) * st.vPrev - st.iPrev);
        }
        case "inductor": {
          const st = this.state(c.id);
          const L = Math.max(Pc("L"), 1e-15);
          if (dt === 0) return { cols: [], k: st.iPrev };
          if (useBE) return across(dt / L, st.iPrev);
          return across(dt / (2 * L), st.iPrev + (dt / (2 * L)) * st.vPrev);
        }
        case "currentsource":
        case "ifunc":
        case "iexpr":
          return { cols: [], k: Pc("I") };
        case "vccs": {
          const G = Pc("gain");
          const cols: [number, number][] = [];
          const cp = nodeIdx(tn[2]);
          const cm = nodeIdx(tn[3]);
          if (cp >= 0) cols.push([cp, G]);
          if (cm >= 0) cols.push([cm, -G]);
          return { cols, k: 0 };
        }
        case "cccs":
          return { cols: [[this.branchIndex.get(c.id + ":c")!, Pc("gain")]], k: 0 };
        case "diode":
        case "led": {
          const nvt = VT * Pc("n");
          const is = Pc("Is");
          const v0 = vd.get(c.id) ?? 0;
          const ex = Math.exp(Math.min(v0 / nvt, 80));
          const g = (is * ex) / nvt + GMIN;
          return across(g, is * (ex - 1) - g * v0);
        }
        default: {
          const br = this.branchIndex.get(c.id);
          return br === undefined ? { cols: [], k: 0 } : { cols: [[br, 1]], k: 0 };
        }
      }
    };
    const linValue = (l: Lin, xv: Float64Array) => l.cols.reduce((acc, [col, coef]) => acc + coef * xv[col], l.k);

    /** Contexte d'évaluation des expressions à partir d'un vecteur d'inconnues (mémoïsé, cycles coupés à 0). */
    const ctxAt = (xv: Float64Array): QuantityCtx => {
      const memo = new Map<string, number>();
      const ctx: QuantityCtx = (kind, name) => {
        const key = `${kind}:${name}`;
        const hit = memo.get(key);
        if (hit !== undefined) return hit;
        const c = this.byName.get(name);
        if (!c) return 0;
        memo.set(key, 0); // coupe les références circulaires
        const val = this.refSign(c) * linValue(lin(kind, c, ctx), xv);
        memo.set(key, val);
        return val;
      };
      return ctx;
    };

    // Valeurs de propriétés évaluées à t, avec les grandeurs de l'itéré courant
    let ctx = ctxAt(xk);
    const P = (c: Component, key: string) => this.prop(c, key, t, ctx);

    /**
     * Valeur d'une source exprimée, linéarisée par rapport aux grandeurs qu'elle référence :
     * e ≈ f(q0) + Σ ∂f/∂q · (q − q0), avec q linéaire en x. Retourne le terme constant et les coefficients sur x.
     */
    const behavioral = (c: Component, key: string): Lin => {
      const refs = this.propRefs.get(c.id)?.get(key);
      const f0 = P(c, key);
      if (!refs) return { cols: [], k: f0 };
      const out: Lin = { cols: [], k: f0 };
      for (const ref of refs) {
        const target = this.byName.get(ref.name);
        if (!target) continue;
        const s = this.refSign(target);
        const l = lin(ref.kind, target, ctx);
        const q0 = s * linValue(l, xk);
        const h = Math.max(1e-7, 1e-4 * Math.abs(q0));
        const evalWith = (q: number) => {
          const over: QuantityCtx = (kind, name) => (kind === ref.kind && name === ref.name ? q : ctx(kind, name));
          return this.prop(c, key, t, over);
        };
        const d = (evalWith(q0 + h) - evalWith(q0 - h)) / (2 * h);
        if (!Number.isFinite(d) || d === 0) continue;
        out.k += d * (s * l.k - q0);
        for (const [col, coef] of l.cols) out.cols.push([col, d * s * coef]);
      }
      return out;
    };

    let x: Float64Array | null = null;
    let converged = diodes.length === 0 && !hasRefs;
    for (let iter = 0; iter < MAX_NEWTON; iter++) {
      ctx = ctxAt(xk);
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
          case "iexpr": {
            // le courant sort par le terminal 1 (pointe de la flèche) ; partie linéarisée portée dans A
            const l = behavioral(c, "I");
            stampI(b, a, l.k);
            const ia = nodeIdx(a);
            const ib = nodeIdx(b);
            for (const [col, coef] of l.cols) {
              if (ib >= 0) A[ib][col] -= coef;
              if (ia >= 0) A[ia][col] += coef;
            }
            break;
          }
          case "battery":
          case "acsource":
          case "vfunc":
          case "vexpr":
          case "ammeter":
          case "switch": {
            if (!hasOutputBranch(c)) break; // interrupteur ouvert
            const br = this.branchIndex.get(c.id)!;
            if (a === b) {
              if (c.type !== "ammeter" && c.type !== "switch") shorted = c;
              A[br][br] += 1; // branche court-circuitée : i = 0, matrice régulière
              break;
            }
            if (c.type === "battery" || c.type === "vfunc" || c.type === "vexpr") {
              const l = behavioral(c, "V");
              stampV(a, b, br, l.k);
              for (const [col, coef] of l.cols) A[br][col] -= coef;
            } else if (c.type === "acsource") {
              stampV(a, b, br, P(c, "A") * Math.sin(2 * Math.PI * P(c, "f") * t + (P(c, "phi") * Math.PI) / 180) + P(c, "off"));
            } else stampV(a, b, br, 0);
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

      // Convergence des expressions : les inconnues ne bougent plus entre deux itérations
      let refsOk = true;
      if (hasRefs) {
        let maxX = 0;
        let maxDx = 0;
        for (let k = 0; k < n; k++) {
          maxX = Math.max(maxX, Math.abs(x[k]));
          maxDx = Math.max(maxDx, Math.abs(x[k] - xk[k]));
        }
        refsOk = maxDx <= 1e-9 * (1 + maxX);
        xk = x;
      }

      if (diodes.length === 0) {
        if (refsOk) {
          converged = true;
          break;
        }
        continue;
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
      if (maxDelta < 1e-6 && refsOk) {
        converged = true;
        break;
      }
    }
    if (!x) return false;
    this.lastX = x;
    ctx = ctxAt(x);
    this.warning = converged ? null : hasRefs ? "Convergence difficile (diodes ou expressions)." : "Convergence difficile (diodes).";

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
        case "iexpr":
          i = P(c, "I");
          break;
        case "battery":
        case "acsource":
        case "vfunc":
        case "vexpr":
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
