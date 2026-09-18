/**
 * Toutes les commandes accessibles au clavier, avec leurs raccourcis. Deux niveaux, comme dans vim :
 * - une touche seule pour les gestes fréquents (h j k l, a, w, x, r, u, s…) ;
 * - la touche maître Espace qui ouvre des sous-menus (a ajouter, e édition, s simulation, v vue, p panneaux,
 *   o oscilloscope, f fichier) affichés dans le panneau « which-key ».
 * La palette de commandes (:) liste tout, ainsi que les composants du circuit pour les sélectionner par nom.
 */

import { EXAMPLES } from "../sim/examples";
import { type ComponentType, DEFS, displayName } from "../sim/model";
import { formatSI } from "../sim/units";
import type { App } from "./app";
import { $, showSnackbar } from "./dom";
import type { Editor } from "./editor";
import type { Command, Keymap } from "./keys";
import type { Layout } from "./layout";
import type { MdDialog } from "./material";
import { type Quantity, QUANTITY_INFO } from "./scope";

const LEADER = "Space";

/** Touche de chaque composant dans le sous-menu « Ajouter » (mnémoniques : V pile, ~ CA → a, R, C, L…). */
const ADD_KEYS: { key: string[]; type: ComponentType }[] = [
  { key: ["v"], type: "battery" },
  { key: ["a"], type: "acsource" },
  { key: ["i"], type: "currentsource" },
  { key: ["t"], type: "vfunc" },
  { key: ["T"], type: "ifunc" },
  { key: ["r"], type: "resistor" },
  { key: ["c"], type: "capacitor" },
  { key: ["l"], type: "inductor" },
  { key: ["d"], type: "diode" },
  { key: ["e"], type: "led" },
  { key: ["p"], type: "lamp" },
  { key: ["s"], type: "switch" },
  { key: ["g"], type: "ground" },
  { key: ["V"], type: "voltmeter" },
  { key: ["A"], type: "ammeter" },
  { key: ["x", "e"], type: "vcvs" },
  { key: ["x", "g"], type: "vccs" },
  { key: ["x", "h"], type: "ccvs" },
  { key: ["x", "f"], type: "cccs" },
  { key: ["x", "v"], type: "vexpr" },
  { key: ["x", "i"], type: "iexpr" },
];

export interface CommandContext {
  app: App;
  editor: Editor;
  layout: Layout;
  keymap: Keymap;
}

export function setupCommands({ app, editor, layout, keymap }: CommandContext): void {
  const hasSelection = () => app.selection !== null;
  const hasTarget = () => editor.targetComponentId() !== null;
  const canvasFocused = () => {
    const a = document.activeElement;
    return !a || a === document.body || a.id === "canvas";
  };
  const withTarget = (fn: (id: string) => void) => () => {
    const id = editor.targetComponentId();
    if (id) fn(id);
  };
  const cmd = (id: string, category: string, label: string, keys: string[][], run: () => void, extra: Partial<Command> = {}): Command => ({
    id,
    category,
    label,
    keys,
    run,
    ...extra,
  });
  const L = (...rest: string[]) => [LEADER, ...rest];

  keymap.group(L(), "Menu principal");
  keymap.group(L("a"), "Ajouter un composant");
  keymap.group(L("a", "x"), "Sources dépendantes");
  keymap.group(["a"], "Ajouter un composant");
  keymap.group(["a", "x"], "Sources dépendantes");
  keymap.group(L("e"), "Édition");
  keymap.group(L("s"), "Simulation");
  keymap.group(L("v"), "Vue");
  keymap.group(["z"], "Vue");
  keymap.group(L("p"), "Panneaux");
  keymap.group(L("o"), "Oscilloscope");
  keymap.group(L("f"), "Fichier");
  keymap.group(L("f", "e"), "Exemples");

  // ---- Curseur clavier ----
  const CURSOR = "Curseur";
  const move = (dx: number, dy: number) => () => editor.moveCursor(dx, dy);
  keymap.add(
    cmd("cursor.left", CURSOR, "Curseur à gauche (Maj : ×5)", [["h"], ["ArrowLeft"]], move(-1, 0), { hidden: false }),
    cmd("cursor.down", CURSOR, "Curseur en bas", [["j"], ["ArrowDown"]], move(0, 1)),
    cmd("cursor.up", CURSOR, "Curseur en haut", [["k"], ["ArrowUp"]], move(0, -1)),
    cmd("cursor.right", CURSOR, "Curseur à droite", [["l"], ["ArrowRight"]], move(1, 0)),
    cmd("cursor.left5", CURSOR, "Curseur à gauche ×5", [["H"], ["S-ArrowLeft"]], move(-5, 0), { hidden: true }),
    cmd("cursor.down5", CURSOR, "Curseur en bas ×5", [["J"], ["S-ArrowDown"]], move(0, 5), { hidden: true }),
    cmd("cursor.up5", CURSOR, "Curseur en haut ×5", [["K"], ["S-ArrowUp"]], move(0, -5), { hidden: true }),
    cmd("cursor.right5", CURSOR, "Curseur à droite ×5", [["L"], ["S-ArrowRight"]], move(5, 0), { hidden: true }),
    cmd("cursor.activate", CURSOR, "Sélectionner / modifier l'élément sous le curseur (terminal : tirer un fil)", [["Enter"]], () => editor.activateCursor()),
    cmd("cursor.next", CURSOR, "Composant suivant", [["Tab"], ["n"]], () => editor.cycleSelection(1), { when: canvasFocused }),
    cmd("cursor.prev", CURSOR, "Composant précédent", [["S-Tab"], ["N"]], () => editor.cycleSelection(-1), { when: canvasFocused }),
    cmd("cursor.move", CURSOR, "Mode déplacement : h j k l déplacent la sélection (m ou Échap pour sortir)", [["m"]], () => editor.toggleMoveMode()),
    cmd("cursor.center", CURSOR, "Centrer la vue sur la sélection ou le curseur", [["z", "z"], L("v", "c")], () => editor.centerOnFocus()),
    cmd("escape", CURSOR, "Annuler / désélectionner / revenir au mode normal", [["Escape"]], () => editor.escape()),
    cmd("palette", CURSOR, "Palette de commandes (rechercher une action ou un composant)", [[":"], ["/"], L(":")], () => keymap.openPalette()),
    cmd("help", CURSOR, "Aide et liste des raccourcis", [["?"], L("?")], () => void $<MdDialog>("#help").show()),
  );

  // ---- Ajouter ----
  const ADD = "Ajouter";
  for (const { key, type } of ADD_KEYS) {
    const def = DEFS[type];
    keymap.add(cmd(`add.${type}`, ADD, def.label, [["a", ...key], L("a", ...key)], () => editor.placeAtCursor(type), { repeatable: true }));
  }
  keymap.add(
    cmd("wire", ADD, "Fil : commencer au curseur, puis w pour poser le segment et enchaîner, Entrée pour terminer", [["w"], L("a", "w")], () => editor.startKeyboardWire()),
    cmd("wire.tool", ADD, "Outil fil à la souris (glisser n'importe où)", [["W"]], () => editor.setTool(editor.tool === "wire" ? "select" : "wire")),
    cmd("select.tool", ADD, "Outil sélection à la souris", [["V"]], () => editor.setTool("select")),
  );

  // ---- Édition ----
  const EDIT = "Édition";
  keymap.add(
    cmd("edit.rotate", EDIT, "Pivoter (horaire ; r r retourne sur place)", [["r"], L("e", "r")], withTarget((id) => app.rotateSelection(1, id)), { when: hasTarget, repeatable: true }),
    cmd("edit.rotateCcw", EDIT, "Pivoter (antihoraire)", [["R"], L("e", "R")], withTarget((id) => app.rotateSelection(-1, id)), { when: hasTarget, repeatable: true }),
    cmd("edit.flip", EDIT, "Inverser le sens de référence du courant", [["i"], L("e", "i")], withTarget((id) => app.flipReference(id)), { when: hasTarget, repeatable: true }),
    cmd("edit.toggle", EDIT, "Ouvrir / fermer l'interrupteur", [["t"], L("e", "t")], withTarget((id) => app.toggleSwitch(id)), {
      repeatable: true,
      when: () => {
        const id = editor.targetComponentId();
        return !!id && app.componentById(id)?.type === "switch";
      },
    }),
    cmd("edit.value", EDIT, "Modifier la valeur (Entrée ou Échap pour revenir au canevas)", [["e"], L("e", "e")], () => {
      const id = editor.targetComponentId();
      if (!id) return;
      app.select({ kind: "component", id });
      editor.editSelected();
    }, { when: hasTarget }),
    cmd("edit.delete", EDIT, "Supprimer l'élément sous le curseur, sinon la sélection", [["x"], L("e", "x")], () => editor.deleteAtCursor(), { repeatable: true }),
    cmd("edit.deleteSel", EDIT, "Supprimer la sélection", [["Delete"], ["Backspace"]], () => app.deleteSelection(), { when: hasSelection, hidden: true }),
    cmd("edit.duplicate", EDIT, "Dupliquer", [["C-d"], L("e", "d")], () => app.duplicateSelection(), { when: () => !!app.selectedComponent(), repeatable: true }),
    cmd("edit.copy", EDIT, "Copier le composant", [["y"], ["C-c"], L("e", "y")], withTarget((id) => {
      if (app.copySelection(id)) showSnackbar(`${displayName(app.componentById(id)!)} copié : p pour coller au curseur.`, 2000);
    }), { when: hasTarget }),
    cmd("edit.paste", EDIT, "Coller au curseur", [["p"], ["C-v"], L("e", "p")], () => editor.pasteAtCursor(), { when: () => app.clipboard !== null, repeatable: true }),
    cmd("edit.repeat", EDIT, "Répéter la dernière commande d'édition (ajout, rotation, collage…)", [["."]], () => keymap.repeatLast(), { when: () => keymap.lastRepeatable !== null }),
    cmd("edit.undo", EDIT, "Annuler", [["u"], ["C-z"], L("e", "u")], () => app.undo()),
    cmd("edit.redo", EDIT, "Rétablir", [["C-r"], ["C-y"], ["C-S-z"], L("e", "U")], () => app.redo()),
    cmd("edit.deselect", EDIT, "Désélectionner", [L("e", "Escape")], () => app.select(null), { hidden: true }),
  );

  // ---- Simulation ----
  const SIM = "Simulation";
  const opt = (id: string, key: string, label: string, k: "electrons" | "conventional" | "currentArrows" | "voltageColors" | "showValues" | "showReadings") =>
    cmd(`sim.${id}`, SIM, label, [L("s", key)], () => {
      app.setOptions({ [k]: !app.options[k] });
      showSnackbar(`${label} : ${app.options[k] ? "activé" : "désactivé"}`, 1500);
    });
  keymap.add(
    cmd("sim.toggle", SIM, "Simuler / pause", [["s"], L("s", "s"), L(LEADER)], () => app.toggleRunning()),
    cmd("sim.reset", SIM, "Remettre le temps à zéro", [["S"], L("s", "r")], () => app.reset()),
    cmd("sim.faster", SIM, "Simulation plus rapide", [[">"], L("s", ">")], () => {
      app.stepTimeScale(1);
      showSnackbar(`Vitesse ×${formatSI(app.timeScale, "", 2).replace(" ", "")}`, 1200);
    }),
    cmd("sim.slower", SIM, "Simulation plus lente", [["<"], L("s", "<")], () => {
      app.stepTimeScale(-1);
      showSnackbar(`Vitesse ×${formatSI(app.timeScale, "", 2).replace(" ", "")}`, 1200);
    }),
    opt("electrons", "e", "Animer les électrons", "electrons"),
    opt("conventional", "c", "Sens conventionnel", "conventional"),
    opt("arrows", "a", "Flèches du sens du courant", "currentArrows"),
    opt("colors", "v", "Colorer les fils selon la tension", "voltageColors"),
    opt("values", "l", "Afficher les valeurs", "showValues"),
    opt("readings", "m", "Afficher V, I, P sur chaque composant", "showReadings"),
  );

  // ---- Vue ----
  const VIEW = "Vue";
  keymap.add(
    cmd("view.fit", VIEW, "Ajuster la vue au circuit", [["f"], ["z", "f"], L("v", "f")], () => editor.zoomToFit()),
    cmd("view.zoomIn", VIEW, "Zoom avant", [["+"], ["="], ["z", "i"], L("v", "+")], () => editor.zoomBy(1.25)),
    cmd("view.zoomOut", VIEW, "Zoom arrière", [["-"], ["z", "o"], L("v", "-")], () => editor.zoomBy(0.8)),
    cmd("view.zoomReset", VIEW, "Zoom 100 %", [["0"], ["z", "0"], L("v", "0")], () => editor.zoomReset()),
  );

  // ---- Panneaux ----
  const PANELS = "Panneaux";
  keymap.add(
    cmd("panel.left", PANELS, "Afficher / masquer la palette", [["1"], L("p", "1")], () => layout.toggle("left")),
    cmd("panel.right", PANELS, "Afficher / masquer les propriétés", [["2"], L("p", "2")], () => layout.toggle("right")),
    cmd("panel.bottom", PANELS, "Afficher / masquer l'oscilloscope", [["3"], L("p", "3")], () => layout.toggle("bottom")),
    cmd("panel.theme", PANELS, "Apparence et thème", [L("p", "t")], () => $("#btn-theme").click()),
  );

  // ---- Oscilloscope ----
  const SCOPE = "Oscilloscope";
  const trace = (q: Quantity, key: string) =>
    cmd(`scope.${q}`, SCOPE, `Tracer ${QUANTITY_INFO[q].long} du composant`, [L("o", key)], withTarget((id) => {
      const c = app.componentById(id);
      if (!c || c.type === "ground") return;
      app.scope.toggle(id, q);
      app.autosave();
      app.emit("select");
      showSnackbar(`${displayName(c)} : ${QUANTITY_INFO[q].long} ${app.scope.has(id, q) ? "tracée" : "retirée"}`, 1500);
    }), { when: hasTarget });
  keymap.add(
    trace("v", "v"),
    trace("i", "i"),
    trace("p", "p"),
    trace("r", "r"),
    cmd("scope.clear", SCOPE, "Effacer les traces", [L("o", "c")], () => $("#scope-clear").click()),
    cmd("scope.panel", SCOPE, "Afficher / masquer l'oscilloscope", [L("o", "o")], () => layout.toggle("bottom"), { hidden: true }),
  );

  // ---- Fichier ----
  const FILE = "Fichier";
  keymap.add(
    cmd("file.save", FILE, "Enregistrer le circuit (JSON)", [["C-s"], L("f", "s")], () => $("#btn-save").click()),
    cmd("file.open", FILE, "Ouvrir un circuit (JSON)", [["C-o"], L("f", "o")], () => $("#btn-load").click()),
    cmd("file.clear", FILE, "Effacer tout le circuit", [L("f", "n")], () => $("#btn-clear").click()),
  );
  EXAMPLES.forEach((ex, k) => {
    const key = String((k + 1) % 10);
    keymap.add(
      cmd(`file.example.${ex.id}`, FILE, `Exemple : ${ex.name}`, [L("f", "e", key)], () => {
        app.loadExample(ex.id);
        editor.zoomToFit();
      }),
    );
  });

  // ---- Palette : sélection des composants par nom ----
  keymap.setPaletteExtras(() =>
    app.circuit.components.map((c) => ({
      label: `Sélectionner ${displayName(c)} (${DEFS[c.type].label})`,
      run: () => {
        app.select({ kind: "component", id: c.id });
        editor.setCursor(c.pos);
        editor.focusCanvas();
      },
    })),
  );

  keymap.renderHelp($("#key-help"));
}
