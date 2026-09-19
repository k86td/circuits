/** Petits utilitaires DOM partagés par l'interface. */

export function $<T extends HTMLElement>(sel: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`Élément introuvable : ${sel}`);
  return el;
}

const EDITABLE_TAGS = /^(INPUT|TEXTAREA|SELECT|MD-(OUTLINED|FILLED)-(TEXT-FIELD|SELECT)|MD-SLIDER|MD-DIALOG|MD-MENU)$/;
const BUTTON_TAGS = /^(BUTTON|A|MD-[A-Z-]*BUTTON|MD-SWITCH|MD-CHECKBOX|MD-FILTER-CHIP|MD-MENU-ITEM)$/;

/**
 * Vrai si l'événement clavier provient d'un champ de saisie, d'un menu ou d'un dialogue (y compris à l'intérieur
 * du shadow DOM des composants Material) : les raccourcis globaux doivent alors être ignorés.
 */
export function isEditableTarget(e: Event): boolean {
  for (const el of e.composedPath()) {
    if (!(el instanceof HTMLElement)) continue;
    if (isEditableElement(el)) return true;
  }
  return false;
}

/** Vrai si l'élément est un champ de saisie (ou un composant Material qui en contient un). */
export function isEditableElement(el: HTMLElement): boolean {
  return EDITABLE_TAGS.test(el.tagName) || el.isContentEditable;
}

/** Vrai si la touche est pressée alors qu'un bouton a le focus (Espace / Entrée l'activent déjà). */
export function isButtonTarget(e: Event): boolean {
  const first = e.composedPath()[0];
  return first instanceof HTMLElement && BUTTON_TAGS.test(first.tagName);
}

let snackTimer = 0;

/** Affiche brièvement un message (snackbar Material). */
export function showSnackbar(message: string, ms = 3500): void {
  const el = document.getElementById("snackbar");
  if (!el) return;
  el.textContent = message;
  el.classList.add("open");
  window.clearTimeout(snackTimer);
  snackTimer = window.setTimeout(() => el.classList.remove("open"), ms);
}
