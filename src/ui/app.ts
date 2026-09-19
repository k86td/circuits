/** État global de l'application : circuit, simulateur, options, sélection, historique. */

import { EXAMPLES } from "../sim/examples";
import {
  type Circuit,
  type Component,
  type ComponentType,
  type PropValue,
  type Rot,
  type Vec,
  type Wire,
  autoName,
  cloneCircuit,
  createComponent,
  pointKey,
  samePoint,
} from "../sim/model";
import { normalizeWires } from "../sim/netlist";
import { type ComponentResult, Simulator } from "../sim/solver";
import { addVec, relocateComponent, routeWire, translateWires, wirePath, polylineWires } from "../sim/wiring";
import { Scope } from "./scope";

export interface Options {
  electrons: boolean;
  /** true : sens conventionnel (+ vers −) ; false : sens réel des électrons. */
  conventional: boolean;
  voltageColors: boolean;
  /** Flèches indiquant le sens conventionnel du courant sur les fils et les composants. */
  currentArrows: boolean;
  showValues: boolean;
  showReadings: boolean;
  /** Courant de référence pour la vitesse des électrons (A). */
  iRef: number;
}

/**
 * Sélection : un composant, ou un fil. Pour un fil, `ids` est le chemin complet (segments reliés bout à bout
 * sans embranchement) auquel appartient le segment cliqué `id` ; avec `single`, seul ce segment est retenu.
 */
export type Selection = { kind: "component"; id: string } | { kind: "wire"; id: string; ids: string[]; single?: boolean } | null;

export type AppEvent = "change" | "select" | "tick" | "run" | "options" | "speed";

/** Vitesses de simulation proposées (temps simulé / temps réel). */
export const SPEEDS = [1e-4, 2e-4, 5e-4, 1e-3, 2e-3, 5e-3, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10];

const STORAGE_KEY = "circuits.autosave.v1";
const OPTIONS_KEY = "circuits.options.v1";

export class App {
  circuit: Circuit;
  sim: Simulator;
  scope = new Scope();
  running = false;
  /** Facteur temps simulé / temps réel. */
  timeScale = 1;
  /** Facteur réellement atteint (si le calcul est trop lourd). */
  effectiveScale = 1;
  lastSteps = 0;
  selection: Selection = null;
  options: Options = {
    electrons: true,
    conventional: false,
    voltageColors: true,
    currentArrows: true,
    showValues: true,
    showReadings: false,
    iRef: 5e-3,
  };
  /** Composant copié (y / Ctrl+C), collé avec p / Ctrl+V. */
  clipboard: Component | null = null;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private listeners = new Map<AppEvent, Set<() => void>>();
  private coalesce: { tag: string; time: number } | null = null;
  /** Rotations successives d'un même composant : on repart de la géométrie d'avant la première (r r = 180° sur place). */
  private rotateBase: { id: string; circuit: string; rot: Rot; turns: number } | null = null;

  constructor() {
    this.circuit = { components: [], wires: [] };
    this.sim = new Simulator(this.circuit);
    try {
      const o = localStorage.getItem(OPTIONS_KEY);
      if (o) Object.assign(this.options, JSON.parse(o));
    } catch {
      /* ignore */
    }
  }

  on(evt: AppEvent, fn: () => void): void {
    if (!this.listeners.has(evt)) this.listeners.set(evt, new Set());
    this.listeners.get(evt)!.add(fn);
  }

  emit(evt: AppEvent): void {
    this.listeners.get(evt)?.forEach((fn) => fn());
  }

  setOptions(patch: Partial<Options>): void {
    Object.assign(this.options, patch);
    try {
      localStorage.setItem(OPTIONS_KEY, JSON.stringify(this.options));
    } catch {
      /* ignore */
    }
    this.emit("options");
  }

  // ---- Chargement / sauvegarde ----

  setCircuit(c: Circuit, pushUndo = true): void {
    if (pushUndo) this.snapshot();
    this.circuit = cloneCircuit(c);
    normalizeWires(this.circuit);
    this.selection = null;
    this.sim = new Simulator(this.circuit);
    this.scope.prune(this.circuit);
    this.scope.clearSamples();
    this.afterChange();
    this.emit("select");
  }

  loadExample(id: string): void {
    const ex = EXAMPLES.find((e) => e.id === id);
    if (!ex) return;
    this.scope.traces = [];
    this.setCircuit(ex.build());
    this.sim.reset();
    this.emit("change");
  }

  serialize(): string {
    return JSON.stringify({
      version: 1,
      circuit: this.circuit,
      traces: this.scope.traces.map((t) => ({ compId: t.compId, q: t.q })),
      window: this.scope.window,
    });
  }

  loadJSON(text: string): boolean {
    try {
      const data = JSON.parse(text);
      const circuit: Circuit = data.circuit ?? data;
      if (!Array.isArray(circuit.components) || !Array.isArray(circuit.wires)) return false;
      this.scope.traces = [];
      this.setCircuit(circuit);
      if (Array.isArray(data.traces)) {
        for (const t of data.traces) if (this.circuit.components.some((c) => c.id === t.compId)) this.scope.toggle(t.compId, t.q);
      }
      if (typeof data.window === "number") this.scope.window = data.window;
      this.sim.reset();
      this.emit("change");
      return true;
    } catch {
      return false;
    }
  }

  autosave(): void {
    try {
      localStorage.setItem(STORAGE_KEY, this.serialize());
    } catch {
      /* ignore */
    }
  }

  restoreAutosave(): boolean {
    try {
      const text = localStorage.getItem(STORAGE_KEY);
      if (!text) return false;
      return this.loadJSON(text);
    } catch {
      return false;
    }
  }

  // ---- Historique ----

  snapshot(): void {
    this.undoStack.push(JSON.stringify(this.circuit));
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
    this.coalesce = null;
    this.rotateBase = null;
  }

  /**
   * Instantané regroupé : des modifications répétées de même nature (déplacement au clavier, pas à pas)
   * ne créent qu'une seule entrée d'historique tant qu'elles se suivent de moins de `windowMs`.
   * Renvoie vrai si un nouvel instantané a été pris.
   */
  private snapshotCoalesced(tag: string, windowMs = 1000): boolean {
    const now = performance.now();
    if (this.coalesce && this.coalesce.tag === tag && now - this.coalesce.time < windowMs) {
      this.coalesce.time = now;
      return false;
    }
    this.snapshot();
    this.coalesce = { tag, time: now };
    return true;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): void {
    const prev = this.undoStack.pop();
    if (prev === undefined) return;
    this.redoStack.push(JSON.stringify(this.circuit));
    this.circuit = JSON.parse(prev);
    this.selection = null;
    this.sim.circuit = this.circuit;
    this.afterChange();
    this.emit("select");
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (next === undefined) return;
    this.undoStack.push(JSON.stringify(this.circuit));
    this.circuit = JSON.parse(next);
    this.selection = null;
    this.sim.circuit = this.circuit;
    this.afterChange();
    this.emit("select");
  }

  /** À appeler après toute mutation du circuit. */
  afterChange(): void {
    const sel = this.selection;
    normalizeWires(this.circuit, new Set(sel?.kind === "wire" ? sel.ids : []));
    this.sim.circuit = this.circuit;
    this.sim.rebuild();
    this.sim.computeWireCurrents();
    this.scope.prune(this.circuit);
    this.scope.flipped = new Set(this.circuit.components.filter((c) => c.flipRef).map((c) => c.id));
    // La normalisation peut avoir fusionné ou coupé des fils : on recalcule le chemin sélectionné.
    if (sel?.kind === "wire") {
      if (!this.circuit.wires.some((w) => w.id === sel.id)) {
        this.selection = null;
        this.emit("select");
      } else sel.ids = sel.single ? [sel.id] : wirePath(this.circuit, sel.id);
    } else if (sel?.kind === "component" && !this.circuit.components.some((c) => c.id === sel.id)) {
      this.selection = null;
      this.emit("select");
    }
    this.autosave();
    this.emit("change");
  }

  /**
   * Aperçu pendant un glisser : repart de `base` (état au début du geste), applique la modification et
   * recalcule la simulation, sans normaliser ni enregistrer (voir afterChange à la fin du geste).
   */
  preview(base: Circuit, fn: (c: Circuit) => void): void {
    this.circuit = cloneCircuit(base);
    fn(this.circuit);
    this.sim.circuit = this.circuit;
    this.sim.rebuild();
    this.sim.computeWireCurrents();
  }

  /** Signe appliqué à V et I d'un composant selon son sens de référence (+1 : terminal 0 → 1, −1 : inversé). */
  refSign(c: Component): 1 | -1 {
    return c.flipRef ? -1 : 1;
  }

  /**
   * Valeurs affichées d'un composant : V et I sont signés par rapport à sa flèche de référence
   * (V = potentiel à la queue de la flèche − potentiel à la pointe) ; P est la puissance absorbée.
   */
  display(c: Component, r: ComponentResult): ComponentResult {
    const s = this.refSign(c);
    return { v: s * r.v, i: s * r.i, p: r.p, vc: r.vc, ic: r.ic };
  }

  /** Inverse le sens de référence du courant d'un composant. */
  flipReference(id: string): void {
    const c = this.componentById(id);
    if (!c || c.type === "ground") return;
    this.snapshot();
    c.flipRef = !c.flipRef;
    if (!c.flipRef) delete c.flipRef;
    this.afterChange();
  }

  // ---- Sélection ----

  select(sel: Selection): void {
    if (sel?.kind === "wire") sel = { kind: "wire", id: sel.id, ids: sel.single ? [sel.id] : wirePath(this.circuit, sel.id), single: sel.single };
    if (
      (sel === null && this.selection === null) ||
      (sel && this.selection && sel.kind === this.selection.kind && sel.id === this.selection.id && (sel.kind !== "wire" || sel.single === (this.selection as { single?: boolean }).single))
    )
      return;
    this.selection = sel;
    this.emit("select");
  }

  /** Sélectionne un fil : le chemin complet, ou ce seul segment. */
  selectWire(id: string, single = false): void {
    this.select({ kind: "wire", id, ids: [], single });
  }

  /** Identifiants des fils sélectionnés (chemin complet). */
  selectedWireIds(): string[] {
    return this.selection?.kind === "wire" ? this.selection.ids : [];
  }

  selectedComponent(): Component | undefined {
    if (this.selection?.kind !== "component") return undefined;
    return this.circuit.components.find((c) => c.id === this.selection!.id);
  }

  selectedWire(): Wire | undefined {
    if (this.selection?.kind !== "wire") return undefined;
    return this.circuit.wires.find((w) => w.id === this.selection!.id);
  }

  componentById(id: string): Component | undefined {
    return this.circuit.components.find((c) => c.id === id);
  }

  // ---- Édition ----

  addComponent(type: ComponentType, pos: Vec, rot: Rot = 0): Component {
    this.snapshot();
    const c = createComponent(type, pos, rot);
    c.name = autoName(this.circuit, type);
    this.circuit.components.push(c);
    this.afterChange();
    this.select({ kind: "component", id: c.id });
    return c;
  }

  /** Trajet qu'aurait un nouveau fil entre deux points (aperçu et création). */
  routeWire(a: Vec, b: Vec): Vec[] {
    return routeWire(this.circuit, a, b);
  }

  /** Ajoute un fil orthogonal entre deux points de grille (le long des pattes si ce sont des terminaux). */
  addWire(a: Vec, b: Vec): void {
    if (samePoint(a, b)) return;
    this.snapshot();
    this.circuit.wires.push(...polylineWires(this.routeWire(a, b)));
    this.afterChange();
  }

  deleteSelection(): void {
    if (!this.selection) return;
    this.snapshot();
    if (this.selection.kind === "component") {
      const id = this.selection.id;
      this.circuit.components = this.circuit.components.filter((c) => c.id !== id);
    } else {
      const ids = new Set(this.selection.ids);
      this.circuit.wires = this.circuit.wires.filter((w) => !ids.has(w.id));
    }
    this.selection = null;
    this.afterChange();
    this.emit("select");
  }

  /**
   * Pivote le composant sélectionné (ou celui donné) de 90°, horaire par défaut, en gardant ses fils raccordés.
   * Des rotations rapprochées du même composant sont recalculées depuis la géométrie d'avant la première :
   * r r retourne le composant sur place (ses fils changent de terminal), r r r r le remet exactement.
   */
  rotateSelection(dir: 1 | -1 = 1, id?: string): void {
    const c = id ? this.componentById(id) : this.selectedComponent();
    if (!c) return;
    const fresh = this.snapshotCoalesced(`rotate:${c.id}`, 2500);
    if (fresh || !this.rotateBase || this.rotateBase.id !== c.id) {
      this.rotateBase = { id: c.id, circuit: JSON.stringify(this.circuit), rot: c.rot, turns: 0 };
    }
    const base = this.rotateBase;
    base.turns += dir;
    this.circuit = JSON.parse(base.circuit);
    const comp = this.componentById(c.id)!;
    relocateComponent(this.circuit, comp, comp.pos, ((((base.rot + base.turns) % 4) + 4) % 4) as Rot);
    this.afterChange();
    this.rotateBase = base;
  }

  /** Déplace un composant (ses fils suivent, re-routés orthogonalement). */
  moveComponent(id: string, pos: Vec): void {
    const c = this.componentById(id);
    if (!c || samePoint(c.pos, pos)) return;
    this.snapshot();
    relocateComponent(this.circuit, c, pos, c.rot);
    this.afterChange();
  }

  /** Déplace la sélection (composant ou chemin de fils) d'un pas de grille ; les déplacements rapprochés forment une seule annulation. */
  nudgeSelection(delta: Vec): void {
    const sel = this.selection;
    if (!sel) return;
    if (sel.kind === "component") {
      const c = this.componentById(sel.id);
      if (!c) return;
      this.snapshotCoalesced(`nudge:${c.id}`);
      relocateComponent(this.circuit, c, addVec(c.pos, delta), c.rot);
    } else {
      this.snapshotCoalesced(`nudge:${sel.id}`);
      translateWires(this.circuit, sel.ids, delta);
    }
    this.afterChange();
  }

  duplicateSelection(): void {
    const c = this.selectedComponent();
    if (!c) return;
    this.placeCopy(c, { x: c.pos.x + 2, y: c.pos.y + 2 });
  }

  /** Copie le composant sélectionné (ou donné) dans le presse-papiers interne. */
  copySelection(id?: string): boolean {
    const c = id ? this.componentById(id) : this.selectedComponent();
    if (!c) return false;
    this.clipboard = cloneCircuit({ components: [c], wires: [] }).components[0];
    return true;
  }

  /** Colle le composant du presse-papiers à la position donnée. */
  paste(pos: Vec): boolean {
    if (!this.clipboard) return false;
    this.placeCopy(this.clipboard, pos);
    return true;
  }

  private placeCopy(src: Component, pos: Vec): void {
    this.snapshot();
    const copy = cloneCircuit({ components: [src], wires: [] }).components[0];
    copy.id = createComponent(src.type, pos).id;
    copy.name = autoName(this.circuit, src.type);
    copy.pos = { ...pos };
    this.circuit.components.push(copy);
    this.afterChange();
    this.select({ kind: "component", id: copy.id });
  }

  setProp(id: string, key: string, value: PropValue): void {
    const c = this.componentById(id);
    if (!c) return;
    this.snapshot();
    c.props[key] = value;
    this.afterChange();
  }

  setName(id: string, name: string): void {
    const c = this.componentById(id);
    if (!c) return;
    this.snapshot();
    c.name = name.trim() || undefined;
    this.afterChange();
  }

  toggleSwitch(id: string): void {
    const c = this.componentById(id);
    if (!c || c.type !== "switch") return;
    c.closed = !c.closed;
    this.afterChange();
  }

  clearAll(): void {
    this.scope.traces = [];
    this.setCircuit({ components: [], wires: [] });
    this.sim.reset();
    this.emit("change");
  }

  // ---- Simulation ----

  setRunning(v: boolean): void {
    this.running = v;
    this.emit("run");
  }

  setTimeScale(v: number): void {
    if (v === this.timeScale) return;
    this.timeScale = v;
    this.emit("speed");
  }

  /** Passe à la vitesse de simulation suivante (+1) ou précédente (−1) de la liste SPEEDS. */
  stepTimeScale(dir: 1 | -1): void {
    let idx = SPEEDS.findIndex((s) => s >= this.timeScale);
    if (idx < 0) idx = SPEEDS.length - 1;
    idx = Math.max(0, Math.min(SPEEDS.length - 1, idx + dir));
    this.setTimeScale(SPEEDS[idx]);
  }

  toggleRunning(): void {
    this.setRunning(!this.running);
  }

  reset(): void {
    this.sim.reset();
    this.sim.computeWireCurrents();
    this.scope.clearSamples();
    this.emit("change");
  }

  /** Pas de temps pour une vitesse donnée : ~400 pas par image à 60 Hz, borné (stable d'une image à l'autre). */
  static timeStep(timeScale: number): number {
    return Math.min(Math.max((timeScale / 60) / 400, 1e-9), 2e-4);
  }

  /**
   * Fait avancer la simulation de realSeconds × timeScale. Le pas ne dépend que de la vitesse (la factorisation
   * de la matrice est ainsi réutilisée d'une image à l'autre) ; le nombre de pas est plafonné, et le calcul s'arrête
   * dès que le budget temps de l'image est consommé pour ne jamais faire saccader l'affichage : la vitesse réelle
   * (effectiveScale) est alors inférieure à la vitesse demandée.
   */
  advance(realSeconds: number): void {
    if (!this.running || this.sim.error) {
      this.lastSteps = 0;
      return;
    }
    const simSpan = Math.min(realSeconds, 0.05) * this.timeScale;
    const maxSteps = 4000;
    const budgetMs = 9;
    const dt = App.timeStep(this.timeScale);
    const wanted = Math.min(maxSteps, Math.max(1, Math.round(simSpan / dt)));
    this.sim.dt = dt;
    const t0 = performance.now();
    let done = 0;
    for (; done < wanted; done++) {
      this.sim.step();
      if (this.sim.error) break;
      this.scope.sample(this.sim.time, this.sim.results);
      if ((done & 31) === 31 && performance.now() - t0 > budgetMs) {
        done++;
        break;
      }
    }
    const achieved = (done * dt) / Math.max(realSeconds, 1e-6);
    this.effectiveScale = done >= wanted ? this.timeScale : Math.min(this.timeScale, achieved);
    this.lastSteps = done;
    this.sim.computeWireCurrents();
    if (this.sim.error) this.setRunning(false);
    this.emit("tick");
  }

  /** Tension au point de grille p, ou null. */
  voltageAtPoint(p: Vec): number | null {
    return this.sim.voltageAt(pointKey(p));
  }
}
