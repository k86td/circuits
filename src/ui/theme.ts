/**
 * Thème dynamique Material 3 (« Material You ») : à partir d'une couleur source, d'une variante et d'un mode
 * clair / sombre, on génère le schéma complet de couleurs avec @material/material-color-utilities, on l'applique
 * en variables CSS `--md-sys-color-*` (utilisées par les composants @material/web et par notre feuille de style)
 * et on en dérive une palette pour les rendus canvas (circuit, icônes, oscilloscope).
 */

import {
  type DynamicScheme,
  Hct,
  MaterialDynamicColors,
  SchemeContent,
  SchemeExpressive,
  SchemeFidelity,
  SchemeFruitSalad,
  SchemeMonochrome,
  SchemeNeutral,
  SchemeRainbow,
  SchemeTonalSpot,
  SchemeVibrant,
  argbFromHex,
  hexFromArgb,
} from "@material/material-color-utilities";

export type ThemeMode = "system" | "light" | "dark";

export type ThemeVariant =
  | "tonalSpot"
  | "vibrant"
  | "expressive"
  | "fidelity"
  | "content"
  | "neutral"
  | "monochrome"
  | "fruitSalad"
  | "rainbow";

export interface ThemeSettings {
  mode: ThemeMode;
  /** Couleur source (hex « #rrggbb »). */
  seed: string;
  variant: ThemeVariant;
  /** Niveau de contraste, de −1 (minimum) à 1 (maximum) ; 0 = standard. */
  contrast: number;
}

export const VARIANT_LABELS: Record<ThemeVariant, string> = {
  tonalSpot: "Tonal (défaut)",
  vibrant: "Vif",
  expressive: "Expressif",
  fidelity: "Fidèle",
  content: "Contenu",
  neutral: "Neutre",
  monochrome: "Monochrome",
  fruitSalad: "Salade de fruits",
  rainbow: "Arc-en-ciel",
};

export const MODE_LABELS: Record<ThemeMode, { label: string; icon: string }> = {
  system: { label: "Système", icon: "brightness_auto" },
  light: { label: "Clair", icon: "light_mode" },
  dark: { label: "Sombre", icon: "dark_mode" },
};

/** Couleurs sources proposées dans le sélecteur de thème. */
export const PRESET_SEEDS: { hex: string; name: string }[] = [
  { hex: "#0ea5e9", name: "Ciel" },
  { hex: "#6750a4", name: "Violet Material" },
  { hex: "#2563eb", name: "Bleu" },
  { hex: "#0d9488", name: "Sarcelle" },
  { hex: "#16a34a", name: "Vert" },
  { hex: "#ca8a04", name: "Ambre" },
  { hex: "#ea580c", name: "Orange" },
  { hex: "#dc2626", name: "Rouge" },
  { hex: "#db2777", name: "Rose" },
  { hex: "#64748b", name: "Ardoise" },
];

const DEFAULTS: ThemeSettings = { mode: "system", seed: "#0ea5e9", variant: "tonalSpot", contrast: 0 };
const STORAGE_KEY = "circuits.theme.v1";

/** Couleurs dérivées du schéma pour les rendus canvas. */
export interface CanvasPalette {
  bg: string;
  grid: string;
  wire: string;
  body: string;
  label: string;
  reading: string;
  meter: string;
  select: string;
  hover: string;
  electron: string;
  electronConv: string;
  unconnected: string;
  voltageNeutral: string;
  voltagePos: string;
  voltageNeg: string;
  tooltipBg: string;
  tooltipBorder: string;
  tooltipText: string;
  scopeBg: string;
  scopeGrid: string;
  scopeZero: string;
  scopeText: string;
  scopeMuted: string;
  scopeLegendBg: string;
  scopeTraces: string[];
}

const TOKENS = [
  "background",
  "onBackground",
  "surface",
  "surfaceDim",
  "surfaceBright",
  "surfaceContainerLowest",
  "surfaceContainerLow",
  "surfaceContainer",
  "surfaceContainerHigh",
  "surfaceContainerHighest",
  "onSurface",
  "surfaceVariant",
  "onSurfaceVariant",
  "inverseSurface",
  "inverseOnSurface",
  "outline",
  "outlineVariant",
  "shadow",
  "scrim",
  "surfaceTint",
  "primary",
  "onPrimary",
  "primaryContainer",
  "onPrimaryContainer",
  "inversePrimary",
  "secondary",
  "onSecondary",
  "secondaryContainer",
  "onSecondaryContainer",
  "tertiary",
  "onTertiary",
  "tertiaryContainer",
  "onTertiaryContainer",
  "error",
  "onError",
  "errorContainer",
  "onErrorContainer",
  "primaryFixed",
  "primaryFixedDim",
  "onPrimaryFixed",
  "onPrimaryFixedVariant",
  "secondaryFixed",
  "secondaryFixedDim",
  "onSecondaryFixed",
  "onSecondaryFixedVariant",
  "tertiaryFixed",
  "tertiaryFixedDim",
  "onTertiaryFixed",
  "onTertiaryFixedVariant",
] as const;

type Token = (typeof TOKENS)[number];

const SCHEMES: Record<ThemeVariant, new (source: Hct, isDark: boolean, contrast: number) => DynamicScheme> = {
  tonalSpot: SchemeTonalSpot,
  vibrant: SchemeVibrant,
  expressive: SchemeExpressive,
  fidelity: SchemeFidelity,
  content: SchemeContent,
  neutral: SchemeNeutral,
  monochrome: SchemeMonochrome,
  fruitSalad: SchemeFruitSalad,
  rainbow: SchemeRainbow,
};

const DARK_TRACES = ["#facc15", "#22d3ee", "#f472b6", "#4ade80", "#fb923c", "#a78bfa", "#f87171", "#2dd4bf"];
const LIGHT_TRACES = ["#b45309", "#0e7490", "#be185d", "#15803d", "#c2410c", "#6d28d9", "#b91c1c", "#0f766e"];

function kebab(s: string): string {
  return s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

/** « #rrggbb » + alpha → « rgba(r,g,b,a) ». */
export function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

export function isHexColor(s: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(s);
}

export class ThemeManager {
  settings: ThemeSettings = { ...DEFAULTS };
  /** Mode effectivement appliqué (le mode « système » suit la préférence du navigateur). */
  isDark = true;
  colors: Record<Token, string> = {} as Record<Token, string>;
  canvas!: CanvasPalette;
  private listeners = new Set<() => void>();
  private media = window.matchMedia("(prefers-color-scheme: dark)");

  constructor() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as Partial<ThemeSettings>;
        if (saved.mode === "system" || saved.mode === "light" || saved.mode === "dark") this.settings.mode = saved.mode;
        if (typeof saved.seed === "string" && isHexColor(saved.seed)) this.settings.seed = saved.seed;
        if (typeof saved.variant === "string" && saved.variant in SCHEMES) this.settings.variant = saved.variant as ThemeVariant;
        if (typeof saved.contrast === "number" && Number.isFinite(saved.contrast)) this.settings.contrast = Math.max(-1, Math.min(1, saved.contrast));
      }
    } catch {
      /* ignore */
    }
    this.media.addEventListener("change", () => {
      if (this.settings.mode === "system") this.apply();
    });
    this.apply();
  }

  on(fn: () => void): void {
    this.listeners.add(fn);
  }

  set(patch: Partial<ThemeSettings>): void {
    Object.assign(this.settings, patch);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
    } catch {
      /* ignore */
    }
    this.apply();
  }

  /** Choisit une couleur source au hasard (teinte aléatoire, bien saturée). */
  randomSeed(): void {
    const hct = Hct.from(Math.random() * 360, 48 + Math.random() * 40, 50);
    this.set({ seed: hexFromArgb(hct.toInt()) });
  }

  /** Recalcule le schéma et l'applique au document. */
  apply(): void {
    const s = this.settings;
    this.isDark = s.mode === "dark" || (s.mode === "system" && this.media.matches);
    const Scheme = SCHEMES[s.variant] ?? SchemeTonalSpot;
    const scheme = new Scheme(Hct.fromInt(argbFromHex(s.seed)), this.isDark, s.contrast);
    const root = document.documentElement;
    for (const t of TOKENS) {
      const dc = MaterialDynamicColors[t];
      const hex = hexFromArgb(dc.getArgb(scheme));
      this.colors[t] = hex;
      root.style.setProperty(`--md-sys-color-${kebab(t)}`, hex);
    }
    root.style.colorScheme = this.isDark ? "dark" : "light";
    root.dataset.theme = this.isDark ? "dark" : "light";
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (meta) meta.content = this.colors.surfaceContainer;
    this.canvas = this.buildCanvasPalette();
    this.listeners.forEach((fn) => fn());
  }

  private buildCanvasPalette(): CanvasPalette {
    const c = this.colors;
    const dark = this.isDark;
    return {
      bg: c.surface,
      grid: withAlpha(c.onSurfaceVariant, dark ? 0.22 : 0.28),
      wire: c.onSurfaceVariant,
      body: c.onSurface,
      label: c.onSurfaceVariant,
      reading: c.primary,
      meter: c.tertiary,
      select: withAlpha(c.primary, 0.38),
      hover: withAlpha(c.primary, 0.2),
      electron: c.primary,
      electronConv: c.tertiary,
      unconnected: withAlpha(c.error, 0.85),
      voltageNeutral: c.outline,
      voltagePos: dark ? "#f87171" : "#dc2626",
      voltageNeg: dark ? "#60a5fa" : "#2563eb",
      tooltipBg: withAlpha(c.inverseSurface, 0.94),
      tooltipBorder: withAlpha(c.outline, 0.4),
      tooltipText: c.inverseOnSurface,
      scopeBg: dark ? c.surfaceContainerLowest : c.surfaceContainerLowest,
      scopeGrid: withAlpha(c.outlineVariant, dark ? 0.45 : 0.7),
      scopeZero: withAlpha(c.outline, 0.7),
      scopeText: c.onSurfaceVariant,
      scopeMuted: c.outline,
      scopeLegendBg: withAlpha(c.surfaceContainerLowest, 0.85),
      scopeTraces: dark ? DARK_TRACES : LIGHT_TRACES,
    };
  }
}

/** Instance unique : le thème est global à l'application. */
export const theme = new ThemeManager();
