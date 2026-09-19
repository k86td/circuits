/**
 * Disposition : les trois panneaux (palette à gauche, propriétés à droite, oscilloscope en bas) peuvent être
 * masqués / affichés depuis la barre supérieure, depuis leur propre bouton de fermeture ou au clavier
 * (1, 2, 3 : voir commands.ts). L'ouverture et la fermeture sont animées en CSS : les pistes de la grille
 * (--col-left, --col-right, --row-bottom) se referment pendant que le panneau glisse hors de l'écran.
 * L'état est mémorisé. Sur écran étroit, les panneaux latéraux se superposent au canevas.
 */

import { $ } from "./dom";
import { setIcon } from "./icons";
import type { MdIconButton } from "./material";

export type PanelId = "left" | "right" | "bottom";

const PANELS: PanelId[] = ["left", "right", "bottom"];
const PANEL_IDS: Record<PanelId, string> = { left: "#palette-panel", right: "#right", bottom: "#scope-panel" };
const STORAGE_KEY = "circuits.layout.v1";
const ICONS: Record<PanelId, { shown: string; hidden: string }> = {
  left: { shown: "left_panel_close", hidden: "left_panel_open" },
  right: { shown: "right_panel_close", hidden: "right_panel_open" },
  bottom: { shown: "bottom_panel_close", hidden: "bottom_panel_open" },
};

export class Layout {
  hidden: Record<PanelId, boolean> = { left: false, right: false, bottom: false };
  private listeners = new Set<() => void>();
  private compact = window.matchMedia("(max-width: 900px)");

  constructor() {
    let restored = false;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as Partial<Record<PanelId, boolean>>;
        for (const p of PANELS) if (typeof saved[p] === "boolean") this.hidden[p] = saved[p]!;
        restored = true;
      }
    } catch {
      /* ignore */
    }
    if (!restored && this.compact.matches) {
      this.hidden.left = true;
      this.hidden.right = true;
    }

    for (const p of PANELS) {
      $<MdIconButton>(`#toggle-${p}`).addEventListener("click", () => this.toggle(p));
      for (const btn of document.querySelectorAll<HTMLElement>(`[data-hide="${p}"]`)) btn.addEventListener("click", () => this.set(p, true));
    }
    $("#scrim").addEventListener("click", () => {
      this.set("left", true);
      this.set("right", true);
    });
    this.compact.addEventListener("change", () => this.applyToDom());
    this.applyToDom();
  }

  on(fn: () => void): void {
    this.listeners.add(fn);
  }

  toggle(p: PanelId): void {
    this.set(p, !this.hidden[p]);
  }

  set(p: PanelId, hidden: boolean): void {
    if (this.hidden[p] === hidden) return;
    this.hidden[p] = hidden;
    // Sur écran étroit, un seul panneau latéral superposé à la fois.
    if (!hidden && this.compact.matches) {
      if (p === "left") this.hidden.right = true;
      if (p === "right") this.hidden.left = true;
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.hidden));
    } catch {
      /* ignore */
    }
    this.applyToDom();
    this.listeners.forEach((fn) => fn());
  }

  private applyToDom(): void {
    const body = document.body;
    body.classList.toggle("compact", this.compact.matches);
    for (const p of PANELS) {
      body.classList.toggle(`hide-${p}`, this.hidden[p]);
      // Le panneau reste dans la disposition pendant l'animation (CSS) ; inert le retire du focus et des lecteurs d'écran.
      const panel = $(PANEL_IDS[p]);
      panel.inert = this.hidden[p];
      panel.setAttribute("aria-hidden", String(this.hidden[p]));
      const btn = $<MdIconButton>(`#toggle-${p}`);
      btn.selected = this.hidden[p];
      const icon = btn.querySelector<HTMLElement>("md-icon");
      if (icon) setIcon(icon, this.hidden[p] ? ICONS[p].hidden : ICONS[p].shown);
    }
    const overlayOpen = this.compact.matches && (!this.hidden.left || !this.hidden.right);
    body.classList.toggle("overlay-open", overlayOpen);
  }
}
