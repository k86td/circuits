/** Interaction avec le canvas : sélection, déplacement, tracé de fils, zoom, clavier, boucle d'animation. */

import { type ComponentType, type Rot, type Vec, samePoint, terminalPositions } from "../sim/model";
import type { App } from "./app";
import { type Hit, type Renderer, type View, G, hitTest, screenToWorld, worldToGrid } from "./renderer";

export type Tool = "select" | "wire";

type Mode =
  | { kind: "idle" }
  | { kind: "pan"; start: Vec; panStart: Vec; moved: boolean }
  | { kind: "moveComponent"; id: string; grab: Vec; moved: boolean; wireEnds: { id: string; end: "a" | "b"; term: number }[] }
  | { kind: "moveWire"; id: string; grab: Vec; startA: Vec; startB: Vec; moved: boolean }
  | { kind: "moveWireEnd"; id: string; end: "a" | "b"; moved: boolean }
  | { kind: "drawWire"; from: Vec; to: Vec }
  | { kind: "place"; type: ComponentType; rot: Rot; pos: Vec | null };

export class Editor {
  view: View = { pan: { x: 120, y: 120 }, zoom: 1 };
  tool: Tool = "select";
  hover: Hit | null = null;
  cursorWorld: Vec | null = null;
  private mode: Mode = { kind: "idle" };
  private ctx: CanvasRenderingContext2D;
  private lastFrame = performance.now();
  private toolListeners: ((t: Tool) => void)[] = [];

  constructor(
    private app: App,
    private canvas: HTMLCanvasElement,
    private renderer: Renderer,
  ) {
    this.ctx = canvas.getContext("2d")!;
    canvas.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    window.addEventListener("pointermove", (e) => this.onPointerMove(e));
    window.addEventListener("pointerup", (e) => this.onPointerUp(e));
    canvas.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    canvas.addEventListener("dblclick", (e) => this.onDoubleClick(e));
    window.addEventListener("keydown", (e) => this.onKey(e));
    window.addEventListener("resize", () => this.resize());
    this.resize();
    requestAnimationFrame((t) => this.frame(t));
  }

  onToolChange(fn: (t: Tool) => void): void {
    this.toolListeners.push(fn);
  }

  setTool(t: Tool): void {
    this.tool = t;
    if (this.mode.kind === "place") this.mode = { kind: "idle" };
    this.toolListeners.forEach((fn) => fn(t));
    this.updateCursor();
  }

  /** Démarre le placement d'un composant (depuis la palette). */
  startPlacing(type: ComponentType): void {
    this.mode = { kind: "place", type, rot: 0, pos: null };
    this.updateCursor();
  }

  isPlacing(): boolean {
    return this.mode.kind === "place";
  }

  cancel(): void {
    this.mode = { kind: "idle" };
    this.updateCursor();
  }

  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
  }

  /** Centre la vue sur le circuit. */
  zoomToFit(): void {
    const rect = this.canvas.getBoundingClientRect();
    const c = this.app.circuit;
    if (c.components.length === 0 && c.wires.length === 0) {
      this.view = { pan: { x: rect.width / 2, y: rect.height / 2 }, zoom: 1 };
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const add = (p: Vec) => {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    };
    for (const comp of c.components) {
      add(comp.pos);
      terminalPositions(comp).forEach(add);
    }
    for (const w of c.wires) {
      add(w.a);
      add(w.b);
    }
    const w = (maxX - minX + 8) * G;
    const h = (maxY - minY + 8) * G;
    const zoom = Math.min(2, Math.max(0.3, Math.min(rect.width / w, rect.height / h)));
    const cx = ((minX + maxX) / 2) * G;
    const cy = ((minY + maxY) / 2) * G;
    this.view = { zoom, pan: { x: rect.width / 2 - cx * zoom, y: rect.height / 2 - cy * zoom } };
  }

  private clientToWorld(e: { clientX: number; clientY: number }): Vec {
    const rect = this.canvas.getBoundingClientRect();
    return screenToWorld({ x: e.clientX - rect.left, y: e.clientY - rect.top }, this.view);
  }

  private inCanvas(e: { clientX: number; clientY: number }): boolean {
    const rect = this.canvas.getBoundingClientRect();
    return e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0 && e.button !== 1) return;
    const target = e.target as HTMLElement;
    target.focus?.();
    const world = this.clientToWorld(e);
    const grid = worldToGrid(world);

    if (this.mode.kind === "place") {
      const m = this.mode;
      this.app.addComponent(m.type, grid, m.rot);
      if (!e.shiftKey) this.mode = { kind: "idle" };
      this.updateCursor();
      return;
    }
    if (e.button === 1) {
      this.mode = { kind: "pan", start: { x: e.clientX, y: e.clientY }, panStart: { ...this.view.pan }, moved: false };
      return;
    }

    const hit = hitTest(this.app, world, this.view.zoom);
    if (this.tool === "wire") {
      const from = hit && (hit.kind === "terminal" || hit.kind === "wireEnd") ? hit.point : grid;
      this.mode = { kind: "drawWire", from, to: from };
      return;
    }

    if (!hit) {
      this.app.select(null);
      this.mode = { kind: "pan", start: { x: e.clientX, y: e.clientY }, panStart: { ...this.view.pan }, moved: false };
      return;
    }
    if (hit.kind === "terminal") {
      this.mode = { kind: "drawWire", from: hit.point, to: hit.point };
      return;
    }
    if (hit.kind === "wireEnd") {
      const sel = this.app.selection;
      if (sel?.kind === "wire" && sel.id === hit.id) {
        this.mode = { kind: "moveWireEnd", id: hit.id, end: hit.end, moved: false };
      } else {
        this.mode = { kind: "drawWire", from: hit.point, to: hit.point };
      }
      return;
    }
    if (hit.kind === "component") {
      const c = this.app.componentById(hit.id)!;
      this.app.select({ kind: "component", id: c.id });
      const terms = terminalPositions(c);
      const wireEnds: { id: string; end: "a" | "b"; term: number }[] = [];
      for (const w of this.app.circuit.wires) {
        for (const end of ["a", "b"] as const) {
          const term = terms.findIndex((t) => samePoint(t, w[end]));
          if (term >= 0) wireEnds.push({ id: w.id, end, term });
        }
      }
      this.mode = {
        kind: "moveComponent",
        id: c.id,
        grab: { x: world.x / G - c.pos.x, y: world.y / G - c.pos.y },
        moved: false,
        wireEnds,
      };
      return;
    }
    if (hit.kind === "wire") {
      const w = this.app.circuit.wires.find((x) => x.id === hit.id)!;
      this.app.select({ kind: "wire", id: w.id });
      this.mode = { kind: "moveWire", id: w.id, grab: { x: world.x / G, y: world.y / G }, startA: { ...w.a }, startB: { ...w.b }, moved: false };
    }
  }

  private onPointerMove(e: PointerEvent): void {
    const world = this.clientToWorld(e);
    const grid = worldToGrid(world);
    const inside = this.inCanvas(e);
    this.cursorWorld = inside ? world : null;
    const m = this.mode;
    switch (m.kind) {
      case "idle":
        this.hover = inside ? hitTest(this.app, world, this.view.zoom) : null;
        break;
      case "place":
        m.pos = inside ? grid : null;
        break;
      case "pan": {
        const dx = e.clientX - m.start.x;
        const dy = e.clientY - m.start.y;
        if (Math.hypot(dx, dy) > 3) m.moved = true;
        this.view.pan = { x: m.panStart.x + dx, y: m.panStart.y + dy };
        break;
      }
      case "moveComponent": {
        const c = this.app.componentById(m.id);
        if (!c) break;
        const np = { x: Math.round(world.x / G - m.grab.x), y: Math.round(world.y / G - m.grab.y) };
        if (samePoint(np, c.pos)) break;
        if (!m.moved) {
          m.moved = true;
          this.app.snapshot();
        }
        c.pos = np;
        const newTerms = terminalPositions(c);
        for (const we of m.wireEnds) {
          const w = this.app.circuit.wires.find((x) => x.id === we.id);
          if (w) w[we.end] = { ...newTerms[we.term] };
        }
        this.app.sim.circuit = this.app.circuit;
        this.app.sim.rebuild();
        this.app.sim.computeWireCurrents();
        break;
      }
      case "moveWire": {
        const w = this.app.circuit.wires.find((x) => x.id === m.id);
        if (!w) break;
        const dx = Math.round(world.x / G - m.grab.x);
        const dy = Math.round(world.y / G - m.grab.y);
        const na = { x: m.startA.x + dx, y: m.startA.y + dy };
        if (samePoint(na, w.a)) break;
        if (!m.moved) {
          m.moved = true;
          this.app.snapshot();
        }
        w.a = na;
        w.b = { x: m.startB.x + dx, y: m.startB.y + dy };
        this.app.sim.rebuild();
        break;
      }
      case "moveWireEnd": {
        const w = this.app.circuit.wires.find((x) => x.id === m.id);
        if (!w) break;
        if (samePoint(grid, w[m.end])) break;
        if (!m.moved) {
          m.moved = true;
          this.app.snapshot();
        }
        w[m.end] = grid;
        this.app.sim.rebuild();
        break;
      }
      case "drawWire": {
        const hit = hitTest(this.app, world, this.view.zoom);
        m.to = hit && (hit.kind === "terminal" || hit.kind === "wireEnd") ? hit.point : grid;
        this.hover = hit && (hit.kind === "terminal" || hit.kind === "wireEnd") ? hit : null;
        break;
      }
    }
    this.updateCursor();
  }

  private onPointerUp(e: PointerEvent): void {
    const m = this.mode;
    switch (m.kind) {
      case "pan":
        this.mode = { kind: "idle" };
        break;
      case "moveComponent": {
        this.mode = { kind: "idle" };
        if (m.moved) this.app.afterChange();
        else {
          const c = this.app.componentById(m.id);
          if (c?.type === "switch") this.app.toggleSwitch(c.id);
        }
        break;
      }
      case "moveWire":
      case "moveWireEnd":
        this.mode = { kind: "idle" };
        if (m.moved) this.app.afterChange();
        break;
      case "drawWire":
        this.mode = { kind: "idle" };
        if (!samePoint(m.from, m.to)) this.app.addWire(m.from, m.to);
        break;
      case "place":
        // Glisser-déposer depuis la palette : dépôt au relâchement sur le canevas.
        if (this.placeOnRelease && m.pos && this.inCanvas(e)) {
          this.app.addComponent(m.type, m.pos, m.rot);
          this.mode = { kind: "idle" };
        }
        break;
      default:
        break;
    }
    this.placeOnRelease = false;
    this.updateCursor();
  }

  /** true quand un glisser depuis la palette est en cours (dépôt au relâchement). */
  placeOnRelease = false;

  private onDoubleClick(e: MouseEvent): void {
    const world = this.clientToWorld(e);
    const hit = hitTest(this.app, world, this.view.zoom);
    if (hit?.kind === "component") {
      const input = document.querySelector<HTMLInputElement>("#props input[data-main]");
      input?.focus();
      input?.select();
    }
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const factor = Math.exp(-e.deltaY * 0.0015);
    const nz = Math.min(4, Math.max(0.2, this.view.zoom * factor));
    const k = nz / this.view.zoom;
    this.view.pan = { x: sx - (sx - this.view.pan.x) * k, y: sy - (sy - this.view.pan.y) * k };
    this.view.zoom = nz;
  }

  private onKey(e: KeyboardEvent): void {
    const t = e.target as HTMLElement;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) this.app.redo();
      else this.app.undo();
      return;
    }
    if (ctrl && e.key.toLowerCase() === "y") {
      e.preventDefault();
      this.app.redo();
      return;
    }
    if (ctrl && e.key.toLowerCase() === "d") {
      e.preventDefault();
      this.app.duplicateSelection();
      return;
    }
    switch (e.key) {
      case "Delete":
      case "Backspace":
        e.preventDefault();
        this.app.deleteSelection();
        break;
      case "r":
      case "R":
        if (this.mode.kind === "place") this.mode.rot = ((this.mode.rot + 1) % 4) as Rot;
        else this.app.rotateSelection();
        break;
      case "Escape":
        this.cancel();
        this.setTool("select");
        this.app.select(null);
        break;
      case " ":
        e.preventDefault();
        this.app.toggleRunning();
        break;
      case "w":
      case "W":
        this.setTool(this.tool === "wire" ? "select" : "wire");
        break;
      case "v":
      case "V":
        this.setTool("select");
        break;
      case "f":
      case "F":
        this.zoomToFit();
        break;
    }
  }

  private updateCursor(): void {
    let cursor = "default";
    const m = this.mode;
    if (m.kind === "place") cursor = "copy";
    else if (m.kind === "pan") cursor = m.moved ? "grabbing" : "default";
    else if (m.kind === "drawWire") cursor = "crosshair";
    else if (m.kind === "moveComponent" || m.kind === "moveWire" || m.kind === "moveWireEnd") cursor = "move";
    else if (this.tool === "wire") cursor = "crosshair";
    else if (this.hover?.kind === "terminal" || this.hover?.kind === "wireEnd") cursor = "crosshair";
    else if (this.hover) cursor = "pointer";
    this.canvas.style.cursor = cursor;
  }

  private frame(now: number): void {
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    this.app.advance(dt);
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    if (Math.round(rect.width * dpr) !== this.canvas.width || Math.round(rect.height * dpr) !== this.canvas.height) this.resize();
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const m = this.mode;
    this.renderer.draw(this.ctx, this.view, {
      width: rect.width,
      height: rect.height,
      hover: m.kind === "idle" || m.kind === "drawWire" ? this.hover : null,
      wirePreview: m.kind === "drawWire" ? { a: m.from, b: m.to } : null,
      ghost: m.kind === "place" && m.pos ? { type: m.type, pos: m.pos, rot: m.rot } : null,
      frameDt: dt,
      cursor: m.kind === "idle" ? this.cursorWorld : null,
    });
    requestAnimationFrame((t) => this.frame(t));
  }
}

