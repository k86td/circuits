import { describe, expect, it } from "vitest";
import { EXAMPLES } from "./examples";
import { type Circuit, createComponent, createWire } from "./model";
import { normalizeWires } from "./netlist";
import { Simulator } from "./solver";

function example(id: string): Circuit {
  return EXAMPLES.find((e) => e.id === id)!.build();
}

function byType(sim: Simulator, type: string, n = 0) {
  const c = sim.circuit.components.filter((c) => c.type === type)[n];
  return { c, r: sim.results.get(c.id)! };
}

describe("Simulator", () => {
  it("résout un diviseur de tension", () => {
    const sim = new Simulator(example("divider"));
    expect(sim.error).toBeNull();
    const r2 = byType(sim, "resistor", 1).r;
    expect(r2.v).toBeCloseTo(6, 3);
    expect(byType(sim, "resistor", 0).r.i).toBeCloseTo(0.003, 6);
    expect(byType(sim, "voltmeter").r.v).toBeCloseTo(6, 3);
    // la pile fournit de la puissance
    expect(byType(sim, "battery").r.p).toBeLessThan(0);
  });

  it("répartit les courants dans les fils", () => {
    const sim = new Simulator(example("divider"));
    sim.computeWireCurrents();
    const currents = [...sim.wireCurrents.values()].map(Math.abs);
    expect(currents.length).toBeGreaterThan(0);
    // les fils de la boucle principale portent 3 mA, ceux du voltmètre ~0
    expect(Math.max(...currents)).toBeCloseTo(0.003, 6);
    const near = currents.filter((i) => Math.abs(i - 0.003) < 1e-6).length;
    expect(near).toBeGreaterThanOrEqual(6);
  });

  it("charge un condensateur avec la bonne constante de temps", () => {
    const circuit = example("rc");
    const sw = circuit.components.find((c) => c.type === "switch")!;
    sw.closed = true;
    const sim = new Simulator(circuit);
    sim.dt = 1e-4;
    const tau = 1000 * 100e-6; // 0,1 s
    while (sim.time < tau - 1e-9) sim.step();
    const vc = byType(sim, "capacitor").r.v;
    expect(vc).toBeCloseTo(5 * (1 - Math.exp(-1)), 2);
    while (sim.time < 5 * tau - 1e-9) sim.step();
    expect(byType(sim, "capacitor").r.v).toBeCloseTo(5 * (1 - Math.exp(-5)), 2);
  });

  it("établit le courant dans une bobine (RL)", () => {
    const circuit = example("rl");
    circuit.components.find((c) => c.type === "switch")!.closed = true;
    const sim = new Simulator(circuit);
    sim.dt = 1e-4;
    const tau = 1 / 10; // L/R
    while (sim.time < tau - 1e-9) sim.step();
    expect(byType(sim, "ammeter").r.i).toBeCloseTo(1.2 * (1 - Math.exp(-1)), 2);
  });

  it("polarise une DEL avec ~1,8 V et ~14 mA", () => {
    const sim = new Simulator(example("led"));
    expect(sim.error).toBeNull();
    const led = byType(sim, "led").r;
    expect(led.v).toBeGreaterThan(1.6);
    expect(led.v).toBeLessThan(2.1);
    expect(led.i).toBeGreaterThan(0.012);
    expect(led.i).toBeLessThan(0.016);
    expect(byType(sim, "ammeter").r.i).toBeCloseTo(led.i, 6);
  });

  it("bloque une diode en inverse", () => {
    const sim = new Simulator(example("led"));
    const led = sim.circuit.components.find((c) => c.type === "led")!;
    led.rot = 3; // inversée
    sim.rebuild();
    expect(Math.abs(byType(sim, "led").r.i)).toBeLessThan(1e-9);
  });

  it("gère une source sinusoïdale et une expression de t", () => {
    const circuit: Circuit = { components: [], wires: [] };
    const src = createComponent("vfunc", { x: 0, y: 2 }, 1);
    src.props.V = "10*sin(2*pi*1000*t)";
    const r = createComponent("resistor", { x: 4, y: 0 }, 0);
    r.props.R = "1k";
    const gnd = createComponent("ground", { x: 0, y: 5 }, 0);
    circuit.components.push(src, r, gnd);
    circuit.wires.push(createWire({ x: 0, y: 0 }, { x: 2, y: 0 }));
    circuit.wires.push(createWire({ x: 6, y: 0 }, { x: 6, y: 4 }));
    circuit.wires.push(createWire({ x: 6, y: 4 }, { x: 0, y: 4 }));
    normalizeWires(circuit);
    const sim = new Simulator(circuit);
    sim.dt = 1e-6;
    while (sim.time < 0.00025 - 1e-12) sim.step();
    expect(byType(sim, "resistor").r.v).toBeCloseTo(10, 2);
    expect(byType(sim, "resistor").r.i).toBeCloseTo(0.01, 4);
  });

  it("détecte une pile court-circuitée", () => {
    const circuit: Circuit = { components: [], wires: [] };
    circuit.components.push(createComponent("battery", { x: 0, y: 0 }, 0));
    circuit.wires.push(createWire({ x: -2, y: 0 }, { x: -2, y: 2 }));
    circuit.wires.push(createWire({ x: -2, y: 2 }, { x: 2, y: 2 }));
    circuit.wires.push(createWire({ x: 2, y: 2 }, { x: 2, y: 0 }));
    const sim = new Simulator(circuit);
    expect(sim.error).toMatch(/court-circuit/);
  });

  it("résout les sources dépendantes (VCVS et CCCS)", () => {
    // VCVS : entrée 3 V (pile + résistance), gain 2 → 6 V sur une charge 1 kΩ
    const circuit: Circuit = { components: [], wires: [] };
    const bat = createComponent("battery", { x: -6, y: 2 }, 1); // + en (-6,0), − en (-6,4)
    bat.props.V = 3;
    const e = createComponent("vcvs", { x: 0, y: 1 }, 0); // cmd+ (-2,0) cmd− (-2,2) out+ (2,0) out− (2,2)
    e.props.gain = 2;
    const load = createComponent("resistor", { x: 6, y: 1 }, 1); // (6,-1),(6,3)
    const gnd = createComponent("ground", { x: -6, y: 5 }, 0); // terminal (-6,4)
    circuit.components.push(bat, e, load, gnd);
    circuit.wires.push(createWire({ x: -6, y: 0 }, { x: -2, y: 0 }));
    circuit.wires.push(createWire({ x: -6, y: 4 }, { x: -2, y: 4 }));
    circuit.wires.push(createWire({ x: -2, y: 4 }, { x: -2, y: 2 }));
    circuit.wires.push(createWire({ x: 2, y: 0 }, { x: 6, y: 0 }));
    circuit.wires.push(createWire({ x: 6, y: 0 }, { x: 6, y: -1 }));
    circuit.wires.push(createWire({ x: 2, y: 2 }, { x: 2, y: 4 }));
    circuit.wires.push(createWire({ x: 2, y: 4 }, { x: 6, y: 4 }));
    circuit.wires.push(createWire({ x: 6, y: 4 }, { x: 6, y: 3 }));
    normalizeWires(circuit);
    const sim = new Simulator(circuit);
    expect(sim.error).toBeNull();
    expect(byType(sim, "resistor").r.v).toBeCloseTo(6, 6);
    expect(byType(sim, "vcvs").r.vc).toBeCloseTo(3, 6);
    expect(byType(sim, "vcvs").r.i).toBeCloseTo(-0.006, 6);

    // CCCS : remplace la VCVS ; la commande est en série avec la pile via une résistance de 1 kΩ (3 mA), gain 10 → 30 mA dans la charge
    e.type = "cccs";
    e.props = { gain: 10 };
    const rin = createComponent("resistor", { x: -4, y: 0 }, 0); // (-6,0)-(-2,0) remplace le fil
    circuit.wires = circuit.wires.filter((w) => !(w.a.x === -6 && w.a.y === 0));
    circuit.components.push(rin);
    normalizeWires(circuit);
    sim.rebuild();
    expect(sim.error).toBeNull();
    expect(byType(sim, "cccs").r.ic).toBeCloseTo(0.003, 6);
    // le courant de sortie va de out+ vers out− dans la source : circule dans la charge de (6,3) vers (6,-1)
    expect(Math.abs(byType(sim, "resistor", 0).r.i)).toBeCloseTo(0.03, 6);
    expect(byType(sim, "resistor", 1).r.i).toBeCloseTo(0.003, 6);
  });

  it("tous les exemples se résolvent sans erreur", () => {
    for (const ex of EXAMPLES) {
      const sim = new Simulator(ex.build());
      expect(sim.error, ex.name).toBeNull();
      sim.dt = 1e-5;
      for (let k = 0; k < 200; k++) sim.step();
      sim.computeWireCurrents();
      expect(sim.error, ex.name).toBeNull();
    }
  });
});

describe("sources commandées par expression", () => {
  function series(exprValue: string, type: "vexpr" | "iexpr" = "vexpr"): Circuit {
    // Pile 10 V → R1 1 kΩ → source exprimée (verticale, + en haut) → retour à la pile ; masse sur le fil du bas.
    const battery = createComponent("battery", { x: 0, y: 3 }, 1);
    battery.name = "V1";
    battery.props.V = 10;
    const r1 = createComponent("resistor", { x: 4, y: 0 }, 0);
    r1.name = "R1";
    r1.props.R = 1000;
    const src = createComponent(type, { x: 8, y: 3 }, 1);
    src.name = "E1";
    src.props[type === "vexpr" ? "V" : "I"] = exprValue;
    const gnd = createComponent("ground", { x: 3, y: 7 }, 0);
    const circuit: Circuit = {
      components: [battery, r1, src, gnd],
      wires: [
        createWire({ x: 0, y: 1 }, { x: 0, y: 0 }),
        createWire({ x: 0, y: 0 }, { x: 2, y: 0 }),
        createWire({ x: 6, y: 0 }, { x: 8, y: 0 }),
        createWire({ x: 8, y: 0 }, { x: 8, y: 1 }),
        createWire({ x: 8, y: 5 }, { x: 8, y: 6 }),
        createWire({ x: 8, y: 6 }, { x: 0, y: 6 }),
        createWire({ x: 0, y: 6 }, { x: 0, y: 5 }),
      ],
    };
    normalizeWires(circuit);
    return circuit;
  }

  it("résout l'exemple v = 2000·i_R1 (source dépendante sans fils de commande)", () => {
    const sim = new Simulator(example("expr"));
    expect(sim.error).toBeNull();
    expect(sim.warning).toBeNull();
    expect(byType(sim, "resistor", 0).r.i).toBeCloseTo(0.01, 9);
    expect(byType(sim, "vexpr").r.v).toBeCloseTo(20, 9);
    expect(byType(sim, "resistor", 1).r.i).toBeCloseTo(0.01, 9);
  });

  it("résout exactement une rétroaction linéaire (v = 500·i_R1 en série)", () => {
    // KVL : 10 = 1000·i + 500·i → i = 6,667 mA (un point fixe naïf divergerait pour un gain de boucle > 1)
    const sim = new Simulator(series("500*i_R1"));
    expect(sim.error).toBeNull();
    expect(sim.warning).toBeNull();
    expect(byType(sim, "resistor").r.i).toBeCloseTo(10 / 1500, 9);
    expect(byType(sim, "vexpr").r.v).toBeCloseTo(500 * (10 / 1500), 9);
  });

  it("converge sur une dépendance non linéaire (v = 1e5·i_R1²)", () => {
    // 10 = 1000·i + 1e5·i² → i = (−1000 + √(1e6 + 4e6)) / 2e5
    const sim = new Simulator(series("1e5*i_R1^2"));
    expect(sim.error).toBeNull();
    expect(sim.warning).toBeNull();
    const i = (-1000 + Math.sqrt(1e6 + 4e6)) / 2e5;
    expect(byType(sim, "resistor").r.i).toBeCloseTo(i, 8);
  });

  it("suit le sens de référence du composant référencé et accepte la multiplication implicite", () => {
    const circuit = series("500 i_R1");
    circuit.components.find((c) => c.name === "R1")!.flipRef = true;
    // i_R1 vaut maintenant −i : 10 = 1000·i − 500·i → i = 20 mA
    const sim = new Simulator(circuit);
    expect(sim.error).toBeNull();
    expect(byType(sim, "resistor").r.i).toBeCloseTo(0.02, 9);
  });

  it("résout une source de courant exprimée en série avec R1 (i = 2m + v_R1/2000)", () => {
    // Le courant de la boucle est imposé par la source : i = 2m + v_R1/2000 avec v_R1 = 1000·i
    // → i = 2m + i/2 → i = 4 mA, v_R1 = 4 V (à la conductance de fuite GMIN près).
    const sim = new Simulator(series("2m + v_R1/2000", "iexpr"));
    expect(sim.error).toBeNull();
    expect(sim.warning).toBeNull();
    expect(byType(sim, "resistor").r.i).toBeCloseTo(0.004, 9);
    expect(byType(sim, "resistor").r.v).toBeCloseTo(4, 6);
  });
});
