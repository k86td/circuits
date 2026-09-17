/** Oscilloscope : traces de V, I, P, R en fonction du temps. */

import { type Circuit, displayName } from "../sim/model";
import type { ComponentResult } from "../sim/solver";
import { formatSI } from "../sim/units";

export type Quantity = "v" | "i" | "p" | "r";

export const QUANTITY_INFO: Record<Quantity, { label: string; unit: string; long: string }> = {
  v: { label: "V", unit: "V", long: "Tension" },
  i: { label: "I", unit: "A", long: "Courant" },
  p: { label: "P", unit: "W", long: "Puissance" },
  r: { label: "R", unit: "Ω", long: "Résistance (V/I)" },
};

const COLORS = ["#facc15", "#22d3ee", "#f472b6", "#4ade80", "#fb923c", "#a78bfa", "#f87171", "#2dd4bf"];

export interface Trace {
  key: string;
  compId: string;
  q: Quantity;
  color: string;
  t: Float64Array;
  y: Float64Array;
  n: number;
  head: number;
}

export const WINDOWS: number[] = [1e-3, 5e-3, 10e-3, 20e-3, 50e-3, 0.1, 0.2, 0.5, 1, 2, 5, 10, 30];

export class Scope {
  traces: Trace[] = [];
  /** Largeur de la fenêtre affichée (s). */
  window = 0.1;
  capacity = 6000;
  private lastSample = -Infinity;

  has(compId: string, q: Quantity): boolean {
    return this.traces.some((t) => t.compId === compId && t.q === q);
  }

  toggle(compId: string, q: Quantity): void {
    const idx = this.traces.findIndex((t) => t.compId === compId && t.q === q);
    if (idx >= 0) {
      this.traces.splice(idx, 1);
      return;
    }
    const used = new Set(this.traces.map((t) => t.color));
    const color = COLORS.find((c) => !used.has(c)) ?? COLORS[this.traces.length % COLORS.length];
    this.traces.push({
      key: `${compId}:${q}`,
      compId,
      q,
      color,
      t: new Float64Array(this.capacity),
      y: new Float64Array(this.capacity),
      n: 0,
      head: 0,
    });
  }

  remove(key: string): void {
    this.traces = this.traces.filter((t) => t.key !== key);
  }

  /** Retire les traces des composants disparus. */
  prune(circuit: Circuit): void {
    const ids = new Set(circuit.components.map((c) => c.id));
    this.traces = this.traces.filter((t) => ids.has(t.compId));
  }

  clearSamples(): void {
    for (const t of this.traces) {
      t.n = 0;
      t.head = 0;
    }
    this.lastSample = -Infinity;
  }

  private get interval(): number {
    return this.window / 1500;
  }

  sample(time: number, results: Map<string, ComponentResult>, force = false): void {
    if (this.traces.length === 0) return;
    if (time < this.lastSample) this.clearSamples();
    if (!force && time - this.lastSample < this.interval) return;
    this.lastSample = time;
    for (const tr of this.traces) {
      const r = results.get(tr.compId);
      let v = NaN;
      if (r) {
        if (tr.q === "v") v = r.v;
        else if (tr.q === "i") v = r.i;
        else if (tr.q === "p") v = r.p;
        else v = Math.abs(r.i) > 1e-12 ? r.v / r.i : NaN;
      }
      tr.t[tr.head] = time;
      tr.y[tr.head] = v;
      tr.head = (tr.head + 1) % this.capacity;
      if (tr.n < this.capacity) tr.n++;
    }
  }

  draw(ctx: CanvasRenderingContext2D, w: number, h: number, circuit: Circuit, now: number): void {
    ctx.clearRect(0, 0, w, h);
    const padL = 64;
    const padR = 64;
    const padT = 10;
    const padB = 22;
    const pw = w - padL - padR;
    const ph = h - padT - padB;
    if (pw <= 10 || ph <= 10) return;
    const t1 = Math.max(now, this.window);
    const t0 = t1 - this.window;

    // Fond + grille
    ctx.fillStyle = "#0b1020";
    ctx.fillRect(padL, padT, pw, ph);
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    for (let k = 0; k <= 10; k++) {
      const x = padL + (pw * k) / 10;
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + ph);
      ctx.stroke();
    }
    for (let k = 0; k <= 8; k++) {
      const y = padT + (ph * k) / 8;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + pw, y);
      ctx.stroke();
    }
    ctx.fillStyle = "#94a3b8";
    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (let k = 0; k <= 10; k += 2) {
      const x = padL + (pw * k) / 10;
      ctx.fillText(formatSI(t0 + (this.window * k) / 10, "s", 3), x, padT + ph + 4);
    }

    if (this.traces.length === 0) {
      ctx.fillStyle = "#64748b";
      ctx.font = "13px system-ui, sans-serif";
      ctx.textBaseline = "middle";
      ctx.fillText("Sélectionnez un composant puis cochez V, I, P ou R pour tracer une courbe.", padL + pw / 2, padT + ph / 2);
      return;
    }

    // Échelle par unité : max |y| dans la fenêtre
    const scaleByUnit = new Map<string, number>();
    const compById = new Map(circuit.components.map((c) => [c.id, c]));
    for (const tr of this.traces) {
      const unit = QUANTITY_INFO[tr.q].unit;
      let m = scaleByUnit.get(unit) ?? 0;
      for (let k = 0; k < tr.n; k++) {
        const idx = (tr.head - tr.n + k + this.capacity) % this.capacity;
        if (tr.t[idx] < t0) continue;
        const y = Math.abs(tr.y[idx]);
        if (Number.isFinite(y) && y > m) m = y;
      }
      scaleByUnit.set(unit, m);
    }
    for (const [u, m] of scaleByUnit) scaleByUnit.set(u, niceScale(m * 1.15));

    // Ligne zéro
    const yMid = padT + ph / 2;
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.beginPath();
    ctx.moveTo(padL, yMid);
    ctx.lineTo(padL + pw, yMid);
    ctx.stroke();

    // Courbes
    ctx.save();
    ctx.beginPath();
    ctx.rect(padL, padT, pw, ph);
    ctx.clip();
    for (const tr of this.traces) {
      const scale = scaleByUnit.get(QUANTITY_INFO[tr.q].unit) ?? 1;
      ctx.strokeStyle = tr.color;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      let pen = false;
      for (let k = 0; k < tr.n; k++) {
        const idx = (tr.head - tr.n + k + this.capacity) % this.capacity;
        const t = tr.t[idx];
        if (t < t0) continue;
        const y = tr.y[idx];
        if (!Number.isFinite(y)) {
          pen = false;
          continue;
        }
        const px = padL + ((t - t0) / this.window) * pw;
        const py = yMid - (y / scale) * (ph / 2);
        if (!pen) {
          ctx.moveTo(px, py);
          pen = true;
        } else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
    ctx.restore();

    // Axes : une échelle par unité (gauche pour la première, droite pour la seconde)
    const units = [...scaleByUnit.keys()];
    ctx.font = "11px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    units.slice(0, 2).forEach((u, side) => {
      const scale = scaleByUnit.get(u)!;
      ctx.fillStyle = "#cbd5e1";
      ctx.textAlign = side === 0 ? "right" : "left";
      const x = side === 0 ? padL - 6 : padL + pw + 6;
      for (let k = -4; k <= 4; k += 2) {
        const y = yMid - (k / 4) * (ph / 2);
        ctx.fillText(formatSI((scale * k) / 4, u, 3), x, y);
      }
    });

    // Légende
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    let lx = padL + 8;
    const ly = padT + 6;
    for (const tr of this.traces) {
      const c = compById.get(tr.compId);
      const info = QUANTITY_INFO[tr.q];
      const last = tr.n > 0 ? tr.y[(tr.head - 1 + this.capacity) % this.capacity] : NaN;
      const text = `${info.label}(${c ? displayName(c) : "?"}) = ${formatSI(last, info.unit)}`;
      ctx.fillStyle = "rgba(11,16,32,0.8)";
      const tw = ctx.measureText(text).width;
      ctx.fillRect(lx - 3, ly - 2, tw + 16, 16);
      ctx.fillStyle = tr.color;
      ctx.fillRect(lx, ly + 3, 8, 8);
      ctx.fillText(text, lx + 12, ly);
      lx += tw + 24;
    }
  }
}

function niceScale(m: number): number {
  if (!(m > 0)) return 1;
  const exp = Math.floor(Math.log10(m));
  const base = Math.pow(10, exp);
  const f = m / base;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nice * base;
}
