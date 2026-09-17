/** Circuits d'exemple. */

import { type Circuit, type ComponentType, type Rot, type Vec, autoName, createComponent, createWire } from "./model";
import { normalizeWires } from "./netlist";

class Builder {
  circuit: Circuit = { components: [], wires: [] };

  add(type: ComponentType, x: number, y: number, rot: Rot = 0, props: Record<string, number> = {}, closed?: boolean) {
    const c = createComponent(type, { x, y }, rot);
    c.name = autoName(this.circuit, type);
    Object.assign(c.props, props);
    if (closed !== undefined) c.closed = closed;
    this.circuit.components.push(c);
    return c;
  }

  /** Trace une suite de fils passant par les points donnés. */
  path(...pts: [number, number][]) {
    for (let i = 0; i + 1 < pts.length; i++) {
      const a: Vec = { x: pts[i][0], y: pts[i][1] };
      const b: Vec = { x: pts[i + 1][0], y: pts[i + 1][1] };
      this.circuit.wires.push(createWire(a, b));
    }
  }

  done(): Circuit {
    normalizeWires(this.circuit);
    return this.circuit;
  }
}

export interface Example {
  id: string;
  name: string;
  build: () => Circuit;
}

export const EXAMPLES: Example[] = [
  {
    id: "divider",
    name: "Diviseur de tension",
    build: () => {
      const b = new Builder();
      b.add("battery", 0, 3, 1, { V: 9 });
      b.add("resistor", 6, 0, 0, { R: 1000 });
      b.add("resistor", 12, 3, 1, { R: 2000 });
      b.add("voltmeter", 18, 3, 1);
      b.add("ground", 6, 7);
      b.path([0, 1], [0, 0], [4, 0]);
      b.path([8, 0], [12, 0], [12, 1]);
      b.path([12, 5], [12, 6], [0, 6], [0, 5]);
      b.path([12, 1], [18, 1]);
      b.path([12, 5], [18, 5]);
      return b.done();
    },
  },
  {
    id: "rc",
    name: "Charge d'un condensateur (RC)",
    build: () => {
      const b = new Builder();
      b.add("battery", 0, 3, 1, { V: 5 });
      b.add("switch", 4, 0, 0, {}, false);
      b.add("resistor", 10, 0, 0, { R: 1000 });
      b.add("capacitor", 14, 3, 1, { C: 100e-6 });
      b.add("voltmeter", 20, 3, 1);
      b.add("ground", 7, 7);
      b.path([0, 1], [0, 0], [2, 0]);
      b.path([6, 0], [8, 0]);
      b.path([12, 0], [14, 0], [14, 1]);
      b.path([14, 5], [14, 6], [0, 6], [0, 5]);
      b.path([14, 1], [20, 1]);
      b.path([14, 5], [20, 5]);
      return b.done();
    },
  },
  {
    id: "led",
    name: "DEL avec résistance de limitation",
    build: () => {
      const b = new Builder();
      b.add("battery", 0, 3, 1, { V: 5 });
      b.add("resistor", 6, 0, 0, { R: 220 });
      b.add("ammeter", 12, 0, 0);
      b.add("led", 16, 3, 1);
      b.add("ground", 8, 7);
      b.path([0, 1], [0, 0], [4, 0]);
      b.path([8, 0], [10, 0]);
      b.path([14, 0], [16, 0], [16, 1]);
      b.path([16, 5], [16, 6], [0, 6], [0, 5]);
      return b.done();
    },
  },
  {
    id: "rl",
    name: "Établissement du courant (RL)",
    build: () => {
      const b = new Builder();
      b.add("battery", 0, 3, 1, { V: 12 });
      b.add("switch", 4, 0, 0, {}, false);
      b.add("resistor", 10, 0, 0, { R: 10 });
      b.add("inductor", 14, 3, 1, { L: 1 });
      b.add("ammeter", 7, 6, 2);
      b.add("ground", 3, 7);
      b.path([0, 1], [0, 0], [2, 0]);
      b.path([6, 0], [8, 0]);
      b.path([12, 0], [14, 0], [14, 1]);
      b.path([14, 5], [14, 6], [9, 6]);
      b.path([5, 6], [0, 6], [0, 5]);
      return b.done();
    },
  },
  {
    id: "rlc",
    name: "RLC série en régime sinusoïdal",
    build: () => {
      const b = new Builder();
      b.add("acsource", 0, 3, 1, { A: 5, f: 60 });
      b.add("resistor", 6, 0, 0, { R: 100 });
      b.add("inductor", 12, 0, 0, { L: 0.2 });
      b.add("capacitor", 16, 3, 1, { C: 47e-6 });
      b.add("ground", 8, 7);
      b.path([0, 1], [0, 0], [4, 0]);
      b.path([8, 0], [10, 0]);
      b.path([14, 0], [16, 0], [16, 1]);
      b.path([16, 5], [16, 6], [0, 6], [0, 5]);
      return b.done();
    },
  },
  {
    id: "parallel",
    name: "Résistances en parallèle",
    build: () => {
      const b = new Builder();
      b.add("battery", 0, 4, 1, { V: 12 });
      b.add("ammeter", 4, 0, 0);
      b.add("resistor", 10, 4, 1, { R: 100 });
      b.add("resistor", 17, 4, 1, { R: 200 });
      b.add("lamp", 24, 4, 1, { R: 48, Pnom: 3 });
      b.add("ground", 4, 9);
      b.path([0, 2], [0, 0], [2, 0]);
      b.path([6, 0], [24, 0]);
      b.path([10, 0], [10, 2]);
      b.path([17, 0], [17, 2]);
      b.path([24, 0], [24, 2]);
      b.path([0, 6], [0, 8], [24, 8], [24, 6]);
      b.path([10, 6], [10, 8]);
      b.path([17, 6], [17, 8]);
      return b.done();
    },
  },
  {
    id: "empty",
    name: "Circuit vide",
    build: () => ({ components: [], wires: [] }),
  },
];
