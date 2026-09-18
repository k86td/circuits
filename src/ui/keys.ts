/**
 * Raccourcis clavier façon vim : des commandes déclenchées par des séquences de touches (une touche, ou une
 * touche « maître » suivie d'un sous-menu), un panneau « which-key » qui liste les suites possibles après un
 * préfixe, et une palette de commandes (:) pour retrouver n'importe quelle action au clavier.
 */

export interface Command {
  id: string;
  label: string;
  /** Séquences de touches équivalentes, ex. [["r"], ["Space", "e", "r"]]. Voir keyToken pour la notation. */
  keys: string[][];
  category: string;
  run: () => void;
  /** Disponible ? Une commande indisponible est ignorée par le clavier et absente de la palette. */
  when?: () => boolean;
  /** Ne pas lister dans l'aide ni dans la palette. */
  hidden?: boolean;
  /** Commande d'édition que `.` peut répéter. */
  repeatable?: boolean;
}

export interface PaletteItem {
  label: string;
  hint?: string;
  run: () => void;
}

/**
 * Jeton d'une touche : caractère tel que tapé (`r`, `R`, `?`), ou nom (`Space`, `Enter`, `Escape`, `Tab`,
 * `ArrowLeft`…) ; `C-` pour Ctrl / Cmd, `A-` pour Alt, `S-` pour Maj sur une touche non imprimable.
 */
export function keyToken(e: KeyboardEvent): string | null {
  const k = e.key;
  if (k === "Shift" || k === "Control" || k === "Alt" || k === "Meta" || k === "AltGraph" || k === "Dead" || k === "Unidentified") return null;
  const ctrl = e.ctrlKey || e.metaKey;
  let name = k === " " ? "Space" : k;
  if (k.length === 1 && (ctrl || e.altKey)) name = k.toLowerCase();
  let mods = "";
  if (ctrl) mods += "C-";
  if (e.altKey) mods += "A-";
  if (e.shiftKey && (k.length !== 1 || ctrl || e.altKey)) mods += "S-";
  return mods + name;
}

const TOKEN_LABELS: Record<string, string> = {
  Space: "Espace",
  Enter: "Entrée",
  Escape: "Échap",
  Tab: "Tab",
  Delete: "Suppr",
  Backspace: "⌫",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
};

/** Libellé lisible d'un jeton (`C-z` → `Ctrl+Z`). */
export function tokenLabel(tok: string): string {
  let t = tok;
  let out = "";
  for (;;) {
    if (t.startsWith("C-")) {
      out += "Ctrl+";
      t = t.slice(2);
    } else if (t.startsWith("A-")) {
      out += "Alt+";
      t = t.slice(2);
    } else if (t.startsWith("S-")) {
      out += "Maj+";
      t = t.slice(2);
    } else break;
  }
  const base = TOKEN_LABELS[t] ?? (out && t.length === 1 ? t.toUpperCase() : t);
  return out + base;
}

export function formatKeys(seq: string[]): string {
  return seq.map(tokenLabel).join(" ");
}

function startsWith(seq: string[], prefix: string[]): boolean {
  return prefix.length <= seq.length && prefix.every((t, k) => seq[k] === t);
}

function sameSeq(a: string[], b: string[]): boolean {
  return a.length === b.length && startsWith(a, b);
}

/** Ordre d'affichage des touches dans le panneau : minuscules, majuscules, chiffres, puis le reste. */
function tokenOrder(t: string): string {
  const rank = /^[a-z]$/.test(t) ? 0 : /^[A-Z]$/.test(t) ? 1 : /^[0-9]$/.test(t) ? 2 : 3;
  return `${rank}${t.toLowerCase()}${t}`;
}

/** Forme sans accents ni majuscules, pour le filtrage de la palette. */
function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

export class Keymap {
  commands: Command[] = [];
  /** Libellés des préfixes (sous-menus), ex. ["Space", "a"] → « Ajouter un composant ». */
  private groups: { keys: string[]; label: string }[] = [];
  pending: string[] = [];
  private popup: HTMLElement;
  private palette: HTMLElement;
  private paletteInput: HTMLInputElement;
  private paletteList: HTMLElement;
  private paletteItems: PaletteItem[] = [];
  private paletteIndex = 0;
  private extraPaletteItems: () => PaletteItem[] = () => [];
  private listeners = new Set<() => void>();
  /** Dernière commande répétable exécutée (pour `.`). */
  lastRepeatable: Command | null = null;

  constructor(host: HTMLElement) {
    this.popup = document.createElement("div");
    this.popup.id = "whichkey";
    this.popup.hidden = true;
    host.appendChild(this.popup);

    this.palette = document.createElement("div");
    this.palette.id = "cmdpal";
    this.palette.hidden = true;
    this.palette.innerHTML = `<div class="cmdpal-box"><input type="text" spellcheck="false" autocomplete="off" placeholder="Commande ou composant… (Échap pour fermer)" aria-label="Palette de commandes" /><ul role="listbox"></ul></div>`;
    host.appendChild(this.palette);
    this.paletteInput = this.palette.querySelector("input")!;
    this.paletteList = this.palette.querySelector("ul")!;
    this.paletteInput.addEventListener("input", () => this.filterPalette());
    this.paletteInput.addEventListener("keydown", (e) => this.onPaletteKey(e));
    this.palette.addEventListener("pointerdown", (e) => {
      if (e.target === this.palette) this.closePalette();
    });
  }

  /** Appelé quand l'état (préfixe en attente, palette) change. */
  on(fn: () => void): void {
    this.listeners.add(fn);
  }

  private notify(): void {
    this.listeners.forEach((fn) => fn());
  }

  add(...cmds: Command[]): void {
    for (const c of cmds) {
      if (this.commands.some((x) => x.id === c.id)) throw new Error(`Commande en double : ${c.id}`);
      this.commands.push(c);
    }
  }

  group(keys: string[], label: string): void {
    this.groups.push({ keys, label });
  }

  /** Fournit des entrées supplémentaires à la palette (ex. « Sélectionner R1 »). */
  setPaletteExtras(fn: () => PaletteItem[]): void {
    this.extraPaletteItems = fn;
  }

  get(id: string): Command {
    const c = this.commands.find((x) => x.id === id);
    if (!c) throw new Error(`Commande inconnue : ${id}`);
    return c;
  }

  run(id: string): void {
    const c = this.get(id);
    if (this.available(c)) this.execute(c);
  }

  private execute(c: Command): void {
    if (c.repeatable) this.lastRepeatable = c;
    c.run();
  }

  /** Rejoue la dernière commande répétable (vim : `.`). */
  repeatLast(): void {
    const c = this.lastRepeatable;
    if (c && this.available(c)) c.run();
  }

  available(c: Command): boolean {
    return !c.when || c.when();
  }

  /** Raccourcis d'une commande, en clair (« r ou Espace e r »). */
  keysOf(id: string): string {
    return this.get(id)
      .keys.map(formatKeys)
      .join(" ou ");
  }

  get pendingLabel(): string {
    return this.pending.length ? formatKeys(this.pending) : "";
  }

  isPaletteOpen(): boolean {
    return !this.palette.hidden;
  }

  /** Traite une touche ; renvoie vrai si elle a été consommée (commande lancée, préfixe en attente ou séquence annulée). */
  handle(e: KeyboardEvent): boolean {
    const tok = keyToken(e);
    if (!tok) return false;
    if (tok === "Escape" && this.pending.length > 0) {
      this.cancel();
      return true;
    }
    const seq = [...this.pending, tok];
    const exact = this.commands.find((c) => this.available(c) && c.keys.some((k) => sameSeq(k, seq)));
    const isPrefix = this.commands.some((c) => this.available(c) && c.keys.some((k) => k.length > seq.length && startsWith(k, seq)));
    if (exact && !isPrefix) {
      this.pending = [];
      this.hidePopup();
      this.execute(exact);
      this.notify();
      return true;
    }
    if (isPrefix) {
      this.pending = seq;
      this.showPopup();
      this.notify();
      return true;
    }
    if (this.pending.length > 0) {
      this.cancel();
      return true;
    }
    return false;
  }

  cancel(): void {
    this.pending = [];
    this.hidePopup();
    this.notify();
  }

  // ---- Panneau which-key ----

  private showPopup(): void {
    const prefix = this.pending;
    const items = new Map<string, { label: string; group: boolean }>();
    for (const c of this.commands) {
      if (!this.available(c)) continue;
      for (const k of c.keys) {
        if (k.length <= prefix.length || !startsWith(k, prefix)) continue;
        const next = k[prefix.length];
        const isGroup = k.length > prefix.length + 1;
        const existing = items.get(next);
        if (existing && !isGroup) continue;
        if (isGroup) {
          const g = this.groups.find((x) => sameSeq(x.keys, [...prefix, next]));
          items.set(next, { label: `+${g?.label ?? "…"}`, group: true });
        } else if (!existing) items.set(next, { label: c.label, group: false });
      }
    }
    const g = this.groups.find((x) => sameSeq(x.keys, prefix));
    const head = `<div class="wk-head"><kbd>${formatKeys(prefix)}</kbd><span>${g?.label ?? ""}</span><span class="wk-esc">Échap pour annuler</span></div>`;
    const rows = [...items.entries()]
      .sort((a, b) => tokenOrder(a[0]).localeCompare(tokenOrder(b[0])))
      .map(([tok, it]) => `<div class="wk-item${it.group ? " group" : ""}"><kbd>${tokenLabel(tok)}</kbd><span>${it.label}</span></div>`)
      .join("");
    this.popup.innerHTML = `${head}<div class="wk-grid">${rows}</div>`;
    this.popup.hidden = false;
  }

  private hidePopup(): void {
    this.popup.hidden = true;
  }

  // ---- Palette de commandes ----

  openPalette(initial = ""): void {
    this.cancel();
    this.paletteInput.value = initial;
    this.palette.hidden = false;
    this.filterPalette();
    this.paletteInput.focus();
    this.notify();
  }

  closePalette(): void {
    if (this.palette.hidden) return;
    this.palette.hidden = true;
    this.paletteInput.blur();
    this.notify();
  }

  private allPaletteItems(): PaletteItem[] {
    const cmds: PaletteItem[] = this.commands
      .filter((c) => !c.hidden && this.available(c))
      .map((c) => ({ label: `${c.category} › ${c.label}`, hint: c.keys.map(formatKeys).join("  ·  "), run: () => this.execute(c) }));
    return [...this.extraPaletteItems(), ...cmds];
  }

  private filterPalette(): void {
    const q = fold(this.paletteInput.value.trim());
    const words = q.split(/\s+/).filter(Boolean);
    this.paletteItems = this.allPaletteItems().filter((it) => {
      const text = fold(`${it.label} ${it.hint ?? ""}`);
      return words.every((w) => text.includes(w));
    });
    this.paletteIndex = 0;
    this.renderPalette();
  }

  private renderPalette(): void {
    this.paletteList.innerHTML = "";
    this.paletteItems.slice(0, 40).forEach((it, k) => {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      li.classList.toggle("active", k === this.paletteIndex);
      const label = document.createElement("span");
      label.textContent = it.label;
      li.appendChild(label);
      if (it.hint) {
        const hint = document.createElement("kbd");
        hint.textContent = it.hint;
        li.appendChild(hint);
      }
      li.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        this.closePalette();
        it.run();
      });
      this.paletteList.appendChild(li);
    });
    if (this.paletteItems.length === 0) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "Aucune commande ne correspond.";
      this.paletteList.appendChild(li);
    }
    this.paletteList.querySelector(".active")?.scrollIntoView({ block: "nearest" });
  }

  private onPaletteKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.closePalette();
    } else if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey) || (e.key === "Tab" && !e.shiftKey)) {
      e.preventDefault();
      this.paletteIndex = Math.min(this.paletteItems.length - 1, this.paletteIndex + 1);
      this.renderPalette();
    } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey) || (e.key === "Tab" && e.shiftKey)) {
      e.preventDefault();
      this.paletteIndex = Math.max(0, this.paletteIndex - 1);
      this.renderPalette();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = this.paletteItems[this.paletteIndex];
      this.closePalette();
      it?.run();
    }
  }

  // ---- Aide ----

  /** Tableau des raccourcis, par catégorie, à insérer dans le dialogue d'aide. */
  renderHelp(root: HTMLElement): void {
    root.innerHTML = "";
    const cats = new Map<string, Command[]>();
    for (const c of this.commands) {
      if (c.hidden) continue;
      if (!cats.has(c.category)) cats.set(c.category, []);
      cats.get(c.category)!.push(c);
    }
    for (const [cat, cmds] of cats) {
      const h = document.createElement("h4");
      h.textContent = cat;
      root.appendChild(h);
      const table = document.createElement("table");
      table.className = "keys";
      for (const c of cmds) {
        const tr = document.createElement("tr");
        const td1 = document.createElement("td");
        c.keys.forEach((k, i) => {
          if (i > 0) td1.append(" ou ");
          const kbd = document.createElement("kbd");
          kbd.textContent = formatKeys(k);
          td1.appendChild(kbd);
        });
        const td2 = document.createElement("td");
        td2.textContent = c.label;
        tr.append(td1, td2);
        table.appendChild(tr);
      }
      root.appendChild(table);
    }
  }
}
