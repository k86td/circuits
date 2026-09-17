/** Palette, barre d'outils, panneau de propriétés et oscilloscope (DOM). */

import { EXAMPLES } from "../sim/examples";
import { EXPR_HELP, evalValue, isValidExpr } from "../sim/expr";
import { type ComponentType, DEFS, PALETTE_ORDER, displayName, isDependentSource } from "../sim/model";
import { formatSI, parseSI } from "../sim/units";
import type { App } from "./app";
import type { Editor } from "./editor";
import { drawIcon } from "./renderer";
import { type Quantity, QUANTITY_INFO, WINDOWS } from "./scope";

const CATEGORY_LABELS: Record<string, string> = {
  sources: "Sources",
  dependent: "Sources dépendantes",
  passive: "Passifs",
  semi: "Semi-conducteurs",
  misc: "Divers",
  meters: "Mesure",
};

const PALETTE_NAMES: Record<ComponentType, string> = {
  battery: "Pile (CC)",
  acsource: "Source CA",
  vfunc: "Source v(t)",
  currentsource: "Source de courant",
  ifunc: "Source i(t)",
  vcvs: "VCVS  E·v",
  vccs: "VCCS  G·v",
  ccvs: "CCVS  H·i",
  cccs: "CCCS  F·i",
  resistor: "Résistance",
  capacitor: "Condensateur",
  inductor: "Bobine",
  diode: "Diode",
  led: "DEL",
  lamp: "Ampoule",
  switch: "Interrupteur",
  ground: "Masse",
  voltmeter: "Voltmètre",
  ammeter: "Ampèremètre",
};

function $<T extends HTMLElement>(sel: string): T {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`Élément introuvable : ${sel}`);
  return el;
}

export function setupPanels(app: App, editor: Editor): void {
  setupPalette(app, editor);
  setupToolbar(app, editor);
  setupProps(app);
  setupScope(app);
  setupStatus(app);
}

// ---------------- Palette ----------------

function setupPalette(app: App, editor: Editor): void {
  const root = $("#palette");
  root.innerHTML = "";
  const groups = new Map<string, ComponentType[]>();
  for (const t of PALETTE_ORDER) {
    const cat = DEFS[t].category;
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat)!.push(t);
  }
  for (const [cat, types] of groups) {
    const h = document.createElement("div");
    h.className = "palette-cat";
    h.textContent = CATEGORY_LABELS[cat] ?? cat;
    root.appendChild(h);
    for (const t of types) {
      const def = DEFS[t];
      const item = document.createElement("button");
      item.className = "palette-item";
      item.title = `${def.label}\n${def.description}\nGlisser sur le canevas, ou cliquer puis cliquer sur le canevas.`;
      const icon = document.createElement("canvas");
      drawIcon(icon, t);
      const label = document.createElement("span");
      label.textContent = PALETTE_NAMES[t];
      item.append(icon, label);
      item.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        editor.startPlacing(t);
        editor.placeOnRelease = true;
      });
      item.addEventListener("click", () => {
        editor.startPlacing(t);
        editor.placeOnRelease = false;
      });
      root.appendChild(item);
    }
  }
  void app;
}

// ---------------- Barre d'outils ----------------

function setupToolbar(app: App, editor: Editor): void {
  const play = $<HTMLButtonElement>("#btn-play");
  const reset = $<HTMLButtonElement>("#btn-reset");
  const speed = $<HTMLInputElement>("#speed");
  const speedLabel = $("#speed-label");
  const toolSelect = $<HTMLButtonElement>("#tool-select");
  const toolWire = $<HTMLButtonElement>("#tool-wire");
  const examples = $<HTMLSelectElement>("#examples");
  const btnFit = $<HTMLButtonElement>("#btn-fit");
  const btnUndo = $<HTMLButtonElement>("#btn-undo");
  const btnRedo = $<HTMLButtonElement>("#btn-redo");
  const btnClear = $<HTMLButtonElement>("#btn-clear");
  const btnSave = $<HTMLButtonElement>("#btn-save");
  const btnLoad = $<HTMLButtonElement>("#btn-load");
  const fileInput = $<HTMLInputElement>("#file-input");
  const btnHelp = $<HTMLButtonElement>("#btn-help");
  const help = $<HTMLDialogElement>("#help");

  const updatePlay = () => {
    play.textContent = app.running ? "⏸ Pause" : "▶ Simuler";
    play.classList.toggle("active", app.running);
  };
  app.on("run", updatePlay);
  updatePlay();
  play.addEventListener("click", () => app.toggleRunning());
  reset.addEventListener("click", () => app.reset());

  const SPEEDS = [1e-4, 2e-4, 5e-4, 1e-3, 2e-3, 5e-3, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10];
  speed.min = "0";
  speed.max = String(SPEEDS.length - 1);
  speed.value = String(SPEEDS.indexOf(1));
  const updateSpeed = () => {
    app.timeScale = SPEEDS[Number(speed.value)];
    speedLabel.textContent = `×${formatSI(app.timeScale, "", 2).replace(" ", "")}`;
  };
  speed.addEventListener("input", updateSpeed);
  updateSpeed();

  const updateTools = () => {
    toolSelect.classList.toggle("active", editor.tool === "select");
    toolWire.classList.toggle("active", editor.tool === "wire");
  };
  editor.onToolChange(updateTools);
  toolSelect.addEventListener("click", () => editor.setTool("select"));
  toolWire.addEventListener("click", () => editor.setTool("wire"));
  updateTools();

  for (const ex of EXAMPLES) {
    const o = document.createElement("option");
    o.value = ex.id;
    o.textContent = ex.name;
    examples.appendChild(o);
  }
  examples.value = "";
  examples.addEventListener("change", () => {
    if (!examples.value) return;
    app.loadExample(examples.value);
    editor.zoomToFit();
    examples.value = "";
  });

  btnFit.addEventListener("click", () => editor.zoomToFit());
  btnUndo.addEventListener("click", () => app.undo());
  btnRedo.addEventListener("click", () => app.redo());
  btnClear.addEventListener("click", () => {
    if (confirm("Effacer tout le circuit ?")) app.clearAll();
  });
  btnSave.addEventListener("click", () => {
    const blob = new Blob([app.serialize()], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "circuit.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  btnLoad.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    const ok = app.loadJSON(await f.text());
    if (!ok) alert("Fichier invalide.");
    else editor.zoomToFit();
    fileInput.value = "";
  });
  btnHelp.addEventListener("click", () => help.showModal());
  $("#expr-help").textContent = EXPR_HELP.join("\n");

  // Options d'affichage
  const bind = (id: string, key: "electrons" | "conventional" | "voltageColors" | "showValues" | "showReadings") => {
    const el = $<HTMLInputElement>(id);
    el.checked = app.options[key];
    el.addEventListener("change", () => app.setOptions({ [key]: el.checked }));
  };
  bind("#opt-electrons", "electrons");
  bind("#opt-conventional", "conventional");
  bind("#opt-colors", "voltageColors");
  bind("#opt-values", "showValues");
  bind("#opt-readings", "showReadings");
  const iref = $<HTMLInputElement>("#opt-iref");
  const irefLabel = $("#opt-iref-label");
  const IREFS = [1e-6, 10e-6, 100e-6, 1e-3, 5e-3, 10e-3, 50e-3, 100e-3, 0.5, 1, 5];
  iref.min = "0";
  iref.max = String(IREFS.length - 1);
  let idx = IREFS.findIndex((v) => v >= app.options.iRef);
  if (idx < 0) idx = IREFS.length - 1;
  iref.value = String(idx);
  const updIref = () => {
    app.setOptions({ iRef: IREFS[Number(iref.value)] });
    irefLabel.textContent = formatSI(app.options.iRef, "A", 2);
  };
  iref.addEventListener("input", updIref);
  irefLabel.textContent = formatSI(app.options.iRef, "A", 2);
}

// ---------------- Propriétés ----------------

function setupProps(app: App): void {
  const root = $("#props");
  let currentId: string | null = null;
  let readings: HTMLElement | null = null;

  const render = () => {
    const c = app.selectedComponent();
    const w = app.selectedWire();
    root.innerHTML = "";
    readings = null;
    if (w) {
      currentId = null;
      root.innerHTML = `<h3>Fil</h3><p class="hint">Glissez une extrémité pour la déplacer. Suppr pour effacer.</p>`;
      readings = document.createElement("div");
      readings.className = "readings";
      root.appendChild(readings);
      updateReadings();
      return;
    }
    if (!c) {
      currentId = null;
      root.innerHTML = `<h3>Propriétés</h3><p class="hint">Sélectionnez un composant pour modifier ses valeurs et tracer ses courbes.</p>
      <p class="hint">Astuces : glissez depuis un terminal pour tirer un fil · R pour pivoter · Suppr pour effacer · Espace pour lancer/arrêter · molette pour zoomer · cliquez un interrupteur pour le basculer.</p>`;
      return;
    }
    currentId = c.id;
    const def = DEFS[c.type];
    const h = document.createElement("h3");
    h.textContent = def.label;
    root.appendChild(h);
    const desc = document.createElement("p");
    desc.className = "hint";
    desc.textContent = def.description;
    root.appendChild(desc);

    // Nom
    const nameRow = document.createElement("label");
    nameRow.className = "row";
    nameRow.innerHTML = `<span>Nom</span>`;
    const nameInput = document.createElement("input");
    nameInput.value = displayName(c);
    nameInput.addEventListener("change", () => {
      if (nameInput.value.trim() !== displayName(c)) app.setName(c.id, nameInput.value);
    });
    nameRow.appendChild(nameInput);
    root.appendChild(nameRow);

    def.props.forEach((p, k) => {
      const row = document.createElement("label");
      row.className = "row";
      const span = document.createElement("span");
      span.textContent = p.unit ? `${p.label} (${p.unit})` : p.label;
      const input = document.createElement("input");
      if (k === 0) input.dataset.main = "1";
      const val = c.props[p.key];
      input.value = typeof val === "number" ? formatSI(val, "", 6).replace(" ", "") : String(val);
      input.title = "Nombre avec préfixe SI (4.7k, 100u) ou expression de t (ex. 5*sin(2*pi*60*t))";
      const err = document.createElement("small");
      err.className = "error";
      const apply = () => {
        const text = input.value.trim();
        const num = parseSI(text);
        const current = app.componentById(c.id)?.props[p.key];
        if (num !== null && !/[a-zA-Z]\(|\bt\b/.test(text)) {
          if (p.min !== undefined && num < p.min) {
            err.textContent = `Minimum : ${formatSI(p.min, p.unit)}`;
            return;
          }
          err.textContent = "";
          if (current !== num) app.setProp(c.id, p.key, num);
        } else if (isValidExpr(text)) {
          err.textContent = "";
          if (current !== text) app.setProp(c.id, p.key, text);
        } else {
          err.textContent = "Valeur ou expression invalide";
        }
      };
      input.addEventListener("change", apply);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          apply();
          input.blur();
        }
      });
      row.append(span, input, err);
      root.appendChild(row);
    });

    if (c.type === "switch") {
      const b = document.createElement("button");
      b.textContent = c.closed ? "Ouvrir l'interrupteur" : "Fermer l'interrupteur";
      b.addEventListener("click", () => app.toggleSwitch(c.id));
      root.appendChild(b);
    }

    const actions = document.createElement("div");
    actions.className = "actions";
    const rot = document.createElement("button");
    rot.textContent = "⟳ Pivoter (R)";
    rot.addEventListener("click", () => app.rotateSelection());
    const dup = document.createElement("button");
    dup.textContent = "⧉ Dupliquer";
    dup.addEventListener("click", () => app.duplicateSelection());
    const del = document.createElement("button");
    del.textContent = "🗑 Supprimer";
    del.className = "danger";
    del.addEventListener("click", () => app.deleteSelection());
    actions.append(rot, dup, del);
    root.appendChild(actions);

    // Traces
    if (c.type !== "ground") {
      const th = document.createElement("h4");
      th.textContent = "Tracer en fonction du temps";
      root.appendChild(th);
      const traces = document.createElement("div");
      traces.className = "traces";
      const qs: Quantity[] = ["v", "i", "p", "r"];
      for (const q of qs) {
        const lab = document.createElement("label");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = app.scope.has(c.id, q);
        cb.addEventListener("change", () => {
          app.scope.toggle(c.id, q);
          app.autosave();
        });
        lab.append(cb, document.createTextNode(` ${QUANTITY_INFO[q].long}`));
        traces.appendChild(lab);
      }
      root.appendChild(traces);
    }

    readings = document.createElement("div");
    readings.className = "readings";
    root.appendChild(readings);
    updateReadings();
  };

  const updateReadings = () => {
    if (!readings) return;
    const w = app.selectedWire();
    if (w) {
      const v = app.voltageAtPoint(w.a);
      const i = app.sim.wireCurrents.get(w.id) ?? 0;
      readings.innerHTML = v === null || app.sim.error ? "" : `<div><b>Tension du nœud</b> ${formatSI(v, "V")}</div><div><b>Courant</b> ${formatSI(Math.abs(i), "A")}</div>`;
      return;
    }
    const c = app.selectedComponent();
    if (!c || c.id !== currentId) return;
    const r = app.sim.results.get(c.id);
    if (!r || app.sim.error || c.type === "ground") {
      readings.innerHTML = "";
      return;
    }
    const rows = [
      ["Tension", formatSI(r.v, "V")],
      ["Courant", formatSI(r.i, "A")],
      ["Puissance", formatSI(r.p, "W")],
    ];
    if (Math.abs(r.i) > 1e-12) rows.push(["V / I", formatSI(r.v / r.i, "Ω")]);
    if (isDependentSource(c.type) && r.vc !== undefined && r.ic !== undefined) {
      rows.push(["Tension de commande", formatSI(r.vc, "V")]);
      rows.push(["Courant de commande", formatSI(r.ic, "A")]);
    }
    for (const p of DEFS[c.type].props) {
      const v = c.props[p.key];
      if (typeof v === "string") rows.push([`${p.label} (t)`, formatSI(evalValue(v, app.sim.time), p.unit)]);
    }
    readings.innerHTML = rows.map(([k, v]) => `<div><b>${k}</b> ${v}</div>`).join("");
  };

  app.on("select", render);
  app.on("change", () => {
    const c = app.selectedComponent();
    if ((c?.id ?? null) !== currentId || (!c && !app.selectedWire())) render();
    else updateReadings();
  });
  let lastUpdate = 0;
  app.on("tick", () => {
    const now = performance.now();
    if (now - lastUpdate > 100) {
      lastUpdate = now;
      updateReadings();
    }
  });
  render();
}

// ---------------- Oscilloscope ----------------

function setupScope(app: App): void {
  const canvas = $<HTMLCanvasElement>("#scope");
  const ctx = canvas.getContext("2d")!;
  const win = $<HTMLSelectElement>("#scope-window");
  const clear = $<HTMLButtonElement>("#scope-clear");
  const toggle = $<HTMLButtonElement>("#scope-toggle");
  const panel = $("#scope-panel");
  for (const w of WINDOWS) {
    const o = document.createElement("option");
    o.value = String(w);
    o.textContent = formatSI(w, "s");
    win.appendChild(o);
  }
  const syncWin = () => {
    win.value = String(WINDOWS.reduce((best, w) => (Math.abs(w - app.scope.window) < Math.abs(best - app.scope.window) ? w : best), WINDOWS[0]));
  };
  syncWin();
  win.addEventListener("change", () => {
    app.scope.window = Number(win.value);
    app.autosave();
  });
  clear.addEventListener("click", () => {
    app.scope.traces = [];
    app.emit("select");
    app.autosave();
  });
  toggle.addEventListener("click", () => {
    panel.classList.toggle("collapsed");
    toggle.textContent = panel.classList.contains("collapsed") ? "▲ Oscilloscope" : "▼ Oscilloscope";
  });
  app.on("change", syncWin);

  const draw = () => {
    if (panel.classList.contains("collapsed")) {
      requestAnimationFrame(draw);
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = Math.round(rect.width * dpr);
    const h = Math.round(rect.height * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    app.scope.draw(ctx, rect.width, rect.height, app.circuit, app.sim.time);
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);
}

// ---------------- Barre d'état ----------------

function setupStatus(app: App): void {
  const el = $("#status");
  const update = () => {
    const parts: string[] = [];
    parts.push(`t = ${formatSI(app.sim.time, "s", 4)}`);
    if (app.running && Math.abs(app.effectiveScale - app.timeScale) / app.timeScale > 0.05)
      parts.push(`⚠ vitesse réelle ×${formatSI(app.effectiveScale, "", 2)} (calcul limité)`);
    parts.push(`Δt = ${formatSI(app.sim.dt, "s", 2)}`);
    parts.push(`${app.sim.netlist.nodeCount} nœud${app.sim.netlist.nodeCount > 1 ? "s" : ""}`);
    if (!app.sim.netlist.hasGround && app.circuit.components.length > 0) parts.push("pas de masse : nœud 0 pris comme référence");
    el.className = "";
    if (app.sim.error) {
      parts.push(`⛔ ${app.sim.error}`);
      el.className = "error";
    } else if (app.sim.warning) {
      parts.push(`⚠ ${app.sim.warning}`);
      el.className = "warn";
    }
    el.textContent = parts.join("   ·   ");
  };
  let last = 0;
  app.on("tick", () => {
    const now = performance.now();
    if (now - last > 120) {
      last = now;
      update();
    }
  });
  app.on("change", update);
  app.on("run", update);
  update();
}
