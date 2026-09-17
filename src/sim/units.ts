/** Formatage et analyse des valeurs avec préfixes SI (1k, 4.7u, 2.2M, ...). */

const PREFIXES: [number, string][] = [
  [1e12, "T"],
  [1e9, "G"],
  [1e6, "M"],
  [1e3, "k"],
  [1, ""],
  [1e-3, "m"],
  [1e-6, "µ"],
  [1e-9, "n"],
  [1e-12, "p"],
];

export function formatSI(value: number, unit = "", digits = 3): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs === 0) return `0 ${unit}`.trim();
  if (abs < 1e-15) return `0 ${unit}`.trim();
  let scale = 1e-12;
  let prefix = "p";
  for (const [s, p] of PREFIXES) {
    if (abs >= s * 0.9995) {
      scale = s;
      prefix = p;
      break;
    }
  }
  const scaled = value / scale;
  const mag = Math.abs(scaled);
  const decimals = mag >= 100 ? Math.max(0, digits - 3) : mag >= 10 ? Math.max(0, digits - 2) : Math.max(0, digits - 1);
  let text = scaled.toFixed(decimals);
  if (text.includes(".")) text = text.replace(/0+$/, "").replace(/\.$/, "");
  return `${text} ${prefix}${unit}`.trim();
}

const PARSE_PREFIX: Record<string, number> = {
  T: 1e12,
  G: 1e9,
  M: 1e6,
  meg: 1e6,
  Meg: 1e6,
  MEG: 1e6,
  k: 1e3,
  K: 1e3,
  m: 1e-3,
  u: 1e-6,
  µ: 1e-6,
  μ: 1e-6,
  n: 1e-9,
  p: 1e-12,
};

/** Analyse "4.7k", "100u", "2,2 M", "1e-6", "10 mA". Retourne null si invalide. */
export function parseSI(text: string): number | null {
  const cleaned = text.trim().replace(",", ".").replace(/\s+/g, "");
  const m = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)(meg|Meg|MEG|[TGMkKmuµμnp])?[a-zA-ZΩ°]*$/.exec(cleaned);
  if (!m) return null;
  const base = parseFloat(m[1]);
  if (!Number.isFinite(base)) return null;
  const mult = m[2] ? PARSE_PREFIX[m[2]] : 1;
  return base * mult;
}
