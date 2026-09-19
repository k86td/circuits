/**
 * Interaction avec le canvas : sélection, déplacement, tracé de fils, zoom, clavier, boucle d'animation.
 *
 * Deux façons de travailler cohabitent :
 * - la souris : glisser un composant, un chemin de fils ou une jonction (les fils suivent, élastiques et
 *   orthogonaux), tirer un fil depuis un terminal, zoomer à la molette ;
 * - le clavier seul : un curseur de grille déplacé par h j k l, des composants posés sous le curseur,
 *   des fils tracés avec w, et des commandes (voir commands.ts) atteintes par une touche ou par la touche
 *   maître Espace suivie d'un sous-menu.
 */

import { type Circuit, type ComponentType, type Rot, type Vec, cloneCircuit, samePoint } from "../sim/model";
import { moveWireEnd, relocateComponent, translateWires } from "../sim/wiring";
import type { App } from "./app";
import { isButtonTarget, isEditableElement, isEditableTarget } from "./dom";
import type { Keymap } from "./keys";
import { type Hit, type Renderer, type View, G, gridToWorld, hitTest, screenToWorld, worldToGrid, worldToScreen } from "./renderer";

export type Tool = "select" | "wire";

type Mode =
  | { kind: "idle" }
  | { kind: "pan"; start: Vec; panStart: Vec; moved: boolean }
  | { kind: "moveComponent"; id: string; grab: Vec; base: Circuit; last: Vec; moved: boolean }
  | { kind: "moveWires"; ids: string[]; grab: Vec; base: Circuit; last: Vec; moved: boolean; detach: boolean }
  | { kind: "moveWireEnd"; id: string; end: "a" | "b"; base: Circuit; last: Vec; moved: boolean; group: boolean }
  | { kind: "drawWire"; from: Vec; to: Vec }
  | { kind: "place"; type: ComponentType; rot: Rot; pos: Vec | null };

export class Editor {
  view: View = { pan: { x: 120, y: 120 }, zoom: 1 };
  tool: Tool = "select";
  hover: Hit | null = null;
  cursorWorld: Vec | null = null;
  /** Curseur clavier (point de grille) ; null tant qu'il n'a pas servi. */
  kcursor: Vec | null = null;
  /** Point de départ du fil en cours de tracé au clavier. */
  kwire: Vec | null = null;
  /** Mode déplacement : h j k l déplacent la sélection au lieu du curseur. */
  moveMode = false;
  /** true quand un glisser depuis la palette est en cours (dépôt au relâchement). */
  placeOnRelease = false;
  keymap: Keymap | null = null;
  private khit: Hit | null = null;
  private mode: Mode = { kind: "idle" };
  private ctx: CanvasRenderingContext2D;
  private lastFrame = performance.now();
  private toolListeners: ((t: Tool) => void)[] = [];
  private lastModeLabel = "";
  /** Bord gauche du canevas à l'image précédente : quand un panneau glisse, le circuit reste immobile à l'écran. */
  private lastLeft: number | null = null;

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
    // Échap dans un champ de saisie : retour au canevas (« mode normal »), sauf dans un dialogue ou un menu.
    window.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Escape" || !isEditableTarget(e)) return;
        if (e.composedPath().some((el) => el instanceof HTMLElement && /^MD-(DIALOG|MENU)$/.test(el.tagName))) return;
        this.focusCanvas();
      },
      true,
    );
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

  /** Démarre le placement d'un composant à la souris (depuis la palette). */
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

  /** Rend le focus au canevas (les raccourcis globaux redeviennent actifs). */
  focusCanvas(): void {
    const active = document.activeElement as HTMLElement | null;
    active?.blur();
    this.canvas.focus({ preventScroll: true });
  }

  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
  }

  // ---- Vue ----

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
      add({ x: comp.pos.x - 2, y: comp.pos.y - 2 });
      add({ x: comp.pos.x + 2, y: comp.pos.y + 2 });
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

  /** Zoome d'un facteur autour d'un point écran (par défaut : curseur clavier ou centre). */
  zoomBy(factor: number, about?: Vec): void {
    const rect = this.canvas.getBoundingClientRect();
    const s = about ?? (this.kcursor ? worldToScreen(gridToWorld(this.kcursor), this.view) : { x: rect.width / 2, y: rect.height / 2 });
    const nz = Math.min(4, Math.max(0.2, this.view.zoom * factor));
    const k = nz / this.view.zoom;
    this.view.pan = { x: s.x - (s.x - this.view.pan.x) * k, y: s.y - (s.y - this.view.pan.y) * k };
    this.view.zoom = nz;
  }

  zoomReset(): void {
    this.zoomBy(1 / this.view.zoom);
  }

  /** Centre la vue sur un point de grille. */
  centerOn(p: Vec): void {
    const rect = this.canvas.getBoundingClientRect();
    const w = gridToWorld(p);
    this.view.pan = { x: rect.width / 2 - w.x * this.view.zoom, y: rect.height / 2 - w.y * this.view.zoom };
  }

  /** Centre sur la sélection, sinon sur le curseur clavier. */
  centerOnFocus(): void {
    const c = this.app.selectedComponent();
    if (c) this.centerOn(c.pos);
    else if (this.kcursor) this.centerOn(this.kcursor);
  }

  /** Point de grille au centre de la vue. */
  private centerGrid(): Vec {
    const rect = this.canvas.getBoundingClientRect();
    return worldToGrid(screenToWorld({ x: rect.width / 2, y: rect.height / 2 }, this.view));
  }

  // ---- Curseur clavier ----

  /** Curseur clavier, créé au centre de la vue s'il n'existe pas encore. */
  ensureCursor(): Vec {
    if (!this.kcursor) this.setCursor(this.centerGrid());
    return this.kcursor!;
  }

  setCursor(p: Vec): void {
    this.kcursor = { x: p.x, y: p.y };
    this.keepCursorVisible();
    this.updateCursorHit();
  }

  hideCursor(): void {
    this.kcursor = null;
    this.khit = null;
  }

  /** h j k l : déplace le curseur (ou la sélection en mode déplacement) de `step` pas de grille. */
  moveCursor(dx: number, dy: number): void {
    if (this.moveMode && this.app.selection) {
      this.app.nudgeSelection({ x: dx, y: dy });
      if (this.kcursor) this.setCursor({ x: this.kcursor.x + dx, y: this.kcursor.y + dy });
      return;
    }
    const c = this.ensureCursor();
    this.setCursor({ x: c.x + dx, y: c.y + dy });
  }

  private keepCursorVisible(): void {
    if (!this.kcursor) return;
    const rect = this.canvas.getBoundingClientRect();
    const s = worldToScreen(gridToWorld(this.kcursor), this.view);
    const m = 48;
    let dx = 0;
    let dy = 0;
    if (s.x < m) dx = m - s.x;
    else if (s.x > rect.width - m) dx = rect.width - m - s.x;
    if (s.y < m) dy = m - s.y;
    else if (s.y > rect.height - m - 28) dy = rect.height - m - 28 - s.y;
    this.view.pan = { x: this.view.pan.x + dx, y: this.view.pan.y + dy };
  }

  private updateCursorHit(): void {
    this.khit = this.kcursor ? hitTest(this.app, gridToWorld(this.kcursor), this.view.zoom) : null;
  }

  /** Élément sous le curseur clavier. */
  cursorHit(): Hit | null {
    return this.khit;
  }

  /** Composant visé par une commande : la sélection, sinon celui sous le curseur clavier. */
  targetComponentId(): string | null {
    const sel = this.app.selectedComponent();
    if (sel) return sel.id;
    if (this.khit?.kind === "component") return this.khit.id;
    if (this.khit?.kind === "terminal") return this.khit.compId;
    return null;
  }

  /** Entrée : sélectionne / modifie l'élément sous le curseur, ou termine le fil en cours. */
  activateCursor(): void {
    if (this.kwire) {
      this.finishKeyboardWire(false);
      return;
    }
    const h = this.khit;
    if (!h) {
      this.app.select(null);
      return;
    }
    if (h.kind === "terminal" || h.kind === "wireEnd") {
      this.startKeyboardWire();
      return;
    }
    if (h.kind === "wire") {
      this.app.selectWire(h.id);
      return;
    }
    const sel = this.app.selection;
    if (sel?.kind === "component" && sel.id === h.id) this.editSelected();
    else this.app.select({ kind: "component", id: h.id });
  }

  /** Donne le focus au champ principal du composant sélectionné (valeur). */
  editSelected(): void {
    if (!this.app.selectedComponent()) return;
    const field =
      document.querySelector<HTMLElement & { select?: () => void }>("#props md-outlined-text-field[data-main]") ??
      document.querySelector<HTMLElement & { select?: () => void }>("#props md-outlined-text-field");
    if (!field) return;
    field.focus();
    field.select?.();
  }

  /** x : supprime l'élément sous le curseur clavier, sinon la sélection. */
  deleteAtCursor(): void {
    const h = this.khit;
    if (h?.kind === "component") this.app.select({ kind: "component", id: h.id });
    else if (h?.kind === "wire") this.app.selectWire(h.id);
    else if (h?.kind === "wireEnd") this.app.selectWire(h.id);
    this.app.deleteSelection();
    this.updateCursorHit();
  }

  /** Tab : sélectionne le composant suivant (ordre de lecture) et y amène le curseur. */
  cycleSelection(dir: 1 | -1): void {
    const comps = [...this.app.circuit.components].sort((a, b) => a.pos.y - b.pos.y || a.pos.x - b.pos.x);
    if (comps.length === 0) return;
    const cur = this.app.selectedComponent();
    let idx = cur ? comps.findIndex((c) => c.id === cur.id) : -1;
    idx = (idx + dir + comps.length) % comps.length;
    const c = comps[idx];
    this.app.select({ kind: "component", id: c.id });
    this.setCursor(c.pos);
  }

  /** Pose un composant sous le curseur clavier (rotation du dernier composant posé au clavier conservée). */
  placeAtCursor(type: ComponentType): void {
    const p = this.ensureCursor();
    this.app.addComponent(type, p, 0);
    this.updateCursorHit();
  }

  pasteAtCursor(): boolean {
    const p = this.ensureCursor();
    const ok = this.app.paste(p);
    this.updateCursorHit();
    return ok;
  }

  toggleMoveMode(): void {
    if (!this.app.selection) {
      // Rien de sélectionné : on tente l'élément sous le curseur.
      const h = this.khit;
      if (h?.kind === "component") this.app.select({ kind: "component", id: h.id });
      else if (h?.kind === "wire") this.app.selectWire(h.id);
      else if (h?.kind === "wireEnd") this.app.selectWire(h.id);
    }
    this.moveMode = !this.moveMode && !!this.app.selection;
  }

  // ---- Fil au clavier ----

  /** w : commence un fil au curseur, ou termine le segment en cours et en enchaîne un nouveau. */
  startKeyboardWire(): void {
    const p = this.ensureCursor();
    if (!this.kwire) {
      this.kwire = { ...p };
      return;
    }
    this.finishKeyboardWire(true);
  }

  finishKeyboardWire(chain: boolean): void {
    if (!this.kwire) return;
    const p = this.ensureCursor();
    if (!samePoint(this.kwire, p)) this.app.addWire(this.kwire, p);
    this.kwire = chain ? { ...p } : null;
    this.updateCursorHit();
  }

  cancelKeyboardWire(): void {
    this.kwire = null;
  }

  isDrawingWire(): boolean {
    return this.kwire !== null || this.mode.kind === "drawWire";
  }

  /**
   * Échap : annule ce qui est en cours, du plus précis au plus général (placement, fil, mode déplacement,
   * outil fil, sélection, curseur clavier), et rend le focus au canevas.
   */
  escape(): void {
    this.keymap?.closePalette();
    if (this.mode.kind === "place" || this.mode.kind === "drawWire") this.cancel();
    else if (this.kwire) this.cancelKeyboardWire();
    else if (this.moveMode) this.moveMode = false;
    else if (this.tool === "wire") this.setTool("select");
    else if (this.app.selection) this.app.select(null);
    else this.hideCursor();
    this.focusCanvas();
    this.updateCursor();
  }

  /** Libellé du mode courant, façon vim. */
  modeLabel(): string {
    if (this.keymap?.isPaletteOpen()) return "COMMANDE";
    const active = document.activeElement;
    if (active instanceof HTMLElement && isEditableElement(active)) return "SAISIE";
    if (this.keymap?.pending.length) return `ATTENTE  ${this.keymap.pendingLabel}`;
    if (this.mode.kind === "place") return "POSER";
    if (this.kwire || this.mode.kind === "drawWire" || this.tool === "wire") return "FIL";
    if (this.moveMode) return "DÉPLACER";
    if (this.mode.kind === "moveComponent" || this.mode.kind === "moveWires" || this.mode.kind === "moveWireEnd") return "GLISSER";
    return "NORMAL";
  }

  // ---- Souris ----

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
    this.keymap?.cancel();
    this.keymap?.closePalette();
    const target = e.target as HTMLElement;
    target.focus?.({ preventScroll: true });
    const world = this.clientToWorld(e);
    const grid = worldToGrid(world);
    // Le curseur clavier suit les clics : « a r » pose ensuite une résistance à cet endroit.
    if (this.kcursor) this.setCursor(grid);

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
      if (sel?.kind === "wire" && sel.ids.includes(hit.id)) {
        // Fil déjà sélectionné : on déplace la jonction (Alt : seulement cette extrémité).
        this.mode = { kind: "moveWireEnd", id: hit.id, end: hit.end, base: cloneCircuit(this.app.circuit), last: hit.point, moved: false, group: !e.altKey };
      } else {
        this.mode = { kind: "drawWire", from: hit.point, to: hit.point };
      }
      return;
    }
    if (hit.kind === "component") {
      const c = this.app.componentById(hit.id)!;
      this.app.select({ kind: "component", id: c.id });
      this.mode = {
        kind: "moveComponent",
        id: c.id,
        grab: { x: world.x / G - c.pos.x, y: world.y / G - c.pos.y },
        base: cloneCircuit(this.app.circuit),
        last: { ...c.pos },
        moved: false,
      };
      return;
    }
    if (hit.kind === "wire") {
      // Clic : tout le chemin de fils reliés ; Alt+clic : ce seul segment.
      this.app.selectWire(hit.id, e.altKey);
      this.mode = {
        kind: "moveWires",
        ids: this.app.selectedWireIds(),
        grab: { x: world.x / G, y: world.y / G },
        base: cloneCircuit(this.app.circuit),
        last: { x: 0, y: 0 },
        moved: false,
        detach: e.altKey,
      };
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
        const np = { x: Math.round(world.x / G - m.grab.x), y: Math.round(world.y / G - m.grab.y) };
        if (samePoint(np, m.last)) break;
        if (!m.moved) {
          m.moved = true;
          this.app.snapshot();
        }
        m.last = np;
        this.app.preview(m.base, (c) => {
          const comp = c.components.find((x) => x.id === m.id);
          if (comp) relocateComponent(c, comp, np, comp.rot);
        });
        break;
      }
      case "moveWires": {
        const delta = { x: Math.round(world.x / G - m.grab.x), y: Math.round(world.y / G - m.grab.y) };
        if (samePoint(delta, m.last)) break;
        if (!m.moved) {
          m.moved = true;
          this.app.snapshot();
        }
        m.last = delta;
        this.app.preview(m.base, (c) => translateWires(c, m.ids, delta, { detach: m.detach }));
        break;
      }
      case "moveWireEnd": {
        if (samePoint(grid, m.last)) break;
        if (!m.moved) {
          m.moved = true;
          this.app.snapshot();
        }
        m.last = grid;
        this.app.preview(m.base, (c) => moveWireEnd(c, m.id, m.end, grid, { group: m.group }));
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
      case "moveWires":
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
    this.updateCursorHit();
    this.updateCursor();
  }

  private onDoubleClick(e: MouseEvent): void {
    const world = this.clientToWorld(e);
    const hit = hitTest(this.app, world, this.view.zoom);
    if (hit?.kind === "component") {
      this.app.select({ kind: "component", id: hit.id });
      this.editSelected();
    }
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    this.zoomBy(Math.exp(-e.deltaY * 0.0015), { x: e.clientX - rect.left, y: e.clientY - rect.top });
  }

  // ---- Clavier ----

  private onKey(e: KeyboardEvent): void {
    if (isEditableTarget(e)) return;
    // Espace / Entrée sur un bouton ayant le focus : c'est le bouton qui agit.
    if ((e.key === " " || e.key === "Enter") && isButtonTarget(e)) return;
    if (this.keymap?.handle(e)) {
      e.preventDefault();
      this.updateCursorHit();
      this.updateCursor();
      return;
    }
    // Rotation pendant un placement à la souris (le fantôme tourne).
    if ((e.key === "r" || e.key === "R") && this.mode.kind === "place") {
      this.mode.rot = ((this.mode.rot + (e.key === "r" ? 1 : 3)) % 4) as Rot;
      e.preventDefault();
    }
  }

  private updateCursor(): void {
    let cursor = "default";
    const m = this.mode;
    if (m.kind === "place") cursor = "copy";
    else if (m.kind === "pan") cursor = m.moved ? "grabbing" : "default";
    else if (m.kind === "drawWire") cursor = "crosshair";
    else if (m.kind === "moveComponent" || m.kind === "moveWires" || m.kind === "moveWireEnd") cursor = "move";
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
    if (this.lastLeft !== null && rect.left !== this.lastLeft) this.view.pan.x += this.lastLeft - rect.left;
    this.lastLeft = rect.left;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const m = this.mode;
    // Survol : la souris si elle est sur le canevas, sinon l'élément sous le curseur clavier.
    const mouseHover = m.kind === "idle" || m.kind === "drawWire" ? this.hover : null;
    if (this.kcursor && !mouseHover) this.updateCursorHit();
    const hover = mouseHover ?? (m.kind === "idle" ? this.khit : null);
    const cursor = mouseHover ? this.cursorWorld : this.kcursor ? gridToWorld(this.kcursor) : null;
    let wirePreview: Vec[] | null = null;
    if (m.kind === "drawWire") wirePreview = this.app.routeWire(m.from, m.to);
    else if (this.kwire && this.kcursor) wirePreview = this.app.routeWire(this.kwire, this.kcursor);
    this.renderer.draw(this.ctx, this.view, {
      width: rect.width,
      height: rect.height,
      hover,
      wirePreview,
      ghost: m.kind === "place" && m.pos ? { type: m.type, pos: m.pos, rot: m.rot } : null,
      frameDt: dt,
      cursor: m.kind === "idle" || m.kind === "drawWire" ? cursor : null,
      kcursor: this.kcursor,
      moveMode: this.moveMode,
    });
    const label = this.modeLabel();
    if (label !== this.lastModeLabel) {
      this.lastModeLabel = label;
      const el = document.getElementById("mode");
      if (el) {
        el.textContent = label;
        el.dataset.mode = label.split(" ")[0].toLowerCase();
      }
    }
    requestAnimationFrame((t) => this.frame(t));
  }
}
