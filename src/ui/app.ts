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
  createWire,
  pointKey,
  samePoint,
  terminalPositions,
} from "../sim/model";
import { normalizeWires } from "../sim/netlist";
import { type ComponentResult, Simulator } from "../sim/solver";
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

export type Selection = { kind: "component"; id: string } | { kind: "wire"; id: string } | null;

export type AppEvent = "change" | "select" | "tick" | "run" | "options";

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
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private listeners = new Map<AppEvent, Set<() => void>>();

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
    normalizeWires(this.circuit);
    this.sim.circuit = this.circuit;
    this.sim.rebuild();
    this.sim.computeWireCurrents();
    this.scope.prune(this.circuit);
    this.scope.flipped = new Set(this.circuit.components.filter((c) => c.flipRef).map((c) => c.id));
    this.autosave();
    this.emit("change");
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
    if (
      (sel === null && this.selection === null) ||
      (sel && this.selection && sel.kind === this.selection.kind && sel.id === this.selection.id)
    )
      return;
    this.selection = sel;
    this.emit("select");
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

  /** Ajoute un fil en L (horizontal puis vertical) entre deux points de grille. */
  addWire(a: Vec, b: Vec): void {
    if (samePoint(a, b)) return;
    this.snapshot();
    if (a.x !== b.x && a.y !== b.y) {
      const corner = { x: b.x, y: a.y };
      this.circuit.wires.push(createWire(a, corner), createWire(corner, b));
    } else {
      this.circuit.wires.push(createWire(a, b));
    }
    this.afterChange();
  }

  deleteSelection(): void {
    if (!this.selection) return;
    this.snapshot();
    if (this.selection.kind === "component") {
      const id = this.selection.id;
      this.circuit.components = this.circuit.components.filter((c) => c.id !== id);
    } else {
      const id = this.selection.id;
      this.circuit.wires = this.circuit.wires.filter((w) => w.id !== id);
    }
    this.selection = null;
    this.afterChange();
    this.emit("select");
  }

  rotateSelection(): void {
    const c = this.selectedComponent();
    if (!c) return;
    this.snapshot();
    const tBefore = terminalPositions(c);
    c.rot = ((c.rot + 1) % 4) as Rot;
    const tAfter = terminalPositions(c);
    this.moveAttachedWires(tBefore, tAfter);
    this.afterChange();
  }

  duplicateSelection(): void {
    const c = this.selectedComponent();
    if (!c) return;
    this.snapshot();
    const copy = cloneCircuit({ components: [c], wires: [] }).components[0];
    copy.id = createComponent(c.type, c.pos).id;
    copy.name = autoName(this.circuit, c.type);
    copy.pos = { x: c.pos.x + 2, y: c.pos.y + 2 };
    this.circuit.components.push(copy);
    this.afterChange();
    this.select({ kind: "component", id: copy.id });
  }

  /** Déplace les extrémités de fils qui étaient sur d'anciens terminaux vers les nouveaux. */
  moveAttachedWires(before: Vec[], after: Vec[]): void {
    for (const w of this.circuit.wires) {
      for (const end of ["a", "b"] as const) {
        const idx = before.findIndex((p) => samePoint(p, w[end]));
        if (idx >= 0) w[end] = { ...after[idx] };
      }
    }
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

  toggleRunning(): void {
    this.setRunning(!this.running);
  }

  reset(): void {
    this.sim.reset();
    this.sim.computeWireCurrents();
    this.scope.clearSamples();
    this.emit("change");
  }

  /** Fait avancer la simulation de realSeconds × timeScale. */
  advance(realSeconds: number): void {
    if (!this.running || this.sim.error) {
      this.lastSteps = 0;
      return;
    }
    const simSpan = Math.min(realSeconds, 0.05) * this.timeScale;
    const maxSteps = 3000;
    let dt = simSpan / 400;
    dt = Math.min(Math.max(dt, 1e-9), 2e-4);
    let steps = Math.round(simSpan / dt);
    if (steps > maxSteps) {
      steps = maxSteps;
      this.effectiveScale = (steps * dt) / Math.max(realSeconds, 1e-6);
    } else {
      this.effectiveScale = this.timeScale;
    }
    this.sim.dt = dt;
    for (let k = 0; k < steps; k++) {
      this.sim.step();
      if (this.sim.error) break;
      this.scope.sample(this.sim.time, this.sim.results);
    }
    this.lastSteps = steps;
    this.sim.computeWireCurrents();
    if (this.sim.error) this.setRunning(false);
    this.emit("tick");
  }

  /** Tension au point de grille p, ou null. */
  voltageAtPoint(p: Vec): number | null {
    return this.sim.voltageAt(pointKey(p));
  }
}
