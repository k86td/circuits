/**
 * Icônes Material Symbols (Google, licence Apache 2.0) copiées en SVG dans src/ui/icons/ : l'application reste autonome,
 * sans dépendre du chargement d'une police d'icônes distante. Un `<md-icon>` contenant un nom connu est remplacé
 * par le SVG correspondant ; les variantes « -fill » sont les icônes pleines.
 */

import arrowSelectorTool from "./icons/arrow_selector_tool.svg?raw";
import arrowSelectorToolFill from "./icons/arrow_selector_tool-fill.svg?raw";
import bolt from "./icons/bolt-fill.svg?raw";
import bottomPanelClose from "./icons/bottom_panel_close.svg?raw";
import bottomPanelOpen from "./icons/bottom_panel_open.svg?raw";
import brightnessAuto from "./icons/brightness_auto.svg?raw";
import check from "./icons/check.svg?raw";
import close from "./icons/close.svg?raw";
import contentCopy from "./icons/content_copy.svg?raw";
import darkMode from "./icons/dark_mode.svg?raw";
import del from "./icons/delete.svg?raw";
import download from "./icons/download.svg?raw";
import fitScreen from "./icons/fit_screen.svg?raw";
import folderOpen from "./icons/folder_open.svg?raw";
import help from "./icons/help.svg?raw";
import layersClear from "./icons/layers_clear.svg?raw";
import leftPanelClose from "./icons/left_panel_close.svg?raw";
import leftPanelOpen from "./icons/left_panel_open.svg?raw";
import lightMode from "./icons/light_mode.svg?raw";
import menuBook from "./icons/menu_book.svg?raw";
import monitoring from "./icons/monitoring.svg?raw";
import palette from "./icons/palette.svg?raw";
import pause from "./icons/pause.svg?raw";
import playArrow from "./icons/play_arrow.svg?raw";
import redo from "./icons/redo.svg?raw";
import restartAlt from "./icons/restart_alt.svg?raw";
import rightPanelClose from "./icons/right_panel_close.svg?raw";
import rightPanelOpen from "./icons/right_panel_open.svg?raw";
import rotateRight from "./icons/rotate_right.svg?raw";
import shuffle from "./icons/shuffle.svg?raw";
import speed from "./icons/speed.svg?raw";
import swapHoriz from "./icons/swap_horiz.svg?raw";
import timeline from "./icons/timeline.svg?raw";
import timelineFill from "./icons/timeline-fill.svg?raw";
import toggleOff from "./icons/toggle_off.svg?raw";
import toggleOn from "./icons/toggle_on.svg?raw";
import undo from "./icons/undo.svg?raw";

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
  swap_horiz: swapHoriz,
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
