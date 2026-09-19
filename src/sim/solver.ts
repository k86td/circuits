/**
 * Moteur de simulation : analyse nodale modifiée (MNA) en régime transitoire.
 * - Condensateurs / bobines : BDF2 (différentiation rétrograde d'ordre 2), Euler implicite aux deux premiers pas
 *   après un changement. BDF2 est L-stable : contrairement au schéma trapézoïdal, il n'entretient pas d'oscillation
 *   numérique (« sonnerie ») quand une source fait un saut aux bornes d'un condensateur ou impose un courant dans
 *   une bobine.
 * - Diodes : Newton-Raphson avec limitation de tension.
 * - Sources dépendantes (VCVS, VCCS, CCVS, CCCS) : éléments à 4 terminaux.
 * - Toute valeur peut être une expression de t et des grandeurs d'autres composants (i_R1, v_R1). Pour les sources
 *   de tension / courant, ces dépendances sont linéarisées (dérivées numériques) et intégrées à la matrice à chaque
 *   itération de Newton : une expression linéaire est résolue exactement, une non linéaire converge par Newton.
 * - Performance : le plan d'assemblage (indices de nœuds et de branches) est calculé une fois à rebuild() ; la
 *   matrice est un tableau plat réutilisé ; quand elle ne dépend ni du temps ni de l'itéré (pas de diode, pas
 *   d'expression de grandeur, pas de valeur de R / C / L / gain variable), sa factorisation LU est conservée et
 *   chaque pas ne coûte qu'une substitution O(n²).
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
  vPrev2: number;
  iPrev2: number;
  /** Nombre de pas d'historique valides (BDF2 en demande deux). */
  hist: number;
  vDiode: number;
}

const GMIN = 1e-12;
const VT = 0.025852; // kT/q à 300 K
const MAX_NEWTON = 60;
/** Pas en Euler implicite après un changement (rebuild, remise à zéro, nouveau pas de temps). */
const BE_STEPS = 2;

/** Forme linéarisée d'une grandeur : q = Σ coef·x[col] + k. */
interface Lin {
  cols: [number, number][];
  k: number;
}

/** Plan d'assemblage d'un composant : indices pré-calculés (−1 = nœud de référence). */
interface Plan {
  c: Component;
  /** Nœuds des terminaux. */
  tn: number[];
  ia: number;
  ib: number;
  ic: number;
  id: number;
  /** Inconnue de courant de la branche de sortie / de commande, ou −1. */
  br: number;
  brc: number;
}

/** Modèle compagnon d'un élément dynamique : i = g·v + ih. */
interface Companion {
  g: number;
  ih: number;
}

// ---- Algèbre linéaire dense (tableau plat n×n, ligne par ligne) ----

/** Factorisation LU en place avec pivot partiel ; renvoie false si la matrice est singulière. */
function luFactor(A: Float64Array, n: number, piv: Int32Array): boolean {
  for (let col = 0; col < n; col++) {
    let p = col;
    let best = Math.abs(A[col * n + col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(A[r * n + col]);
      if (v > best) {
        best = v;
        p = r;
      }
    }
    if (best < 1e-14) return false;
    piv[col] = p;
    if (p !== col) {
      const a = col * n;
      const b = p * n;
      for (let k = 0; k < n; k++) {
        const t = A[a + k];
        A[a + k] = A[b + k];
        A[b + k] = t;
      }
    }
    const prow = col * n;
    const pv = A[prow + col];
    for (let r = col + 1; r < n; r++) {
      const row = r * n;
      const f = A[row + col] / pv;
      if (f === 0) continue;
      A[row + col] = f;
      for (let k = col + 1; k < n; k++) A[row + k] -= f * A[prow + k];
    }
  }
  return true;
}

/** Résout LU·x = z (z est modifié : permutations, puis substitutions avant et arrière). */
function luSolve(LU: Float64Array, n: number, piv: Int32Array, z: Float64Array, x: Float64Array): void {
  // Les lignes (multiplicateurs de L compris) ont été permutées en bloc à la factorisation : on permute z de même.
  for (let col = 0; col < n; col++) {
    const p = piv[col];
    if (p !== col) {
      const t = z[col];
      z[col] = z[p];
      z[p] = t;
    }
  }
  for (let col = 0; col < n; col++) {
    const zc = z[col];
    if (zc !== 0) for (let r = col + 1; r < n; r++) z[r] -= LU[r * n + col] * zc;
  }
  for (let r = n - 1; r >= 0; r--) {
    let s = z[r];
    const row = r * n;
    for (let k = r + 1; k < n; k++) s -= LU[row + k] * x[k];
    x[r] = s / LU[row + r];
  }
}

/** Élimination de Gauss avec pivot partiel sur des lignes séparées (modifie A et z). */
export function solveLinear(A: Float64Array[], z: Float64Array, n: number): Float64Array | null {
  const flat = new Float64Array(n * n);
  for (let r = 0; r < n; r++) flat.set(A[r].subarray(0, n), r * n);
  const piv = new Int32Array(n);
  if (!luFactor(flat, n, piv)) return null;
  const x = new Float64Array(n);
  luSolve(flat, n, piv, z, x);
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

/** Propriétés qui entrent dans la matrice (et non seulement dans le second membre). */
const MATRIX_PROPS: Partial<Record<Component["type"], string[]>> = {
  resistor: ["R"],
  lamp: ["R"],
  voltmeter: ["R"],
  capacitor: ["C"],
  inductor: ["L"],
  vcvs: ["gain"],
  vccs: ["gain"],
  ccvs: ["gain"],
  cccs: ["gain"],
};

export class Simulator {
  circuit: Circuit;
  netlist: Netlist;
  time = 0;
  nodeVoltages = new Float64Array(0);
  results = new Map<string, ComponentResult>();
  wireCurrents = new Map<string, number>();
  error: string | null = null;
  warning: string | null = null;
  private _dt = 2e-5;
  private states = new Map<string, DynState>();
  private branchIndex = new Map<string, number>();
  private beStepsLeft = BE_STEPS;
  private size = 0;
  private plans: Plan[] = [];
  private planById = new Map<string, Plan>();
  private diodes: Plan[] = [];
  /** Vrai si la matrice ne dépend ni du temps, ni de l'itéré de Newton : sa factorisation est réutilisable. */
  private matrixConstant = false;
  /** Factorisation conservée, avec le pas et le nombre d'éléments en Euler implicite pour lesquels elle vaut. */
  private lu: { LU: Float64Array; piv: Int32Array; dt: number; beCount: number } | null = null;
  private A = new Float64Array(0);
  private z = new Float64Array(0);
  private x = new Float64Array(0);
  private piv = new Int32Array(0);
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

  /** Pas de temps (s). Le changer impose deux pas en Euler implicite et une nouvelle factorisation. */
  get dt(): number {
    return this._dt;
  }

  set dt(v: number) {
    if (v === this._dt) return;
    this._dt = v;
    this.beStepsLeft = BE_STEPS;
    this.lu = null;
  }

  /** À appeler après tout changement de topologie ou de valeur. Conserve les états dynamiques. */
  rebuild(): void {
    this.netlist = buildNetlist(this.circuit);
    const nl = this.netlist;
    this.branchIndex.clear();
    let idx = Math.max(0, nl.nodeCount - 1);
    for (const c of this.circuit.components) {
      if (hasOutputBranch(c)) this.branchIndex.set(c.id, idx++);
      if (hasControlBranch(c)) this.branchIndex.set(c.id + ":c", idx++);
    }
    this.size = idx;
    this.byName.clear();
    this.propRefs.clear();
    this.plans = [];
    this.planById.clear();
    this.diodes = [];
    let constant = true;
    for (const c of this.circuit.components) {
      this.byName.set(displayName(c), c);
      for (const [key, val] of Object.entries(c.props)) {
        const refs = exprRefs(val);
        if (refs.length === 0) continue;
        constant = false;
        if (!this.propRefs.has(c.id)) this.propRefs.set(c.id, new Map());
        this.propRefs.get(c.id)!.set(key, refs);
      }
      for (const key of MATRIX_PROPS[c.type] ?? []) if (typeof c.props[key] !== "number") constant = false;
      if (isDiode(c)) constant = false;
      const tn = nl.terminalNodes.get(c.id) ?? [];
      const plan: Plan = {
        c,
        tn,
        ia: (tn[0] ?? 0) - 1,
        ib: (tn[1] ?? 0) - 1,
        ic: (tn[2] ?? 0) - 1,
        id: (tn[3] ?? 0) - 1,
        br: this.branchIndex.get(c.id) ?? -1,
        brc: this.branchIndex.get(c.id + ":c") ?? -1,
      };
      this.plans.push(plan);
      this.planById.set(c.id, plan);
      if (isDiode(c)) this.diodes.push(plan);
    }
    this.matrixConstant = constant;
    this.lu = null;
    const n = this.size;
    if (this.A.length !== n * n) this.A = new Float64Array(n * n);
    if (this.z.length !== n) {
      this.z = new Float64Array(n);
      this.x = new Float64Array(n);
      this.piv = new Int32Array(n);
    }
    if (this.lastX.length !== n) this.lastX = new Float64Array(n);
    const alive = new Set(this.circuit.components.map((c) => c.id));
    for (const k of [...this.states.keys()]) if (!alive.has(k)) this.states.delete(k);
    for (const k of [...this.results.keys()]) if (!alive.has(k)) this.results.delete(k);
    if (this.nodeVoltages.length !== nl.nodeCount) this.nodeVoltages = new Float64Array(nl.nodeCount);
    this.beStepsLeft = BE_STEPS;
    this.error = null;
    this.solveOperatingPoint();
  }

  /** Remise à zéro : t = 0, condensateurs déchargés, bobines sans courant. */
  reset(): void {
    this.time = 0;
    this.states.clear();
    this.rebuild();
  }

  private state(id: string): DynState {
    let s = this.states.get(id);
    if (!s) {
      s = { vPrev: 0, iPrev: 0, vPrev2: 0, iPrev2: 0, hist: 0, vDiode: 0 };
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
    const ok = this.solveStep(this.time + this._dt, this._dt, true);
    if (ok) this.time += this._dt;
  }

  /**
   * Modèle compagnon d'un condensateur ou d'une bobine au pas dt (i = g·v + ih).
   * dt = 0 : point de fonctionnement (le condensateur garde sa tension, la bobine son courant).
   */
  private companion(c: Component, st: DynState, dt: number, t: number, ctx: QuantityCtx | undefined, useBE: boolean): Companion {
    if (c.type === "capacitor") {
      const C = Math.max(this.prop(c, "C", t, ctx), 1e-18);
      if (dt === 0) return { g: 1e3, ih: -1e3 * st.vPrev };
      if (useBE) {
        const g = C / dt;
        return { g, ih: -g * st.vPrev };
      }
      return { g: (3 * C) / (2 * dt), ih: -(C / (2 * dt)) * (4 * st.vPrev - st.vPrev2) };
    }
    const L = Math.max(this.prop(c, "L", t, ctx), 1e-15);
    if (dt === 0) return { g: 1e-3, ih: st.iPrev };
    if (useBE) return { g: dt / L, ih: st.iPrev };
    return { g: (2 * dt) / (3 * L), ih: (4 * st.iPrev - st.iPrev2) / 3 };
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
    const plans = this.plans;
    const diodes = this.diodes;
    const globalBE = this.beStepsLeft > 0 || dt === 0;
    const useBEFor = (st: DynState) => globalBE || st.hist < 2;
    const nodeRows = nl.nodeCount - 1;
    const A = this.A;
    const z = this.z;

    // Estimation initiale des tensions de diodes
    const vd = new Map<string, number>();
    for (const d of diodes) vd.set(d.c.id, this.state(d.c.id).vDiode);

    const hasRefs = this.propRefs.size > 0;
    // Itéré courant des inconnues (point de départ : solution précédente)
    let xk: Float64Array = this.lastX;

    /**
     * Linéarisation d'une grandeur (courant ou tension d'un composant) autour de l'itéré courant, en fonction des
     * inconnues x (tensions de nœuds, courants de branches). Les sources de courant sont prises constantes.
     */
    const lin = (kind: "i" | "v", c: Component, ctx: QuantityCtx): Lin => {
      const p = this.planById.get(c.id);
      if (!p || p.tn.length < 2) return { cols: [], k: 0 };
      const across = (g: number, k = 0): Lin => {
        const cols: [number, number][] = [];
        if (p.ia >= 0) cols.push([p.ia, g]);
        if (p.ib >= 0) cols.push([p.ib, -g]);
        return { cols, k };
      };
      if (kind === "v") return across(1);
      const Pc = (key: string) => this.prop(c, key, t, ctx);
      switch (c.type) {
        case "resistor":
        case "lamp":
        case "voltmeter":
          return across(1 / Math.max(Pc("R"), 1e-9));
        case "capacitor":
        case "inductor": {
          const st = this.state(c.id);
          if (dt === 0) return { cols: [], k: st.iPrev };
          const m = this.companion(c, st, dt, t, ctx, useBEFor(st));
          return across(m.g, m.ih);
        }
        case "currentsource":
        case "ifunc":
        case "iexpr":
          return { cols: [], k: Pc("I") };
        case "vccs": {
          const G = Pc("gain");
          const cols: [number, number][] = [];
          if (p.ic >= 0) cols.push([p.ic, G]);
          if (p.id >= 0) cols.push([p.id, -G]);
          return { cols, k: 0 };
        }
        case "cccs":
          return { cols: [[p.brc, Pc("gain")]], k: 0 };
        case "diode":
        case "led": {
          const nvt = VT * Pc("n");
          const is = Pc("Is");
          const v0 = vd.get(c.id) ?? 0;
          const ex = Math.exp(Math.min(v0 / nvt, 80));
          const g = (is * ex) / nvt + GMIN;
          return across(g, is * (ex - 1) - g * v0);
        }
        default:
          return p.br < 0 ? { cols: [], k: 0 } : { cols: [[p.br, 1]], k: 0 };
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

    // Valeurs de propriétés évaluées à t, avec les grandeurs de l'itéré courant (seulement si des expressions en dépendent)
    let ctx: QuantityCtx | undefined = hasRefs ? ctxAt(xk) : undefined;
    const P = (c: Component, key: string) => this.prop(c, key, t, ctx);

    /**
     * Valeur d'une source exprimée, linéarisée par rapport aux grandeurs qu'elle référence :
     * e ≈ f(q0) + Σ ∂f/∂q · (q − q0), avec q linéaire en x. Retourne le terme constant et les coefficients sur x.
     */
    const behavioral = (c: Component, key: string): Lin => {
      const refs = this.propRefs.get(c.id)?.get(key);
      const f0 = P(c, key);
      if (!refs || !ctx) return { cols: [], k: f0 };
      const cx = ctx;
      const out: Lin = { cols: [], k: f0 };
      for (const ref of refs) {
        const target = this.byName.get(ref.name);
        if (!target) continue;
        const s = this.refSign(target);
        const l = lin(ref.kind, target, cx);
        const q0 = s * linValue(l, xk);
        const h = Math.max(1e-7, 1e-4 * Math.abs(q0));
        const evalWith = (q: number) => {
          const over: QuantityCtx = (kind, name) => (kind === ref.kind && name === ref.name ? q : cx(kind, name));
          return this.prop(c, key, t, over);
        };
        const d = (evalWith(q0 + h) - evalWith(q0 - h)) / (2 * h);
        if (!Number.isFinite(d) || d === 0) continue;
        out.k += d * (s * l.k - q0);
        for (const [col, coef] of l.cols) out.cols.push([col, d * s * coef]);
      }
      return out;
    };

    // Nombre d'éléments dynamiques encore en Euler implicite : la matrice en dépend.
    let beCount = 0;
    for (const p of plans) {
      if (p.c.type === "capacitor" || p.c.type === "inductor") if (useBEFor(this.state(p.c.id))) beCount++;
    }
    // Factorisation réutilisable ? (matrice constante, même pas, même schéma d'intégration)
    const reuse = this.matrixConstant && dt > 0 && this.lu !== null && this.lu.dt === dt && this.lu.beCount === beCount;

    /**
     * Assemble le second membre z et, si doA, la matrice A. Renvoie la source court-circuitée s'il y en a une.
     */
    const assemble = (doA: boolean): Component | null => {
      z.fill(0);
      if (doA) {
        A.fill(0);
        for (let k = 0; k < nodeRows; k++) A[k * n + k] += GMIN;
      }
      const stampG = (ia: number, ib: number, g: number) => {
        if (!doA) return;
        if (ia >= 0) A[ia * n + ia] += g;
        if (ib >= 0) A[ib * n + ib] += g;
        if (ia >= 0 && ib >= 0) {
          A[ia * n + ib] -= g;
          A[ib * n + ia] -= g;
        }
      };
      // courant I injecté dans le nœud ia et extrait du nœud ib
      const stampI = (ia: number, ib: number, i: number) => {
        if (ia >= 0) z[ia] += i;
        if (ib >= 0) z[ib] -= i;
      };
      // branche de tension : V(a) − V(b) = e, courant de branche circulant de a vers b dans le composant
      const stampV = (ia: number, ib: number, br: number, e: number) => {
        if (doA) {
          if (ia >= 0) {
            A[ia * n + br] += 1;
            A[br * n + ia] += 1;
          }
          if (ib >= 0) {
            A[ib * n + br] -= 1;
            A[br * n + ib] -= 1;
          }
        }
        z[br] += e;
      };
      const setA = (r: number, col: number, v: number) => {
        if (doA) A[r * n + col] += v;
      };

      let shorted: Component | null = null;
      for (const p of plans) {
        const c = p.c;
        const { ia, ib } = p;
        const sameNode = p.tn.length >= 2 && p.tn[0] === p.tn[1];
        switch (c.type) {
          case "resistor":
          case "lamp":
          case "voltmeter":
            stampG(ia, ib, 1 / Math.max(P(c, "R"), 1e-9));
            break;
          case "capacitor":
          case "inductor": {
            const st = this.state(c.id);
            const m = this.companion(c, st, dt, t, ctx, useBEFor(st));
            stampG(ia, ib, m.g);
            stampI(ib, ia, m.ih);
            break;
          }
          case "currentsource":
          case "ifunc":
          case "iexpr": {
            // le courant sort par le terminal 1 (pointe de la flèche) ; partie linéarisée portée dans A
            const l = behavioral(c, "I");
            stampI(ib, ia, l.k);
            for (const [col, coef] of l.cols) {
              if (ib >= 0) setA(ib, col, -coef);
              if (ia >= 0) setA(ia, col, coef);
            }
            break;
          }
          case "battery":
          case "acsource":
          case "vfunc":
          case "vexpr":
          case "ammeter":
          case "switch": {
            if (p.br < 0) break; // interrupteur ouvert
            if (sameNode) {
              if (c.type !== "ammeter" && c.type !== "switch") shorted = c;
              setA(p.br, p.br, 1); // branche court-circuitée : i = 0, matrice régulière
              break;
            }
            if (c.type === "battery" || c.type === "vfunc" || c.type === "vexpr") {
              const l = behavioral(c, "V");
              stampV(ia, ib, p.br, l.k);
              for (const [col, coef] of l.cols) setA(p.br, col, -coef);
            } else if (c.type === "acsource") {
              stampV(ia, ib, p.br, P(c, "A") * Math.sin(2 * Math.PI * P(c, "f") * t + (P(c, "phi") * Math.PI) / 180) + P(c, "off"));
            } else stampV(ia, ib, p.br, 0);
            break;
          }
          case "vcvs": {
            const E = P(c, "gain");
            if (sameNode) {
              setA(p.br, p.br, 1);
              break;
            }
            stampV(ia, ib, p.br, 0);
            if (p.ic >= 0) setA(p.br, p.ic, -E);
            if (p.id >= 0) setA(p.br, p.id, E);
            break;
          }
          case "vccs": {
            const G = P(c, "gain");
            // courant G·(Vcp − Vcm) circulant de a vers b dans la source
            if (ia >= 0 && p.ic >= 0) setA(ia, p.ic, G);
            if (ia >= 0 && p.id >= 0) setA(ia, p.id, -G);
            if (ib >= 0 && p.ic >= 0) setA(ib, p.ic, -G);
            if (ib >= 0 && p.id >= 0) setA(ib, p.id, G);
            break;
          }
          case "ccvs": {
            const H = P(c, "gain");
            if (p.tn[2] === p.tn[3]) setA(p.brc, p.brc, 1);
            else stampV(p.ic, p.id, p.brc, 0);
            if (sameNode) {
              setA(p.br, p.br, 1);
              break;
            }
            stampV(ia, ib, p.br, 0);
            setA(p.br, p.brc, -H);
            break;
          }
          case "cccs": {
            const F = P(c, "gain");
            if (p.tn[2] === p.tn[3]) setA(p.brc, p.brc, 1);
            else stampV(p.ic, p.id, p.brc, 0);
            // courant F·ic circulant de a vers b dans la source
            if (ia >= 0) setA(ia, p.brc, F);
            if (ib >= 0) setA(ib, p.brc, -F);
            break;
          }
          case "diode":
          case "led": {
            const nvt = VT * P(c, "n");
            const is = P(c, "Is");
            const v = vd.get(c.id)!;
            const ex = Math.exp(Math.min(v / nvt, 80));
            const idd = is * (ex - 1);
            const g = (is * ex) / nvt + GMIN;
            stampG(ia, ib, g);
            stampI(ib, ia, idd - g * v);
            break;
          }
          case "ground":
            break;
        }
      }
      return shorted;
    };

    let x: Float64Array | null = null;
    let converged = diodes.length === 0 && !hasRefs;
    for (let iter = 0; iter < MAX_NEWTON; iter++) {
      if (hasRefs) ctx = ctxAt(xk);
      let LU: Float64Array;
      let piv: Int32Array;
      if (reuse) {
        const shorted = assemble(false);
        if (shorted) {
          this.error = `Source de tension court-circuitée (${shortLabel(shorted)}).`;
          return false;
        }
        LU = this.lu!.LU;
        piv = this.lu!.piv;
      } else {
        const shorted = assemble(true);
        if (shorted) {
          this.error = `Source de tension court-circuitée (${shortLabel(shorted)}).`;
          return false;
        }
        if (!luFactor(A, n, this.piv)) {
          this.error = "Circuit impossible à résoudre : sources de tension en conflit (parallèle ou boucle).";
          return false;
        }
        LU = A;
        piv = this.piv;
        if (this.matrixConstant && dt > 0) {
          // La matrice ne changera plus tant que dt et le schéma d'intégration restent les mêmes.
          this.lu = { LU: Float64Array.from(A), piv: Int32Array.from(this.piv), dt, beCount };
        }
      }
      luSolve(LU, n, piv, z, this.x);
      x = this.x;

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
        xk = Float64Array.from(x);
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
        const va = d.ia >= 0 ? x[d.ia] : 0;
        const vb = d.ib >= 0 ? x[d.ib] : 0;
        const nvt = VT * P(d.c, "n");
        const vcrit = nvt * Math.log(nvt / (Math.SQRT2 * P(d.c, "Is")));
        const old = vd.get(d.c.id)!;
        const vnew = pnjlim(va - vb, old, nvt, vcrit);
        maxDelta = Math.max(maxDelta, Math.abs(vnew - old));
        vd.set(d.c.id, vnew);
      }
      if (maxDelta < 1e-6 && refsOk) {
        converged = true;
        break;
      }
    }
    if (!x) return false;
    this.lastX.set(x);
    if (hasRefs) ctx = ctxAt(x);
    this.warning = converged ? null : hasRefs ? "Convergence difficile (diodes ou expressions)." : "Convergence difficile (diodes).";

    // Tensions de nœuds
    const volts = this.nodeVoltages.length === nl.nodeCount ? this.nodeVoltages : new Float64Array(nl.nodeCount);
    volts[0] = 0;
    for (let k = 1; k < nl.nodeCount; k++) volts[k] = x[k - 1];
    this.nodeVoltages = volts;
    let maxV = 0;
    for (const v of volts) maxV = Math.max(maxV, Math.abs(v));
    if (maxV > 1e7) this.warning = "Tensions énormes : une source de courant est-elle en circuit ouvert ?";

    // Résultats par composant (objets réutilisés d'un pas à l'autre)
    for (const p of plans) {
      const c = p.c;
      let r = this.results.get(c.id);
      if (!r) {
        r = { i: 0, v: 0, p: 0 };
        this.results.set(c.id, r);
      }
      if (p.tn.length < 2) {
        r.i = 0;
        r.v = 0;
        r.p = 0;
        continue;
      }
      const v = volts[p.tn[0]] - volts[p.tn[1]];
      let i = 0;
      switch (c.type) {
        case "resistor":
        case "lamp":
        case "voltmeter":
          i = v / Math.max(P(c, "R"), 1e-9);
          break;
        case "capacitor":
        case "inductor": {
          const s = this.state(c.id);
          if (dt === 0) i = s.iPrev;
          else {
            const m = this.companion(c, s, dt, t, ctx, useBEFor(s));
            i = m.g * v + m.ih;
          }
          if (commit) {
            s.vPrev2 = s.vPrev;
            s.iPrev2 = s.iPrev;
            s.vPrev = v;
            s.iPrev = i;
            s.hist = Math.min(2, s.hist + 1);
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
        case "ccvs":
          i = p.br < 0 ? 0 : x[p.br];
          break;
        case "vccs":
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
        const vc = volts[p.tn[2]] - volts[p.tn[3]];
        let ic = 0;
        if (hasControlBranch(c)) {
          ic = x[p.brc];
          if (c.type === "cccs") i = P(c, "gain") * ic;
        } else if (c.type === "vccs") i = P(c, "gain") * vc;
        r.ic = ic;
        r.vc = vc;
      }
      r.i = i;
      r.v = v;
      r.p = v * i;
    }
    if (commit && this.beStepsLeft > 0) this.beStepsLeft--;
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
      const A = new Float64Array(n * n);
      const z = new Float64Array(n);
      for (const e of edges) {
        if (e.ia < n) A[e.ia * n + e.ia] += e.g;
        if (e.ib < n) A[e.ib * n + e.ib] += e.g;
        if (e.ia < n && e.ib < n) {
          A[e.ia * n + e.ib] -= e.g;
          A[e.ib * n + e.ia] -= e.g;
        }
      }
      for (let k = 0; k < n; k++) {
        A[k * n + k] += 1e-12;
        z[k] = injection.get(vertices[k]) ?? 0;
      }
      const piv = new Int32Array(n);
      if (!luFactor(A, n, piv)) continue;
      const phi = new Float64Array(n);
      luSolve(A, n, piv, z, phi);
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
