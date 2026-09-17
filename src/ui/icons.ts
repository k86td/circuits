/**
 * Icônes Material Symbols embarquées en SVG (paquet @material-symbols/svg-400) : l'application reste autonome,
 * sans dépendre du chargement d'une police d'icônes distante. Un `<md-icon>` contenant un nom connu est remplacé
 * par le SVG correspondant ; les variantes « -fill » sont les icônes pleines.
 */

import arrowSelectorTool from "@material-symbols/svg-400/outlined/arrow_selector_tool.svg?raw";
import arrowSelectorToolFill from "@material-symbols/svg-400/outlined/arrow_selector_tool-fill.svg?raw";
import bolt from "@material-symbols/svg-400/outlined/bolt-fill.svg?raw";
import bottomPanelClose from "@material-symbols/svg-400/outlined/bottom_panel_close.svg?raw";
import bottomPanelOpen from "@material-symbols/svg-400/outlined/bottom_panel_open.svg?raw";
import brightnessAuto from "@material-symbols/svg-400/outlined/brightness_auto.svg?raw";
import check from "@material-symbols/svg-400/outlined/check.svg?raw";
import close from "@material-symbols/svg-400/outlined/close.svg?raw";
import contentCopy from "@material-symbols/svg-400/outlined/content_copy.svg?raw";
import darkMode from "@material-symbols/svg-400/outlined/dark_mode.svg?raw";
import del from "@material-symbols/svg-400/outlined/delete.svg?raw";
import download from "@material-symbols/svg-400/outlined/download.svg?raw";
import fitScreen from "@material-symbols/svg-400/outlined/fit_screen.svg?raw";
import folderOpen from "@material-symbols/svg-400/outlined/folder_open.svg?raw";
import help from "@material-symbols/svg-400/outlined/help.svg?raw";
import layersClear from "@material-symbols/svg-400/outlined/layers_clear.svg?raw";
import leftPanelClose from "@material-symbols/svg-400/outlined/left_panel_close.svg?raw";
import leftPanelOpen from "@material-symbols/svg-400/outlined/left_panel_open.svg?raw";
import lightMode from "@material-symbols/svg-400/outlined/light_mode.svg?raw";
import menuBook from "@material-symbols/svg-400/outlined/menu_book.svg?raw";
import monitoring from "@material-symbols/svg-400/outlined/monitoring.svg?raw";
import palette from "@material-symbols/svg-400/outlined/palette.svg?raw";
import pause from "@material-symbols/svg-400/outlined/pause.svg?raw";
import playArrow from "@material-symbols/svg-400/outlined/play_arrow.svg?raw";
import redo from "@material-symbols/svg-400/outlined/redo.svg?raw";
import restartAlt from "@material-symbols/svg-400/outlined/restart_alt.svg?raw";
import rightPanelClose from "@material-symbols/svg-400/outlined/right_panel_close.svg?raw";
import rightPanelOpen from "@material-symbols/svg-400/outlined/right_panel_open.svg?raw";
import rotateRight from "@material-symbols/svg-400/outlined/rotate_right.svg?raw";
import shuffle from "@material-symbols/svg-400/outlined/shuffle.svg?raw";
import speed from "@material-symbols/svg-400/outlined/speed.svg?raw";
import timeline from "@material-symbols/svg-400/outlined/timeline.svg?raw";
import timelineFill from "@material-symbols/svg-400/outlined/timeline-fill.svg?raw";
import toggleOff from "@material-symbols/svg-400/outlined/toggle_off.svg?raw";
import toggleOn from "@material-symbols/svg-400/outlined/toggle_on.svg?raw";
import undo from "@material-symbols/svg-400/outlined/undo.svg?raw";

export const ICONS: Record<string, string> = {
  arrow_selector_tool: arrowSelectorTool,
  "arrow_selector_tool-fill": arrowSelectorToolFill,
  bolt,
  bottom_panel_close: bottomPanelClose,
  bottom_panel_open: bottomPanelOpen,
  brightness_auto: brightnessAuto,
  check,
  close,
  content_copy: contentCopy,
  dark_mode: darkMode,
  delete: del,
  download,
  fit_screen: fitScreen,
  folder_open: folderOpen,
  help,
  layers_clear: layersClear,
  left_panel_close: leftPanelClose,
  left_panel_open: leftPanelOpen,
  light_mode: lightMode,
  menu_book: menuBook,
  monitoring,
  palette,
  pause,
  play_arrow: playArrow,
  redo,
  restart_alt: restartAlt,
  right_panel_close: rightPanelClose,
  right_panel_open: rightPanelOpen,
  rotate_right: rotateRight,
  shuffle,
  speed,
  timeline,
  "timeline-fill": timelineFill,
  toggle_off: toggleOff,
  toggle_on: toggleOn,
  undo,
};

/** Remplace le contenu d'un `<md-icon>` par l'icône nommée (le nom reste en attribut pour l'inspection). */
export function setIcon(el: HTMLElement, name: string): void {
  const svg = ICONS[name];
  el.dataset.icon = name;
  if (svg) el.innerHTML = svg;
  else el.textContent = name;
}

/** Crée un `<md-icon>` prêt à l'emploi. */
export function makeIcon(name: string, slot?: string): HTMLElement {
  const el = document.createElement("md-icon");
  setIcon(el, name);
  if (slot) el.slot = slot;
  return el;
}

/** Convertit en SVG toutes les icônes déclarées par leur nom dans le HTML statique. */
export function hydrateIcons(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>("md-icon")) {
    const name = el.textContent?.trim();
    if (name && ICONS[name]) setIcon(el, name);
  }
}
