/** Modèle de données du circuit : composants, fils, définitions. */

export interface Vec {
  x: number;
  y: number;
}

export type Rot = 0 | 1 | 2 | 3;

export type ComponentType =
  | "battery"
  | "acsource"
  | "vfunc"
  | "currentsource"
  | "ifunc"
  | "vcvs"
  | "vccs"
  | "ccvs"
  | "cccs"
  | "resistor"
  | "capacitor"
  | "inductor"
  | "diode"
  | "led"
  | "lamp"
  | "switch"
  | "ground"
  | "voltmeter"
  | "ammeter";

export interface Component {
  id: string;
  type: ComponentType;
  /** Nom affiché (R1, C2, ...). */
  name?: string;
  /** Centre du composant, en unités de grille. */
  pos: Vec;
  /** Rotation par pas de 90° (sens horaire). */
  rot: Rot;
  /** Valeurs numériques, ou expressions de t (ex. "5*sin(2*pi*60*t)"). */
  props: Record<string, PropValue>;
  /** État de l'interrupteur. */
  closed?: boolean;
}

export interface Wire {
  id: string;
  a: Vec;
  b: Vec;
}

export interface Circuit {
  components: Component[];
  wires: Wire[];
}

export type PropValue = number | string;

export interface PropDef {
  key: string;
  label: string;
  unit: string;
  default: PropValue;
  min?: number;
  /** Si false, la valeur doit être un nombre constant. */
  allowExpr?: boolean;
}

export interface ComponentDef {
  type: ComponentType;
  label: string;
  short: string;
  /** Terminaux en coordonnées locales (unités de grille), rotation 0. */
  terminals: Vec[];
  props: PropDef[];
  /** Nom des terminaux (pour l'affichage). */
  terminalNames?: string[];
  description: string;
  category: "sources" | "dependent" | "passive" | "semi" | "misc" | "meters";
}

const FOUR = [
  { x: 2, y: -1 },
  { x: 2, y: 1 },
  { x: -2, y: -1 },
  { x: -2, y: 1 },
];
const DEP_NAMES = ["sortie +", "sortie −", "commande +", "commande −"];

const TWO = [
  { x: -2, y: 0 },
  { x: 2, y: 0 },
];

export const DEFS: Record<ComponentType, ComponentDef> = {
  battery: {
    type: "battery",
    label: "Source de tension (CC)",
    short: "V",
    terminals: TWO,
    terminalNames: ["+", "−"],
    props: [{ key: "V", label: "Tension", unit: "V", default: 9 }],
    description: "Pile / source de tension continue idéale. Le + est du côté de la grande barre.",
    category: "sources",
  },
  acsource: {
    type: "acsource",
    label: "Source de tension (CA)",
    short: "~",
    terminals: TWO,
    terminalNames: ["+", "−"],
    props: [
      { key: "A", label: "Amplitude", unit: "V", default: 5 },
      { key: "f", label: "Fréquence", unit: "Hz", default: 60, min: 0 },
      { key: "phi", label: "Phase", unit: "°", default: 0 },
      { key: "off", label: "Décalage", unit: "V", default: 0 },
    ],
    description: "v(t) = A·sin(2πft + φ) + décalage.",
    category: "sources",
  },
  currentsource: {
    type: "currentsource",
    label: "Source de courant",
    short: "I",
    terminals: TWO,
    props: [{ key: "I", label: "Courant", unit: "A", default: 0.01 }],
    description: "Impose un courant constant dans le sens de la flèche.",
    category: "sources",
  },
  vfunc: {
    type: "vfunc",
    label: "Source de tension v(t)",
    short: "v(t)",
    terminals: TWO,
    terminalNames: ["+", "−"],
    props: [{ key: "V", label: "v(t)", unit: "V", default: "5*square(t, 100)" }],
    description: "Tension définie par une fonction du temps (échelon, impulsion, carré, triangle…).",
    category: "sources",
  },
  ifunc: {
    type: "ifunc",
    label: "Source de courant i(t)",
    short: "i(t)",
    terminals: TWO,
    props: [{ key: "I", label: "i(t)", unit: "A", default: "10m*sin(2*pi*50*t)" }],
    description: "Courant défini par une fonction du temps, dans le sens de la flèche.",
    category: "sources",
  },
  vcvs: {
    type: "vcvs",
    label: "Source de tension commandée en tension (VCVS)",
    short: "E",
    terminals: FOUR,
    terminalNames: DEP_NAMES,
    props: [{ key: "gain", label: "Gain E (V/V)", unit: "", default: 2 }],
    description: "v_sortie = E · v_commande. La commande ne consomme aucun courant.",
    category: "dependent",
  },
  vccs: {
    type: "vccs",
    label: "Source de courant commandée en tension (VCCS)",
    short: "G",
    terminals: FOUR,
    terminalNames: DEP_NAMES,
    props: [{ key: "gain", label: "Transconductance G (A/V)", unit: "S", default: 0.01 }],
    description: "i_sortie = G · v_commande (le courant sort par la borne sortie −).",
    category: "dependent",
  },
  ccvs: {
    type: "ccvs",
    label: "Source de tension commandée en courant (CCVS)",
    short: "H",
    terminals: FOUR,
    terminalNames: DEP_NAMES,
    props: [{ key: "gain", label: "Transrésistance H (V/A)", unit: "Ω", default: 100 }],
    description: "v_sortie = H · i_commande. La commande est un court-circuit (à brancher en série).",
    category: "dependent",
  },
  cccs: {
    type: "cccs",
    label: "Source de courant commandée en courant (CCCS)",
    short: "F",
    terminals: FOUR,
    terminalNames: DEP_NAMES,
    props: [{ key: "gain", label: "Gain F (A/A)", unit: "", default: 10 }],
    description: "i_sortie = F · i_commande. La commande est un court-circuit (à brancher en série).",
    category: "dependent",
  },
  resistor: {
    type: "resistor",
    label: "Résistance",
    short: "R",
    terminals: TWO,
    props: [{ key: "R", label: "Résistance", unit: "Ω", default: 1000, min: 1e-6 }],
    description: "Loi d'Ohm : V = R·I.",
    category: "passive",
  },
  capacitor: {
    type: "capacitor",
    label: "Condensateur",
    short: "C",
    terminals: TWO,
    props: [{ key: "C", label: "Capacité", unit: "F", default: 100e-6, min: 1e-15 }],
    description: "i = C·dv/dt. Se charge et se décharge à travers les résistances.",
    category: "passive",
  },
  inductor: {
    type: "inductor",
    label: "Bobine (inductance)",
    short: "L",
    terminals: TWO,
    props: [{ key: "L", label: "Inductance", unit: "H", default: 0.1, min: 1e-12 }],
    description: "v = L·di/dt. S'oppose aux variations de courant.",
    category: "passive",
  },
  diode: {
    type: "diode",
    label: "Diode",
    short: "D",
    terminals: TWO,
    terminalNames: ["anode", "cathode"],
    props: [
      { key: "Is", label: "Courant de saturation", unit: "A", default: 1e-14, min: 1e-30 },
      { key: "n", label: "Facteur d'idéalité", unit: "", default: 1, min: 0.1 },
    ],
    description: "Modèle de Shockley : conduit de l'anode vers la cathode (~0,7 V).",
    category: "semi",
  },
  led: {
    type: "led",
    label: "DEL (LED)",
    short: "DEL",
    terminals: TWO,
    terminalNames: ["anode", "cathode"],
    props: [
      { key: "Is", label: "Courant de saturation", unit: "A", default: 1e-18, min: 1e-30 },
      { key: "n", label: "Facteur d'idéalité", unit: "", default: 2, min: 0.1 },
      { key: "Inom", label: "Courant nominal", unit: "A", default: 0.02, min: 1e-6 },
    ],
    description: "Diode électroluminescente (~1,8 V). L'intensité lumineuse suit le courant.",
    category: "semi",
  },
  lamp: {
    type: "lamp",
    label: "Ampoule",
    short: "Lampe",
    terminals: TWO,
    props: [
      { key: "R", label: "Résistance", unit: "Ω", default: 50, min: 1e-6 },
      { key: "Pnom", label: "Puissance nominale", unit: "W", default: 3, min: 1e-6 },
    ],
    description: "Résistance qui brille selon la puissance dissipée.",
    category: "misc",
  },
  switch: {
    type: "switch",
    label: "Interrupteur",
    short: "SW",
    terminals: TWO,
    props: [],
    description: "Cliquer dessus pour ouvrir / fermer.",
    category: "misc",
  },
  ground: {
    type: "ground",
    label: "Masse (0 V)",
    short: "GND",
    terminals: [{ x: 0, y: -1 }],
    props: [],
    description: "Référence de tension. Sans masse, le premier nœud est pris comme référence.",
    category: "misc",
  },
  voltmeter: {
    type: "voltmeter",
    label: "Voltmètre",
    short: "V?",
    terminals: TWO,
    terminalNames: ["+", "−"],
    props: [{ key: "R", label: "Résistance interne", unit: "Ω", default: 10e6, min: 1 }],
    description: "Se branche en parallèle. Affiche V(+) − V(−).",
    category: "meters",
  },
  ammeter: {
    type: "ammeter",
    label: "Ampèremètre",
    short: "A?",
    terminals: TWO,
    terminalNames: ["+", "−"],
    props: [],
    description: "Se branche en série. Affiche le courant entrant par le +.",
    category: "meters",
  },
};

/** Ordre d'affichage dans la palette. */
export const PALETTE_ORDER: ComponentType[] = [
  "battery",
  "acsource",
  "vfunc",
  "currentsource",
  "ifunc",
  "vcvs",
  "vccs",
  "ccvs",
  "cccs",
  "resistor",
  "capacitor",
  "inductor",
  "diode",
  "led",
  "lamp",
  "switch",
  "ground",
  "voltmeter",
  "ammeter",
];

export function rotateVec(v: Vec, rot: Rot): Vec {
  let { x, y } = v;
  for (let i = 0; i < rot; i++) {
    const nx = -y;
    const ny = x;
    x = nx;
    y = ny;
  }
  return { x, y };
}

/** Positions absolues (unités de grille) des terminaux d'un composant. */
export function terminalPositions(c: Component): Vec[] {
  return DEFS[c.type].terminals.map((t) => {
    const r = rotateVec(t, c.rot);
    return { x: c.pos.x + r.x, y: c.pos.y + r.y };
  });
}

export function pointKey(p: Vec): string {
  return `${p.x},${p.y}`;
}

export function samePoint(a: Vec, b: Vec): boolean {
  return a.x === b.x && a.y === b.y;
}

let idCounter = 0;
export function newId(prefix: string): string {
  idCounter += 1;
  return `${prefix}${Date.now().toString(36)}${idCounter.toString(36)}`;
}

export function defaultProps(type: ComponentType): Record<string, PropValue> {
  const out: Record<string, PropValue> = {};
  for (const p of DEFS[type].props) out[p.key] = p.default;
  return out;
}

export function createComponent(type: ComponentType, pos: Vec, rot: Rot = 0): Component {
  const c: Component = { id: newId("c"), type, pos: { ...pos }, rot, props: defaultProps(type) };
  if (type === "switch") c.closed = false;
  return c;
}

/** Génère un nom unique du style R1, C2 pour un nouveau composant. */
export function autoName(circuit: Circuit, type: ComponentType): string {
  const prefix = DEFS[type].short.replace(/[^A-Za-z]/g, "") || "X";
  const used = new Set(circuit.components.map((c) => c.name));
  for (let k = 1; ; k++) {
    const n = `${prefix}${k}`;
    if (!used.has(n)) return n;
  }
}

export function displayName(c: Component): string {
  return c.name ?? DEFS[c.type].short;
}

export function createWire(a: Vec, b: Vec): Wire {
  return { id: newId("w"), a: { ...a }, b: { ...b } };
}

export function cloneCircuit(c: Circuit): Circuit {
  return JSON.parse(JSON.stringify(c));
}

/** Nombre de terminaux "de commande" (sources dépendantes : terminaux 2 et 3). */
export function isDependentSource(type: ComponentType): boolean {
  return type === "vcvs" || type === "vccs" || type === "ccvs" || type === "cccs";
}

/** Valeur "principale" d'un composant pour l'étiquette (ex. 1 kΩ). */
export function mainValue(c: Component): { value: PropValue; unit: string } | null {
  switch (c.type) {
    case "battery":
    case "vfunc":
      return { value: c.props.V, unit: "V" };
    case "acsource":
      return { value: c.props.A, unit: "V" };
    case "currentsource":
    case "ifunc":
      return { value: c.props.I, unit: "A" };
    case "vcvs":
    case "vccs":
    case "ccvs":
    case "cccs":
      return { value: c.props.gain, unit: DEFS[c.type].props[0].unit };
    case "resistor":
    case "lamp":
      return { value: c.props.R, unit: "Ω" };
    case "capacitor":
      return { value: c.props.C, unit: "F" };
    case "inductor":
      return { value: c.props.L, unit: "H" };
    default:
      return null;
  }
}
