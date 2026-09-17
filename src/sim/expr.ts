/**
 * Petit évaluateur d'expressions mathématiques de la variable t (temps en secondes) et des grandeurs d'autres
 * composants du circuit : i_R1 (courant dans R1), v_R1 (tension aux bornes de R1).
 * Exemples : "5*sin(2*pi*60*t)", "step(t-1e-3)*12", "pulse(t, 1m, 0.5)*5", "2*i_R1", "0.5 v_R2 + 1".
 * Les nombres acceptent les préfixes SI (1k, 100u, 2.2M, 1meg) ; la multiplication implicite est acceptée (2 i_R1).
 */

/** Grandeur d'un autre composant référencée par une expression. */
export interface QuantityRef {
  kind: "i" | "v";
  name: string;
}

/** Fournit la valeur d'une grandeur référencée (courant ou tension d'un composant nommé). */
export type QuantityCtx = (kind: "i" | "v", name: string) => number;

export type TimeFn = (t: number, ctx?: QuantityCtx) => number;

export interface CompiledExpr extends TimeFn {
  /** Grandeurs d'autres composants utilisées par l'expression (sans doublon). */
  refs: QuantityRef[];
}

type Tok =
  | { k: "num"; v: number }
  | { k: "id"; v: string }
  | { k: "op"; v: string }
  | { k: "("; }
  | { k: ")"; }
  | { k: ","; }
  | { k: "end" };

const PREFIX: Record<string, number> = {
  T: 1e12, G: 1e9, M: 1e6, meg: 1e6, Meg: 1e6, MEG: 1e6, k: 1e3, K: 1e3,
  m: 1e-3, u: 1e-6, µ: 1e-6, μ: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15,
};

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const s = src.replace(/,(?=\d)/g, ".");
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      const m = /^(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?(meg|Meg|MEG|[TGMkKmuµμnpf])?(?![A-Za-z_])/.exec(s.slice(i));
      if (!m) throw new Error(`Nombre invalide à la position ${i + 1}`);
      let v = parseFloat(m[1] + (m[2] ?? ""));
      if (m[3]) v *= PREFIX[m[3]];
      toks.push({ k: "num", v });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_π]/.test(ch)) {
      const m = /^[A-Za-z_π][A-Za-z_0-9]*/.exec(s.slice(i))!;
      toks.push({ k: "id", v: m[0] });
      i += m[0].length;
      continue;
    }
    if ("+-*/^%".includes(ch)) {
      toks.push({ k: "op", v: ch });
      i++;
      continue;
    }
    if (ch === "(") {
      toks.push({ k: "(" });
      i++;
      continue;
    }
    if (ch === ")") {
      toks.push({ k: ")" });
      i++;
      continue;
    }
    if (ch === ",") {
      toks.push({ k: "," });
      i++;
      continue;
    }
    throw new Error(`Caractère inattendu « ${ch} »`);
  }
  toks.push({ k: "end" });
  return toks;
}

const CONSTS: Record<string, number> = { pi: Math.PI, PI: Math.PI, π: Math.PI, e: Math.E, E: Math.E };

const FUNCS: Record<string, (...a: number[]) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  atan2: Math.atan2,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  exp: Math.exp,
  ln: Math.log,
  log: Math.log,
  log10: Math.log10,
  sqrt: Math.sqrt,
  abs: Math.abs,
  sign: Math.sign,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  min: Math.min,
  max: Math.max,
  pow: Math.pow,
  mod: (a, b) => a - b * Math.floor(a / b),
  /** step(x) = 0 si x < 0, sinon 1 (échelon unité). */
  step: (x) => (x < 0 ? 0 : 1),
  /** u(x) : alias de step. */
  u: (x) => (x < 0 ? 0 : 1),
  /** clamp(x, lo, hi). */
  clamp: (x, lo, hi) => Math.min(hi, Math.max(lo, x)),
  /** pulse(t, période, rapport cyclique=0.5) : 1 pendant la fraction « duty » de chaque période, sinon 0. */
  pulse: (t, T, duty = 0.5) => {
    const ph = t / T - Math.floor(t / T);
    return ph < duty ? 1 : 0;
  },
  /** square(t, f) : onde carrée ±1 de fréquence f. */
  square: (t, f) => {
    const ph = t * f - Math.floor(t * f);
    return ph < 0.5 ? 1 : -1;
  },
  /** tri(t, f) : onde triangulaire ±1. */
  tri: (t, f) => {
    const ph = t * f - Math.floor(t * f);
    return ph < 0.5 ? -1 + 4 * ph : 3 - 4 * ph;
  },
  /** saw(t, f) : dent de scie de -1 à 1. */
  saw: (t, f) => {
    const ph = t * f - Math.floor(t * f);
    return -1 + 2 * ph;
  },
  /** ramp(x) : 0 si x<0, sinon x. */
  ramp: (x) => (x < 0 ? 0 : x),
  /** expdecay(t, tau) : exp(-t/tau) pour t ≥ 0. */
  expdecay: (t, tau) => (t < 0 ? 1 : Math.exp(-t / tau)),
};

export const EXPR_HELP = [
  "Variable : t (secondes). Constantes : pi, e. Préfixes SI : 1k, 100u, 2.2M, 1meg.",
  "Opérateurs : + − * / ^ %",
  "Fonctions : sin cos tan exp ln log10 sqrt abs sign floor min max pow mod",
  "step(x) échelon · pulse(t, T, duty) · square(t, f) · tri(t, f) · saw(t, f) · ramp(x) · expdecay(t, tau)",
  "Exemples : 5*sin(2*pi*60*t) · 12*step(t-2m) · 5*pulse(t, 10m, 0.25) · 1k+500*sin(2*pi*t)",
  "Grandeurs d'autres composants : i_R1 (courant dans R1, dans le sens de sa flèche de référence), v_R1 (tension V+ − V−).",
  "Multiplication implicite acceptée : 2 i_R1 = 2*i_R1. Exemples : 2*i_R1 · 0.5 v_R2 + 1 · 100*i_R1^2",
];

type Node = (t: number, ctx?: QuantityCtx) => number;

class Parser {
  private pos = 0;
  readonly refs: QuantityRef[] = [];
  constructor(private toks: Tok[]) {}

  private peek(): Tok {
    return this.toks[this.pos];
  }
  private next(): Tok {
    return this.toks[this.pos++];
  }

  parse(): Node {
    const n = this.expr();
    if (this.peek().k !== "end") throw new Error("Expression incomplète ou parenthèse en trop");
    return n;
  }

  private expr(): Node {
    let left = this.term();
    for (;;) {
      const t = this.peek();
      if (t.k === "op" && (t.v === "+" || t.v === "-")) {
        this.next();
        const right = this.term();
        const l = left;
        left = t.v === "+" ? (x, c) => l(x, c) + right(x, c) : (x, c) => l(x, c) - right(x, c);
      } else return left;
    }
  }

  private term(): Node {
    let left = this.unary();
    for (;;) {
      const t = this.peek();
      if (t.k === "op" && (t.v === "*" || t.v === "/" || t.v === "%")) {
        this.next();
        const right = this.unary();
        const l = left;
        if (t.v === "*") left = (x, c) => l(x, c) * right(x, c);
        else if (t.v === "/") left = (x, c) => l(x, c) / right(x, c);
        else left = (x, c) => FUNCS.mod(l(x, c), right(x, c));
      } else if (t.k === "id" || t.k === "num" || t.k === "(") {
        // multiplication implicite : 2 i_R1, 3 sin(t), 2(t+1)
        const right = this.unary();
        const l = left;
        left = (x, c) => l(x, c) * right(x, c);
      } else return left;
    }
  }

  private unary(): Node {
    const t = this.peek();
    if (t.k === "op" && t.v === "-") {
      this.next();
      const u = this.unary();
      return (x, c) => -u(x, c);
    }
    if (t.k === "op" && t.v === "+") {
      this.next();
      return this.unary();
    }
    return this.power();
  }

  private power(): Node {
    const base = this.atom();
    const t = this.peek();
    if (t.k === "op" && t.v === "^") {
      this.next();
      const exp = this.unary();
      return (x, c) => Math.pow(base(x, c), exp(x, c));
    }
    return base;
  }

  private atom(): Node {
    const t = this.next();
    if (t.k === "num") {
      const v = t.v;
      return () => v;
    }
    if (t.k === "(") {
      const n = this.expr();
      if (this.next().k !== ")") throw new Error("Parenthèse fermante manquante");
      return n;
    }
    if (t.k === "id") {
      if (this.peek().k === "(") {
        this.next();
        const fn = FUNCS[t.v];
        if (!fn) throw new Error(`Fonction inconnue : ${t.v}`);
        const args: Node[] = [];
        if (this.peek().k !== ")") {
          for (;;) {
            args.push(this.expr());
            if (this.peek().k === ",") {
              this.next();
              continue;
            }
            break;
          }
        }
        if (this.next().k !== ")") throw new Error(`Parenthèse fermante manquante après ${t.v}(`);
        return (x, c) => fn(...args.map((a) => a(x, c)));
      }
      if (t.v === "t") return (x) => x;
      if (t.v in CONSTS) {
        const v = CONSTS[t.v];
        return () => v;
      }
      const ref = /^([iIvV])_(.+)$/.exec(t.v);
      if (ref) {
        const kind = ref[1].toLowerCase() as "i" | "v";
        const name = ref[2];
        if (!this.refs.some((r) => r.kind === kind && r.name === name)) this.refs.push({ kind, name });
        return (_x, c) => c?.(kind, name) ?? 0;
      }
      throw new Error(`Identifiant inconnu : ${t.v}`);
    }
    throw new Error("Expression invalide");
  }
}

const cache = new Map<string, CompiledExpr>();

/** Compile une expression. Lance une Error avec un message lisible si invalide. */
export function compileExpr(src: string): CompiledExpr {
  const key = src.trim();
  const hit = cache.get(key);
  if (hit) return hit;
  const parser = new Parser(tokenize(key));
  const node = parser.parse();
  const probe = node(0);
  if (Number.isNaN(probe)) throw new Error("L'expression ne donne pas un nombre");
  const fn = node as CompiledExpr;
  fn.refs = parser.refs;
  cache.set(key, fn);
  return fn;
}

/** Grandeurs d'autres composants référencées par une valeur (vide pour un nombre ou une expression invalide). */
export function exprRefs(v: number | string): QuantityRef[] {
  if (typeof v !== "string") return [];
  try {
    return compileExpr(v).refs;
  } catch {
    return [];
  }
}

/** true si l'expression est valide. */
export function isValidExpr(src: string): boolean {
  try {
    compileExpr(src);
    return true;
  } catch {
    return false;
  }
}

/** Évalue une valeur de propriété (nombre ou expression) à l'instant t, avec les grandeurs du circuit si fournies. */
export function evalValue(v: number | string, t: number, ctx?: QuantityCtx): number {
  if (typeof v === "number") return v;
  try {
    return compileExpr(v)(t, ctx);
  } catch {
    return NaN;
  }
}

/** true si la valeur dépend de t ou de grandeurs d'autres composants (elle varie pendant la simulation). */
export function isTimeDependent(v: number | string): boolean {
  return typeof v === "string" && (/\bt\b/.test(v) || exprRefs(v).length > 0);
}
