/** Palette, barre d'outils, panneau de propriétés, oscilloscope et dialogue de thème (DOM, composants Material 3). */

import { EXAMPLES } from "../sim/examples";
import { EXPR_HELP, evalValue, exprRefs, isValidExpr } from "../sim/expr";
import { type ComponentType, DEFS, PALETTE_ORDER, displayName, isDependentSource } from "../sim/model";
import { formatSI, parseSI } from "../sim/units";
import { type App, SPEEDS } from "./app";
import { $, showSnackbar } from "./dom";
import type { Editor } from "./editor";
import type { MdCheckbox, MdDialog, MdFilterChip, MdIconButton, MdMenu, MdOutlinedSelect, MdSlider, MdSwitch } from "./material";
import { makeIcon, setIcon } from "./icons";
import { drawIcon } from "./renderer";
import { type Quantity, QUANTITY_INFO, WINDOWS } from "./scope";
import { MODE_LABELS, PRESET_SEEDS, type ThemeMode, type ThemeVariant, VARIANT_LABELS, isHexColor, theme } from "./theme";

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
  vexpr: "Source v = f(i, v)",
  iexpr: "Source i = f(i, v)",
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

export function setupPanels(app: App, editor: Editor): void {
  setupPalette(editor);
  setupToolbar(app, editor);
  setupDisplayOptions(app);
  setupProps(app);
  setupScope(app);
  setupStatus(app);
  setupThemeDialog();
  setupDialogs();
}

/** Les boutons `data-close` ferment le dialogue Material qui les contient, avec leur valeur comme résultat. */
function setupDialogs(): void {
  for (const btn of document.querySelectorAll<HTMLElement>("md-dialog [data-close]")) {
    btn.addEventListener("click", () => btn.closest<MdDialog>("md-dialog")?.close(btn.dataset.close));
  }
}

// ---------------- Palette ----------------

function setupPalette(editor: Editor): void {
  const root = $("#palette");
  root.innerHTML = "";
  const groups = new Map<string, ComponentType[]>();
  for (const t of PALETTE_ORDER) {
    const cat = DEFS[t].category;
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat)!.push(t);
  }
  const icons: { canvas: HTMLCanvasElement; type: ComponentType }[] = [];
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
      const ripple = document.createElement("md-ripple");
      const ic = document.createElement("canvas");
      drawIcon(ic, t);
      icons.push({ canvas: ic, type: t });
      const label = document.createElement("span");
      label.textContent = PALETTE_NAMES[t];
      item.append(ripple, ic, label);
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
  // Les icônes sont dessinées avec les couleurs du thème : on les redessine quand il change.
  theme.on(() => {
    for (const { canvas, type } of icons) drawIcon(canvas, type);
  });
}

// ---------------- Barre d'outils ----------------

function setupToolbar(app: App, editor: Editor): void {
  const play = $<HTMLElement>("#btn-play");
  const playIcon = $("#play-icon");
  const playLabel = $("#play-label");
  const reset = $("#btn-reset");
  const speed = $<MdSlider>("#speed");
  const speedLabel = $("#speed-label");
  const toolSelect = $<MdIconButton>("#tool-select");
  const toolWire = $<MdIconButton>("#tool-wire");
  const btnExamples = $("#btn-examples");
  const examplesMenu = $<MdMenu>("#examples-menu");
  const btnFit = $("#btn-fit");
  const btnUndo = $("#btn-undo");
  const btnRedo = $("#btn-redo");
  const btnClear = $("#btn-clear");
  const confirmClear = $<MdDialog>("#confirm-clear");
  const btnSave = $("#btn-save");
  const btnLoad = $("#btn-load");
  const fileInput = $<HTMLInputElement>("#file-input");
  const btnHelp = $("#btn-help");
  const help = $<MdDialog>("#help");
  const btnTheme = $("#btn-theme");
  const themeDialog = $<MdDialog>("#theme-dialog");

  const updatePlay = () => {
    setIcon(playIcon, app.running ? "pause" : "play_arrow");
    playLabel.textContent = app.running ? "Pause" : "Simuler";
    play.classList.toggle("running", app.running);
  };
  app.on("run", updatePlay);
  updatePlay();
  play.addEventListener("click", () => app.toggleRunning());
  reset.addEventListener("click", () => app.reset());

  speed.min = 0;
  speed.max = SPEEDS.length - 1;
  speed.step = 1;
  speed.value = SPEEDS.indexOf(1);
  const showSpeed = () => {
    const text = `×${formatSI(app.timeScale, "", 2).replace(" ", "")}`;
    speedLabel.textContent = text;
    speed.valueLabel = text;
    const idx = SPEEDS.indexOf(app.timeScale);
    if (idx >= 0 && Number(speed.value) !== idx) speed.value = idx;
  };
  speed.addEventListener("input", () => app.setTimeScale(SPEEDS[Number(speed.value)]));
  app.on("speed", showSpeed);
  showSpeed();

  const updateTools = () => {
    toolSelect.selected = editor.tool === "select";
    toolWire.selected = editor.tool === "wire";
  };
  editor.onToolChange(updateTools);
  toolSelect.addEventListener("click", () => editor.setTool("select"));
  toolWire.addEventListener("click", () => editor.setTool("wire"));
  updateTools();

  for (const ex of EXAMPLES) {
    const item = document.createElement("md-menu-item");
    const headline = document.createElement("div");
    headline.slot = "headline";
    headline.textContent = ex.name;
    item.appendChild(headline);
    item.addEventListener("click", () => {
      app.loadExample(ex.id);
      editor.zoomToFit();
    });
    examplesMenu.appendChild(item);
  }
  btnExamples.addEventListener("click", () => {
    examplesMenu.open = !examplesMenu.open;
  });

  btnFit.addEventListener("click", () => editor.zoomToFit());
  btnUndo.addEventListener("click", () => app.undo());
  btnRedo.addEventListener("click", () => app.redo());
  btnClear.addEventListener("click", () => void confirmClear.show());
  confirmClear.addEventListener("closed", () => {
    if (confirmClear.returnValue === "clear") app.clearAll();
  });
  btnSave.addEventListener("click", () => {
    const blob = new Blob([app.serialize()], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "circuit.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    showSnackbar("Circuit enregistré (circuit.json).");
  });
  btnLoad.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    const ok = app.loadJSON(await f.text());
    if (!ok) showSnackbar("Fichier invalide.");
    else editor.zoomToFit();
    fileInput.value = "";
  });
  btnHelp.addEventListener("click", () => void help.show());
  btnTheme.addEventListener("click", () => void themeDialog.show());
  $("#expr-help").textContent = EXPR_HELP.join("\n");
}

// ---------------- Options d'affichage ----------------

function setupDisplayOptions(app: App): void {
  const bind = (id: string, key: "electrons" | "conventional" | "voltageColors" | "currentArrows" | "showValues" | "showReadings") => {
    const el = $<MdSwitch>(id);
    el.selected = app.options[key];
    el.addEventListener("change", () => app.setOptions({ [key]: el.selected }));
    app.on("options", () => {
      el.selected = app.options[key];
    });
  };
  bind("#opt-electrons", "electrons");
  bind("#opt-conventional", "conventional");
  bind("#opt-arrows", "currentArrows");
  bind("#opt-colors", "voltageColors");
  bind("#opt-values", "showValues");
  bind("#opt-readings", "showReadings");

  const iref = $<MdSlider>("#opt-iref");
  const irefLabel = $("#opt-iref-label");
  const IREFS = [1e-6, 10e-6, 100e-6, 1e-3, 5e-3, 10e-3, 50e-3, 100e-3, 0.5, 1, 5];
  iref.min = 0;
  iref.max = IREFS.length - 1;
  iref.step = 1;
  let idx = IREFS.findIndex((v) => v >= app.options.iRef);
  if (idx < 0) idx = IREFS.length - 1;
  iref.value = idx;
  const showIref = () => {
    const text = formatSI(app.options.iRef, "A", 2);
    irefLabel.textContent = text;
    iref.valueLabel = text;
  };
  iref.addEventListener("input", () => {
    app.setOptions({ iRef: IREFS[Number(iref.value)] });
    showIref();
  });
  showIref();
}

// ---------------- Propriétés ----------------

function setupProps(app: App): void {
  const root = $("#props");
  let currentId: string | null = null;
  let readings: HTMLElement | null = null;

  const makeButton = (tag: "md-outlined-button" | "md-text-button" | "md-filled-tonal-button", label: string, iconName: string, onClick: () => void) => {
    const b = document.createElement(tag);
    b.append(makeIcon(iconName, "icon"), document.createTextNode(label));
    b.addEventListener("click", onClick);
    return b;
  };

  const render = () => {
    const c = app.selectedComponent();
    const w = app.selectedWire();
    root.innerHTML = "";
    readings = null;
    if (w) {
      currentId = null;
      const n = app.selectedWireIds().length;
      const what = n > 1 ? `Fil (${n} segments reliés)` : "Fil";
      root.innerHTML = `<h3>${what}</h3><p class="hint">Glissez le fil pour le déplacer : les fils voisins suivent et les terminaux restent raccordés. Glissez une extrémité pour déplacer la jonction (Alt : ce seul fil). Alt+clic sélectionne un seul segment. Suppr ou x pour effacer.</p>`;
      readings = document.createElement("div");
      readings.className = "readings";
      root.appendChild(readings);
      updateReadings();
      return;
    }
    if (!c) {
      currentId = null;
      root.innerHTML = `<p class="hint">Sélectionnez un composant pour modifier ses valeurs et tracer ses courbes.</p>
      <p class="hint">Souris : glissez depuis un terminal pour tirer un fil · glissez un fil ou un composant, le câblage suit · cliquez un interrupteur pour le basculer · molette pour zoomer.</p>
      <p class="hint">Clavier : h j k l déplacent le curseur · a puis une lettre pose un composant · w trace un fil · r pivote · x efface · s simule · Espace ouvre le menu · : la palette de commandes · ? l'aide.</p>`;
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

    // Grandeurs des autres composants utilisables dans les expressions
    const others = app.circuit.components.filter((o) => o.id !== c.id && o.type !== "ground").map(displayName);
    if (others.length > 0 && def.props.length > 0) {
      const refs = document.createElement("p");
      refs.className = "hint";
      refs.textContent = `Dans une expression : t, ${others
        .slice(0, 6)
        .map((n) => `i_${n}, v_${n}`)
        .join(", ")}${others.length > 6 ? ", …" : ""} (ex. 2*i_${others[0]}).`;
      root.appendChild(refs);
    }

    const fields = document.createElement("div");
    fields.className = "fields";
    root.appendChild(fields);

    // Nom
    const nameInput = document.createElement("md-outlined-text-field");
    nameInput.label = "Nom";
    nameInput.value = displayName(c);
    nameInput.addEventListener("change", () => {
      if (nameInput.value.trim() !== displayName(c)) app.setName(c.id, nameInput.value);
    });
    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") nameInput.blur();
    });
    fields.appendChild(nameInput);

    def.props.forEach((p, k) => {
      const input = document.createElement("md-outlined-text-field");
      input.label = p.unit ? `${p.label} (${p.unit})` : p.label;
      if (k === 0) input.dataset.main = "1";
      const val = c.props[p.key];
      input.value = typeof val === "number" ? formatSI(val, "", 6).replace(" ", "") : String(val);
      input.supportingText = "Préfixe SI (4.7k, 100u) ou expression de t";
      const setError = (msg: string) => {
        input.error = msg !== "";
        input.errorText = msg;
      };
      const apply = () => {
        const text = input.value.trim();
        const num = parseSI(text);
        const current = app.componentById(c.id)?.props[p.key];
        if (num !== null && !/[a-zA-Z]\(|\bt\b/.test(text)) {
          if (p.min !== undefined && num < p.min) {
            setError(`Minimum : ${formatSI(p.min, p.unit)}`);
            return;
          }
          setError("");
          if (current !== num) app.setProp(c.id, p.key, num);
        } else if (isValidExpr(text)) {
          const names = new Set(app.circuit.components.map(displayName));
          const unknown = exprRefs(text).filter((r) => !names.has(r.name)).map((r) => r.name);
          setError(unknown.length > 0 ? `Composant introuvable : ${[...new Set(unknown)].join(", ")} (vaut 0)` : "");
          if (current !== text) app.setProp(c.id, p.key, text);
        } else {
          setError("Valeur ou expression invalide");
        }
      };
      input.addEventListener("change", apply);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          apply();
          input.blur();
        }
      });
      fields.appendChild(input);
    });

    if (c.type === "switch") {
      const b = makeButton("md-filled-tonal-button", c.closed ? "Ouvrir l'interrupteur" : "Fermer l'interrupteur", c.closed ? "toggle_on" : "toggle_off", () =>
        app.toggleSwitch(c.id),
      );
      root.appendChild(b);
    }

    const actions = document.createElement("div");
    actions.className = "actions";
    const rot = makeButton("md-outlined-button", "Pivoter", "rotate_right", () => app.rotateSelection());
    rot.title = "Pivoter (R)";
    const flip = makeButton("md-outlined-button", "Sens de réf.", "swap_horiz", () => app.flipReference(c.id));
    flip.title = "Inverser le sens de référence du courant (I) : V et I sont signés par rapport à cette flèche";
    const dup = makeButton("md-outlined-button", "Dupliquer", "content_copy", () => app.duplicateSelection());
    dup.title = "Dupliquer (Ctrl+D)";
    const del = makeButton("md-text-button", "Supprimer", "delete", () => app.deleteSelection());
    del.className = "danger";
    del.title = "Supprimer (Suppr)";
    actions.append(rot, flip, dup, del);
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
        lab.className = "check-row";
        const cb = document.createElement("md-checkbox") as MdCheckbox;
        cb.setAttribute("touch-target", "wrapper");
        cb.checked = app.scope.has(c.id, q);
        cb.addEventListener("change", () => {
          app.scope.toggle(c.id, q);
          app.autosave();
        });
        lab.append(cb, document.createTextNode(QUANTITY_INFO[q].long));
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
    const raw = app.sim.results.get(c.id);
    if (!raw || app.sim.error || c.type === "ground") {
      readings.innerHTML = "";
      return;
    }
    const r = app.display(c, raw);
    const rows: [string, string, string][] = [
      ["Tension", formatSI(r.v, "V"), "val-v"],
      ["Courant", formatSI(r.i, "A"), "val-i"],
      ["Puissance absorbée", formatSI(r.p, "W"), "val-p"],
    ];
    if (Math.abs(r.i) > 1e-12) rows.push(["V / I", formatSI(r.v / r.i, "Ω"), ""]);
    if (isDependentSource(c.type) && r.vc !== undefined && r.ic !== undefined) {
      rows.push(["Tension de commande", formatSI(r.vc, "V"), "val-v"]);
      rows.push(["Courant de commande", formatSI(r.ic, "A"), "val-i"]);
    }
    for (const p of DEFS[c.type].props) {
      const v = c.props[p.key];
      if (typeof v === "string") rows.push([`${p.label} (t)`, formatSI(evalValue(v, app.sim.time, app.sim.refValue), p.unit), ""]);
    }
    const ref = app.options.conventional ? "sens conventionnel" : "sens des électrons";
    const note = `<div class="ref-note">Signes par rapport à la flèche de référence${c.flipRef ? " (inversée)" : ""} · ${ref}</div>`;
    readings.innerHTML = rows.map(([k, v, cls]) => `<div><b>${k}</b> <span class="${cls}">${v}</span></div>`).join("") + note;
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
  const win = $<MdOutlinedSelect>("#scope-window");
  const clear = $("#scope-clear");
  for (const w of WINDOWS) {
    const o = document.createElement("md-select-option");
    o.value = String(w);
    const headline = document.createElement("div");
    headline.slot = "headline";
    headline.textContent = formatSI(w, "s");
    o.appendChild(headline);
    win.appendChild(o);
  }
  const syncWin = () => {
    const best = WINDOWS.reduce((b, w) => (Math.abs(w - app.scope.window) < Math.abs(b - app.scope.window) ? w : b), WINDOWS[0]);
    if (win.value !== String(best)) win.value = String(best);
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
  app.on("change", syncWin);

  const draw = () => {
    const rect = canvas.getBoundingClientRect();
    // Panneau masqué : rien à dessiner.
    if (rect.width < 2 || rect.height < 2) {
      requestAnimationFrame(draw);
      return;
    }
    const dpr = window.devicePixelRatio || 1;
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
  const text = $("#status-text");
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
    text.textContent = parts.join("   ·   ");
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

// ---------------- Thème ----------------

function setupThemeDialog(): void {
  const modes = $("#theme-modes");
  const seeds = $("#theme-seeds");
  const variants = $("#theme-variants");
  const contrast = $<MdSlider>("#theme-contrast");
  const contrastLabel = $("#theme-contrast-label");
  const reset = $("#theme-reset");

  const modeChips = new Map<ThemeMode, MdFilterChip>();
  for (const m of Object.keys(MODE_LABELS) as ThemeMode[]) {
    const chip = document.createElement("md-filter-chip") as MdFilterChip;
    chip.label = MODE_LABELS[m].label;
    chip.appendChild(makeIcon(MODE_LABELS[m].icon, "icon"));
    chip.addEventListener("click", () => theme.set({ mode: m }));
    modes.appendChild(chip);
    modeChips.set(m, chip);
  }

  const variantChips = new Map<ThemeVariant, MdFilterChip>();
  for (const v of Object.keys(VARIANT_LABELS) as ThemeVariant[]) {
    const chip = document.createElement("md-filter-chip") as MdFilterChip;
    chip.label = VARIANT_LABELS[v];
    chip.addEventListener("click", () => theme.set({ variant: v }));
    variants.appendChild(chip);
    variantChips.set(v, chip);
  }

  const swatches = new Map<string, HTMLButtonElement>();
  for (const s of PRESET_SEEDS) {
    const b = document.createElement("button");
    b.className = "swatch";
    b.style.background = s.hex;
    b.title = s.name;
    b.setAttribute("aria-label", s.name);
    b.appendChild(makeIcon("check"));
    b.addEventListener("click", () => theme.set({ seed: s.hex }));
    seeds.appendChild(b);
    swatches.set(s.hex.toLowerCase(), b);
  }
  const random = document.createElement("button");
  random.className = "swatch";
  random.title = "Couleur aléatoire";
  random.setAttribute("aria-label", "Couleur aléatoire");
  random.style.background = "var(--md-sys-color-surface-container-highest)";
  const shuffle = makeIcon("shuffle");
  shuffle.style.color = "var(--md-sys-color-on-surface)";
  shuffle.style.mixBlendMode = "normal";
  random.appendChild(shuffle);
  random.addEventListener("click", () => theme.randomSeed());
  seeds.appendChild(random);

  const custom = document.createElement("label");
  custom.className = "swatch custom";
  custom.title = "Couleur personnalisée";
  const picker = document.createElement("input");
  picker.type = "color";
  picker.setAttribute("aria-label", "Couleur personnalisée");
  picker.addEventListener("input", () => {
    if (isHexColor(picker.value)) theme.set({ seed: picker.value });
  });
  custom.appendChild(picker);
  seeds.appendChild(custom);

  contrast.addEventListener("input", () => theme.set({ contrast: Number(contrast.value) }));
  reset.addEventListener("click", () => theme.set({ mode: "system", seed: PRESET_SEEDS[0].hex, variant: "tonalSpot", contrast: 0 }));

  const sync = () => {
    const s = theme.settings;
    for (const [m, chip] of modeChips) chip.selected = m === s.mode;
    for (const [v, chip] of variantChips) chip.selected = v === s.variant;
    for (const [hex, b] of swatches) b.classList.toggle("selected", hex === s.seed.toLowerCase());
    custom.classList.toggle("selected", !swatches.has(s.seed.toLowerCase()));
    picker.value = s.seed;
    contrast.value = s.contrast;
    const text = s.contrast === 0 ? "standard" : s.contrast > 0 ? `+${s.contrast}` : String(s.contrast);
    contrastLabel.textContent = text;
    contrast.valueLabel = text;
  };
  theme.on(sync);
  sync();
}
