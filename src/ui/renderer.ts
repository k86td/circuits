/** Rendu du circuit sur un canvas : symboles, fils, électrons, étiquettes. */

import {
  type Component,
  type ComponentType,
  type Rot,
  type Vec,
  DEFS,
  displayName,
  isDependentSource,
  mainValue,
  pointKey,
  rotateVec,
  samePoint,
  terminalPositions,
} from "../sim/model";
import { connectionDegrees } from "../sim/netlist";
import { evalValue, isTimeDependent } from "../sim/expr";
import { formatSI } from "../sim/units";
import type { App } from "./app";
import { type CanvasPalette, theme, withAlpha } from "./theme";

/** Pixels par unité de grille (zoom 1). */
export const G = 20;

export interface View {
  pan: Vec;
  zoom: number;
}

export type Hit =
  | { kind: "terminal"; point: Vec; compId: string }
  | { kind: "wireEnd"; id: string; end: "a" | "b"; point: Vec }
  | { kind: "component"; id: string }
  | { kind: "wire"; id: string };

export interface DrawExtra {
  width: number;
  height: number;
  hover: Hit | null;
  wirePreview: { a: Vec; b: Vec } | null;
  ghost: { type: ComponentType; pos: Vec; rot: Rot } | null;
  frameDt: number;
  /** Position du curseur en pixels-monde (pour l'infobulle). */
  cursor: Vec | null;
}

/** Couleurs du rendu, dérivées du thème Material courant (voir theme.ts). */
function COL(): CanvasPalette {
  return theme.canvas;
}

export function worldToScreen(p: Vec, view: View): Vec {
  return { x: p.x * view.zoom + view.pan.x, y: p.y * view.zoom + view.pan.y };
}

export function screenToWorld(p: Vec, view: View): Vec {
  return { x: (p.x - view.pan.x) / view.zoom, y: (p.y - view.pan.y) / view.zoom };
}

export function gridToWorld(p: Vec): Vec {
  return { x: p.x * G, y: p.y * G };
}

export function worldToGrid(p: Vec): Vec {
  return { x: Math.round(p.x / G), y: Math.round(p.y / G) };
}

/** Boîte englobante (pixels-monde) du corps d'un composant. */
export function componentBounds(c: Component): { x: number; y: number; w: number; h: number } {
  let hw = 40;
  let hh = 16;
  if (isDependentSource(c.type)) {
    hw = 40;
    hh = 30;
  } else if (c.type === "ground") {
    hw = 14;
    hh = 18;
  }
  if (c.rot % 2 === 1) [hw, hh] = [hh, hw];
  const cx = c.pos.x * G + (c.type === "ground" ? rotateVec({ x: 0, y: -3 }, c.rot).x : 0);
  const cy = c.pos.y * G + (c.type === "ground" ? rotateVec({ x: 0, y: -3 }, c.rot).y : 0);
  return { x: cx - hw, y: cy - hh, w: hw * 2, h: hh * 2 };
}

/** Chemins de conduction (pixels-monde) et courant associé. */
export function conductionPaths(c: Component, i: number, ic: number | undefined): { pts: Vec[]; i: number }[] {
  const T = terminalPositions(c).map(gridToWorld);
  if (T.length < 2) return [];
  if (T.length === 4) {
    const L = (p: Vec) => {
      const r = rotateVec(p, c.rot);
      return { x: c.pos.x * G + r.x, y: c.pos.y * G + r.y };
    };
    return [
      { pts: [T[0], L({ x: 20, y: -20 }), L({ x: 20, y: 20 }), T[1]], i },
      { pts: [T[2], L({ x: -20, y: -20 }), L({ x: -20, y: 20 }), T[3]], i: ic ?? 0 },
    ];
  }
  return [{ pts: [T[0], T[1]], i }];
}

function distToSegment(p: Vec, a: Vec, b: Vec): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  let t = l2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Test de collision en pixels-monde. */
export function hitTest(app: App, p: Vec, zoom: number): Hit | null {
  const r = 9 / zoom;
  for (const c of app.circuit.components) {
    const tps = terminalPositions(c);
    for (const t of tps) {
      const w = gridToWorld(t);
      if (Math.hypot(w.x - p.x, w.y - p.y) <= r) return { kind: "terminal", point: t, compId: c.id };
    }
  }
  for (const w of app.circuit.wires) {
    for (const end of ["a", "b"] as const) {
      const q = gridToWorld(w[end]);
      if (Math.hypot(q.x - p.x, q.y - p.y) <= r) return { kind: "wireEnd", id: w.id, end, point: w[end] };
    }
  }
  for (let k = app.circuit.components.length - 1; k >= 0; k--) {
    const c = app.circuit.components[k];
    const b = componentBounds(c);
    if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) return { kind: "component", id: c.id };
  }
  for (const w of app.circuit.wires) {
    if (distToSegment(p, gridToWorld(w.a), gridToWorld(w.b)) <= 6 / zoom) return { kind: "wire", id: w.id };
  }
  return null;
}

function voltageColor(v: number, vmax: number): string {
  const x = Math.max(-1, Math.min(1, v / vmax));
  const pal = COL();
  if (x >= 0) {
    return mix(pal.voltageNeutral, pal.voltagePos, x);
  }
  return mix(pal.voltageNeutral, pal.voltageNeg, -x);
}

function mix(a: string, b: string, t: number): string {
  const pa = hex(a);
  const pb = hex(b);
  const c = pa.map((v, k) => Math.round(v + (pb[k] - v) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function hex(h: string): number[] {
  return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
}

/** Dessine le symbole d'un composant en coordonnées locales (rotation appliquée par l'appelant). */
export function drawSymbol(
  ctx: CanvasRenderingContext2D,
  c: Component,
  opts: { leadColors?: string[]; glow?: number; scale?: number } = {},
): void {
  const lc = opts.leadColors ?? [COL().wire, COL().wire, COL().wire, COL().wire];
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = COL().body;
  ctx.fillStyle = COL().body;
  const lead = (x1: number, y1: number, x2: number, y2: number, color: string) => {
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.strokeStyle = COL().body;
  };
  switch (c.type) {
    case "resistor":
      lead(-40, 0, -20, 0, lc[0]);
      lead(20, 0, 40, 0, lc[1]);
      ctx.beginPath();
      ctx.moveTo(-20, 0);
      for (let k = 0; k < 6; k++) {
        const x = -20 + (k + 0.5) * (40 / 6);
        ctx.lineTo(x, k % 2 === 0 ? -7 : 7);
      }
      ctx.lineTo(20, 0);
      ctx.stroke();
      break;
    case "lamp": {
      lead(-40, 0, -12, 0, lc[0]);
      lead(12, 0, 40, 0, lc[1]);
      const g = opts.glow ?? 0;
      if (g > 0.02) {
        const grad = ctx.createRadialGradient(0, 0, 4, 0, 0, 14 + 24 * g);
        grad.addColorStop(0, `rgba(253,224,71,${0.9 * Math.min(1, g)})`);
        grad.addColorStop(1, "rgba(253,224,71,0)");
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(0, 0, 14 + 24 * g, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = g > 0.02 ? `rgba(254,240,138,${Math.min(1, g)})` : "rgba(0,0,0,0)";
      ctx.beginPath();
      ctx.arc(0, 0, 12, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-8, -8);
      ctx.lineTo(8, 8);
      ctx.moveTo(8, -8);
      ctx.lineTo(-8, 8);
      ctx.stroke();
      break;
    }
    case "capacitor":
      lead(-40, 0, -4, 0, lc[0]);
      lead(4, 0, 40, 0, lc[1]);
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(-4, -13);
      ctx.lineTo(-4, 13);
      ctx.moveTo(4, -13);
      ctx.lineTo(4, 13);
      ctx.stroke();
      break;
    case "inductor":
      lead(-40, 0, -28, 0, lc[0]);
      lead(28, 0, 40, 0, lc[1]);
      ctx.beginPath();
      for (let k = 0; k < 4; k++) {
        ctx.arc(-21 + k * 14, 0, 7, Math.PI, 0, false);
      }
      ctx.stroke();
      break;
    case "battery":
      lead(-40, 0, -5, 0, lc[0]);
      lead(5, 0, 40, 0, lc[1]);
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(-5, -14);
      ctx.lineTo(-5, 14);
      ctx.stroke();
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(5, -7);
      ctx.lineTo(5, 7);
      ctx.stroke();
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(-16, -14);
      ctx.lineTo(-10, -14);
      ctx.moveTo(-13, -17);
      ctx.lineTo(-13, -11);
      ctx.stroke();
      break;
    case "acsource":
    case "vfunc":
    case "currentsource":
    case "ifunc":
    case "voltmeter":
    case "ammeter": {
      lead(-40, 0, -14, 0, lc[0]);
      lead(14, 0, 40, 0, lc[1]);
      ctx.fillStyle = COL().bg;
      ctx.beginPath();
      ctx.arc(0, 0, 14, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = COL().body;
      if (c.type === "acsource") {
        ctx.beginPath();
        for (let k = 0; k <= 20; k++) {
          const x = -9 + (18 * k) / 20;
          const y = -6 * Math.sin((k / 20) * Math.PI * 2);
          if (k === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
        plus(ctx, -22, -10);
      } else if (c.type === "vfunc") {
        text(ctx, "v(t)", 0, 0, 10, c.rot);
        plus(ctx, -22, -10);
      } else if (c.type === "currentsource" || c.type === "ifunc") {
        ctx.beginPath();
        ctx.moveTo(-8, 0);
        ctx.lineTo(8, 0);
        ctx.moveTo(3, -5);
        ctx.lineTo(8, 0);
        ctx.lineTo(3, 5);
        ctx.stroke();
        if (c.type === "ifunc") text(ctx, "i(t)", 0, -20, 9, c.rot);
      } else if (c.type === "voltmeter") {
        text(ctx, "V", 0, 0, 13, c.rot);
        plus(ctx, -22, -10);
      } else {
        text(ctx, "A", 0, 0, 13, c.rot);
        plus(ctx, -22, -10);
      }
      break;
    }
    case "diode":
    case "led": {
      lead(-40, 0, -10, 0, lc[0]);
      lead(10, 0, 40, 0, lc[1]);
      const g = opts.glow ?? 0;
      if (c.type === "led" && g > 0.02) {
        const grad = ctx.createRadialGradient(0, 0, 2, 0, 0, 12 + 26 * g);
        grad.addColorStop(0, `rgba(248,113,113,${0.9 * Math.min(1, g)})`);
        grad.addColorStop(1, "rgba(248,113,113,0)");
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(0, 0, 12 + 26 * g, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = c.type === "led" ? (g > 0.02 ? "#fca5a5" : "#7f1d1d") : COL().body;
      ctx.beginPath();
      ctx.moveTo(-10, -10);
      ctx.lineTo(10, 0);
      ctx.lineTo(-10, 10);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(10, -10);
      ctx.lineTo(10, 10);
      ctx.stroke();
      if (c.type === "led") {
        ctx.lineWidth = 1.5;
        for (const dy of [-11, -17]) {
          ctx.beginPath();
          ctx.moveTo(2, dy + 2);
          ctx.lineTo(9, dy - 5);
          ctx.moveTo(9, dy - 5);
          ctx.lineTo(5, dy - 5);
          ctx.moveTo(9, dy - 5);
          ctx.lineTo(9, dy - 1);
          ctx.stroke();
        }
      }
      break;
    }
    case "switch": {
      lead(-40, 0, -20, 0, lc[0]);
      lead(20, 0, 40, 0, lc[1]);
      ctx.beginPath();
      ctx.arc(-20, 0, 2.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(20, 0, 2.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-20, 0);
      if (c.closed) ctx.lineTo(20, 0);
      else ctx.lineTo(16, -14);
      ctx.stroke();
      break;
    }
    case "ground":
      lead(0, -20, 0, 0, lc[0]);
      ctx.beginPath();
      ctx.moveTo(-12, 0);
      ctx.lineTo(12, 0);
      ctx.moveTo(-8, 5);
      ctx.lineTo(8, 5);
      ctx.moveTo(-4, 10);
      ctx.lineTo(4, 10);
      ctx.stroke();
      break;
    case "vcvs":
    case "vccs":
    case "ccvs":
    case "cccs": {
      // commande à gauche, sortie (losange) à droite
      lead(-40, -20, -20, -20, lc[2]);
      lead(-40, 20, -20, 20, lc[3]);
      const cc = c.type === "ccvs" || c.type === "cccs";
      if (cc) {
        lead(-20, -20, -20, 20, lc[2]);
        ctx.beginPath();
        ctx.moveTo(-24, 6);
        ctx.lineTo(-20, 12);
        ctx.lineTo(-16, 6);
        ctx.stroke();
      } else {
        lead(-20, -20, -20, -12, lc[2]);
        lead(-20, 20, -20, 12, lc[3]);
        plus(ctx, -20, -6);
        ctx.beginPath();
        ctx.moveTo(-23, 6);
        ctx.lineTo(-17, 6);
        ctx.stroke();
      }
      lead(40, -20, 20, -20, lc[0]);
      lead(20, -20, 20, -16, lc[0]);
      lead(40, 20, 20, 20, lc[1]);
      lead(20, 20, 20, 16, lc[1]);
      ctx.fillStyle = COL().bg;
      ctx.beginPath();
      ctx.moveTo(20, -16);
      ctx.lineTo(36, 0);
      ctx.lineTo(20, 16);
      ctx.lineTo(4, 0);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = COL().body;
      if (c.type === "vcvs" || c.type === "ccvs") {
        plus(ctx, 20, -8);
        ctx.beginPath();
        ctx.moveTo(17, 8);
        ctx.lineTo(23, 8);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.moveTo(20, 8);
        ctx.lineTo(20, -8);
        ctx.moveTo(16, -3);
        ctx.lineTo(20, -8);
        ctx.lineTo(24, -3);
        ctx.stroke();
      }
      ctx.lineWidth = 1;
      ctx.strokeStyle = withAlpha(COL().body, 0.5);
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(-14, 0);
      ctx.lineTo(2, 0);
      ctx.stroke();
      ctx.setLineDash([]);
      break;
    }
  }
}

function plus(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x - 3, y);
  ctx.lineTo(x + 3, y);
  ctx.moveTo(x, y - 3);
  ctx.lineTo(x, y + 3);
  ctx.stroke();
  ctx.lineWidth = 2;
}

function text(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, size: number, rot: Rot): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate((-rot * Math.PI) / 2);
  ctx.font = `bold ${size}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(s, 0, 1);
  ctx.restore();
}

/** Icône de palette. */
export function drawIcon(canvas: HTMLCanvasElement, type: ComponentType): void {
  const dpr = window.devicePixelRatio || 1;
  const w = 88;
  const h = 44;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);
  ctx.translate(w / 2, h / 2 + (type === "ground" ? 4 : 0));
  const s = isDependentSource(type) ? 0.62 : 0.9;
  ctx.scale(s, s);
  const c: Component = { id: "icon", type, pos: { x: 0, y: 0 }, rot: 0, props: {}, closed: false };
  drawSymbol(ctx, c, { glow: 0 });
}

export class Renderer {
  private phases = new Map<string, number>();

  constructor(private app: App) {}

  draw(ctx: CanvasRenderingContext2D, view: View, extra: DrawExtra): void {
    const app = this.app;
    const { width, height } = extra;
    ctx.save();
    ctx.fillStyle = COL().bg;
    ctx.fillRect(0, 0, width, height);
    this.drawGrid(ctx, view, width, height);

    ctx.translate(view.pan.x, view.pan.y);
    ctx.scale(view.zoom, view.zoom);

    const sim = app.sim;
    const vmax = Math.max(1e-3, ...Array.from(sim.nodeVoltages).map(Math.abs));
    const colorOfPoint = (p: Vec): string => {
      if (!app.options.voltageColors || sim.error) return COL().wire;
      const v = sim.voltageAt(pointKey(p));
      return v === null ? COL().wire : voltageColor(v, vmax);
    };

    // Fils
    const sel = app.selection;
    for (const w of app.circuit.wires) {
      const a = gridToWorld(w.a);
      const b = gridToWorld(w.b);
      const isSel = sel?.kind === "wire" && sel.id === w.id;
      const isHov = extra.hover?.kind === "wire" && extra.hover.id === w.id;
      if (isSel || isHov) {
        ctx.strokeStyle = isSel ? COL().select : COL().hover;
        ctx.lineWidth = 10;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      ctx.strokeStyle = colorOfPoint(w.a);
      ctx.lineWidth = 2.5;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    // Jonctions
    const deg = connectionDegrees(app.circuit);
    for (const [key, d] of deg) {
      if (d < 3) continue;
      const [x, y] = key.split(",").map(Number);
      ctx.fillStyle = colorOfPoint({ x, y });
      ctx.beginPath();
      ctx.arc(x * G, y * G, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Composants
    for (const c of app.circuit.components) {
      const isSel = sel?.kind === "component" && sel.id === c.id;
      const isHov = extra.hover?.kind === "component" && extra.hover.id === c.id;
      if (isSel || isHov) {
        const b = componentBounds(c);
        ctx.fillStyle = isSel ? COL().select : COL().hover;
        roundRect(ctx, b.x - 4, b.y - 4, b.w + 8, b.h + 8, 8);
        ctx.fill();
      }
      const res = sim.results.get(c.id);
      let glow = 0;
      if (res && !sim.error) {
        if (c.type === "lamp") glow = Math.max(0, res.p) / Math.max(1e-9, evalValue(c.props.Pnom, sim.time));
        else if (c.type === "led") glow = Math.max(0, res.i) / Math.max(1e-9, evalValue(c.props.Inom, sim.time));
      }
      const tps = terminalPositions(c);
      ctx.save();
      ctx.translate(c.pos.x * G, c.pos.y * G);
      ctx.rotate((c.rot * Math.PI) / 2);
      drawSymbol(ctx, c, { leadColors: tps.map(colorOfPoint), glow });
      ctx.restore();

      // Terminaux non connectés : petit cercle
      for (const t of tps) {
        if ((deg.get(pointKey(t)) ?? 0) <= 1) {
          const w = gridToWorld(t);
          ctx.strokeStyle = COL().unconnected;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(w.x, w.y, 3.5, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }

    // Électrons
    if (app.options.electrons && !sim.error) this.drawElectrons(ctx, extra.frameDt);

    // Flèches du sens conventionnel du courant
    if (app.options.currentArrows && !sim.error) this.drawCurrentArrows(ctx);

    // Étiquettes
    this.drawLabels(ctx, view.zoom);

    // Terminal survolé
    if (extra.hover && (extra.hover.kind === "terminal" || extra.hover.kind === "wireEnd")) {
      const w = gridToWorld(extra.hover.point);
      ctx.fillStyle = withAlpha(COL().electron, 0.9);
      ctx.beginPath();
      ctx.arc(w.x, w.y, 5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Aperçu de fil
    if (extra.wirePreview) {
      const { a, b } = extra.wirePreview;
      const pts = a.x !== b.x && a.y !== b.y ? [a, { x: b.x, y: a.y }, b] : [a, b];
      ctx.strokeStyle = withAlpha(COL().electron, 0.9);
      ctx.lineWidth = 2.5;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      pts.forEach((p, k) => {
        const w = gridToWorld(p);
        if (k === 0) ctx.moveTo(w.x, w.y);
        else ctx.lineTo(w.x, w.y);
      });
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Fantôme (placement)
    if (extra.ghost) {
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.translate(extra.ghost.pos.x * G, extra.ghost.pos.y * G);
      ctx.rotate((extra.ghost.rot * Math.PI) / 2);
      const c: Component = { id: "ghost", type: extra.ghost.type, pos: { x: 0, y: 0 }, rot: extra.ghost.rot, props: {}, closed: false };
      drawSymbol(ctx, c);
      ctx.restore();
    }

    ctx.restore();

    // Infobulle (en pixels écran)
    if (extra.hover && extra.cursor) this.drawTooltip(ctx, view, extra);
  }

  private drawGrid(ctx: CanvasRenderingContext2D, view: View, width: number, height: number): void {
    const step = G * view.zoom;
    if (step < 6) return;
    const every = step < 12 ? 5 : 1;
    ctx.fillStyle = COL().grid;
    const startX = Math.floor(-view.pan.x / (step * every)) * every;
    const startY = Math.floor(-view.pan.y / (step * every)) * every;
    const endX = startX + Math.ceil(width / step) + every;
    const endY = startY + Math.ceil(height / step) + every;
    for (let gx = startX; gx <= endX; gx += every) {
      for (let gy = startY; gy <= endY; gy += every) {
        const x = gx * step + view.pan.x;
        const y = gy * step + view.pan.y;
        ctx.fillRect(x - 0.75, y - 0.75, 1.5, 1.5);
      }
    }
  }

  /** Chemins parcourus par le courant (fils et composants), avec le courant conventionnel orienté le long des points. */
  private currentPaths(): { key: string; pts: Vec[]; i: number }[] {
    const app = this.app;
    const paths: { key: string; pts: Vec[]; i: number }[] = [];
    for (const w of app.circuit.wires) {
      paths.push({ key: w.id, pts: [gridToWorld(w.a), gridToWorld(w.b)], i: app.sim.wireCurrents.get(w.id) ?? 0 });
    }
    for (const c of app.circuit.components) {
      const r = app.sim.results.get(c.id);
      if (!r) continue;
      conductionPaths(c, r.i, r.ic).forEach((p, k) => paths.push({ key: `${c.id}#${k}`, pts: p.pts, i: p.i }));
    }
    return paths;
  }

  /**
   * Flèches du sens conventionnel du courant (+ → −) : une par ~90 px sur les fils (les fils alignés bout à bout
   * sont regroupés pour ne pas multiplier les flèches sur les petits segments), une sur la patte de chaque composant.
   */
  private drawCurrentArrows(ctx: CanvasRenderingContext2D): void {
    const app = this.app;
    const threshold = Math.max(1e-12, app.options.iRef) * 1e-4;
    const size = 9;
    ctx.fillStyle = COL().arrow;
    ctx.strokeStyle = COL().bg;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";
    const arrow = (cx: number, cy: number, ux: number, uy: number) => {
      ctx.beginPath();
      ctx.moveTo(cx + ux * size * 0.6, cy + uy * size * 0.6);
      ctx.lineTo(cx - ux * size * 0.4 - uy * size * 0.5, cy - uy * size * 0.4 + ux * size * 0.5);
      ctx.lineTo(cx - ux * size * 0.4 + uy * size * 0.5, cy - uy * size * 0.4 - ux * size * 0.5);
      ctx.closePath();
      ctx.stroke();
      ctx.fill();
    };

    // Fils : regroupement des segments alignés reliés par un simple point de passage (degré 2).
    const deg = connectionDegrees(app.circuit);
    const atPoint = new Map<string, typeof app.circuit.wires>();
    for (const w of app.circuit.wires) {
      for (const p of [w.a, w.b]) {
        const k = pointKey(p);
        if (!atPoint.has(k)) atPoint.set(k, []);
        atPoint.get(k)!.push(w);
      }
    }
    const dirOf = (a: Vec, b: Vec) => ({ x: Math.sign(b.x - a.x), y: Math.sign(b.y - a.y) });
    const visited = new Set<string>();
    for (const w of app.circuit.wires) {
      if (visited.has(w.id)) continue;
      visited.add(w.id);
      const i = app.sim.wireCurrents.get(w.id) ?? 0;
      if (Math.abs(i) < threshold) continue;
      // Orientation du chemin : de `from` vers `to` dans le sens du courant conventionnel.
      let from = i > 0 ? w.a : w.b;
      let to = i > 0 ? w.b : w.a;
      const d = dirOf(from, to);
      // Prolonge dans les deux sens tant que le fil suivant est aligné et seul au point de jonction.
      const extend = (p: Vec, forward: boolean): Vec => {
        for (;;) {
          if ((deg.get(pointKey(p)) ?? 0) !== 2) return p;
          const next = (atPoint.get(pointKey(p)) ?? []).find((x) => !visited.has(x.id));
          if (!next) return p;
          const far = samePoint(next.a, p) ? next.b : next.a;
          const nd = forward ? dirOf(p, far) : dirOf(far, p);
          if (nd.x !== d.x || nd.y !== d.y) return p;
          visited.add(next.id);
          p = far;
        }
      };
      to = extend(to, true);
      from = extend(from, false);
      const a = gridToWorld(from);
      const b = gridToWorld(to);
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 24) continue;
      const n = Math.max(1, Math.round(len / 90));
      for (let j = 1; j <= n; j++) {
        const t = j / (n + 1);
        arrow(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, d.x, d.y);
      }
    }

    // Composants : une flèche sur la première patte (hors du symbole).
    for (const c of app.circuit.components) {
      const r = app.sim.results.get(c.id);
      if (!r) continue;
      for (const path of conductionPaths(c, r.i, r.ic)) {
        if (Math.abs(path.i) < threshold) continue;
        const a = path.pts[0];
        const b = path.pts[1];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        if (len < 1) continue;
        const sign = Math.sign(path.i);
        const t = path.pts.length === 2 ? 0.15 : 0.5;
        arrow(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, ((b.x - a.x) / len) * sign, ((b.y - a.y) / len) * sign);
      }
    }
  }

  private drawElectrons(ctx: CanvasRenderingContext2D, frameDt: number): void {
    const app = this.app;
    const spacing = 14;
    // Vitesse des électrons : échelle logarithmique plafonnée. Le courant de référence iRef
    // donne ~60 % de la vitesse maximale ; iRef/1000 donne un lent défilement ; 100·iRef et plus : plafond.
    // Un vrai courant ferait défiler les points trop vite pour l'œil : on compresse volontairement.
    const vmax = 130; // px/s au plafond (≈ 2 px par image à 60 Hz : mouvement fluide, sans stroboscope)
    const iRef = Math.max(1e-12, app.options.iRef);
    const speedOf = (i: number) => {
      const x = Math.abs(i) / iRef;
      if (x < 1e-4) return 0;
      const f = 0.06 + 0.94 * ((Math.log10(x) + 3) / 5);
      return vmax * Math.min(1, Math.max(0.06, f));
    };
    // Déplacement maximal par image, pour qu'un point ne saute jamais plus du tiers de l'espacement
    const maxStep = spacing * 0.35;
    const paths = this.currentPaths();
    const color = app.options.conventional ? COL().electronConv : COL().electron;
    ctx.fillStyle = color;
    const alive = new Set<string>();
    for (const p of paths) {
      alive.add(p.key);
      const segs: { a: Vec; b: Vec; len: number }[] = [];
      let total = 0;
      for (let k = 0; k + 1 < p.pts.length; k++) {
        const len = Math.hypot(p.pts[k + 1].x - p.pts[k].x, p.pts[k + 1].y - p.pts[k].y);
        segs.push({ a: p.pts[k], b: p.pts[k + 1], len });
        total += len;
      }
      if (total < 1) continue;
      const dir = app.options.conventional ? 1 : -1;
      let phase = this.phases.get(p.key) ?? 0;
      if (app.running) phase += dir * Math.sign(p.i) * Math.min(maxStep, speedOf(p.i) * frameDt);
      phase = ((phase % spacing) + spacing) % spacing;
      this.phases.set(p.key, phase);
      const moving = Math.abs(p.i) > iRef * 1e-4;
      ctx.globalAlpha = moving ? 0.95 : 0.25;
      for (let s = phase; s < total; s += spacing) {
        let rem = s;
        for (const seg of segs) {
          if (rem <= seg.len) {
            const t = seg.len === 0 ? 0 : rem / seg.len;
            const x = seg.a.x + (seg.b.x - seg.a.x) * t;
            const y = seg.a.y + (seg.b.y - seg.a.y) * t;
            ctx.beginPath();
            ctx.arc(x, y, 2.6, 0, Math.PI * 2);
            ctx.fill();
            break;
          }
          rem -= seg.len;
        }
      }
    }
    ctx.globalAlpha = 1;
    for (const k of [...this.phases.keys()]) if (!alive.has(k)) this.phases.delete(k);
  }

  private drawLabels(ctx: CanvasRenderingContext2D, zoom: number): void {
    const app = this.app;
    if (zoom < 0.45) return;
    const sim = app.sim;
    ctx.font = "11px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    for (const c of app.circuit.components) {
      const lines: { text: string; color: string }[] = [];
      const res = sim.results.get(c.id);
      const name = displayName(c);
      if (app.options.showValues) {
        const mv = mainValue(c);
        if (mv) {
          let vt: string;
          if (typeof mv.value === "string") vt = isTimeDependent(mv.value) ? `${mv.value}` : formatSI(evalValue(mv.value, sim.time), mv.unit);
          else vt = formatSI(mv.value, mv.unit);
          if (vt.length > 22) vt = `${vt.slice(0, 20)}…`;
          lines.push({ text: `${name}  ${vt}`, color: COL().label });
        } else lines.push({ text: name, color: COL().label });
      }
      if (res && !sim.error) {
        if (c.type === "voltmeter") lines.push({ text: formatSI(res.v, "V"), color: COL().meter });
        else if (c.type === "ammeter") lines.push({ text: formatSI(res.i, "A"), color: COL().meter });
        else if (app.options.showReadings && c.type !== "ground") {
          const parts = [formatSI(res.v, "V"), formatSI(res.i, "A")];
          if (c.type !== "switch") parts.push(formatSI(res.p, "W"));
          lines.push({ text: parts.join("  "), color: COL().reading });
        }
      }
      if (lines.length === 0) continue;
      const b = componentBounds(c);
      const dep = isDependentSource(c.type);
      const horizontal = c.rot % 2 === 0 && !dep && c.type !== "ground";
      if (horizontal) {
        // valeur au-dessus, mesures en dessous
        const x = b.x + b.w / 2;
        ctx.textAlign = "center";
        const above = lines.filter((l) => l.color === COL().label);
        const below = lines.filter((l) => l.color !== COL().label);
        above.forEach((l, k) => {
          ctx.fillStyle = l.color;
          ctx.fillText(l.text, x, b.y - 8 - (above.length - 1 - k) * 13);
        });
        below.forEach((l, k) => {
          ctx.fillStyle = l.color;
          ctx.fillText(l.text, x, b.y + b.h + 9 + k * 13);
        });
        continue;
      }
      let x: number;
      let y: number;
      let align: CanvasTextAlign;
      if (c.type === "ground") {
        x = b.x + b.w / 2;
        y = b.y + b.h + 9;
        align = "center";
      } else if (dep) {
        x = b.x + b.w / 2;
        y = b.y + b.h + 9;
        align = "center";
      } else {
        x = b.x + b.w + 6;
        y = b.y + b.h / 2 - ((lines.length - 1) * 13) / 2;
        align = "left";
      }
      ctx.textAlign = align;
      lines.forEach((l, k) => {
        ctx.fillStyle = l.color;
        ctx.fillText(l.text, x, y + k * 13);
      });
    }
  }

  private drawTooltip(ctx: CanvasRenderingContext2D, view: View, extra: DrawExtra): void {
    const app = this.app;
    const h = extra.hover!;
    let text = "";
    if (h.kind === "terminal" || h.kind === "wireEnd") {
      const v = app.voltageAtPoint(h.point);
      if (v !== null && !app.sim.error) text = `V = ${formatSI(v, "V")}`;
      if (h.kind === "terminal") {
        const c = app.componentById(h.compId);
        if (c) {
          const names = DEFS[c.type].terminalNames;
          const idx = terminalPositions(c).findIndex((t) => pointKey(t) === pointKey(h.point));
          const tn = names?.[idx];
          text = `${displayName(c)}${tn ? ` (${tn})` : ""}  ${text}`;
        }
      }
    } else if (h.kind === "wire") {
      const w = app.circuit.wires.find((x) => x.id === h.id);
      if (w) {
        const v = app.voltageAtPoint(w.a);
        const i = app.sim.wireCurrents.get(w.id) ?? 0;
        if (v !== null && !app.sim.error) text = `V = ${formatSI(v, "V")}   I = ${formatSI(Math.abs(i), "A")}`;
      }
    } else if (h.kind === "component") {
      const c = app.componentById(h.id);
      const r = app.sim.results.get(h.id);
      if (c && r && !app.sim.error && c.type !== "ground") {
        text = `${displayName(c)} : V = ${formatSI(r.v, "V")}   I = ${formatSI(r.i, "A")}   P = ${formatSI(r.p, "W")}`;
        if (r.vc !== undefined && r.ic !== undefined)
          text += `   commande : ${formatSI(r.vc, "V")} / ${formatSI(r.ic, "A")}`;
      }
    }
    if (!text) return;
    const p = extra.cursor!;
    const s = worldToScreen(p, view);
    ctx.font = "12px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    const tw = ctx.measureText(text).width;
    let x = s.x + 14;
    const y = s.y + 18;
    if (x + tw + 12 > extra.width) x = extra.width - tw - 12;
    ctx.fillStyle = COL().tooltipBg;
    ctx.strokeStyle = COL().tooltipBorder;
    ctx.lineWidth = 1;
    roundRect(ctx, x - 6, y - 10, tw + 12, 20, 5);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = COL().tooltipText;
    ctx.fillText(text, x, y);
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
