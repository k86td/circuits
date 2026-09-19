import { describe, expect, it } from "vitest";
import { type Circuit, type Vec, createComponent, createWire, pointKey, samePoint, terminalPositions } from "./model";
import { buildNetlist, connectionDegrees, normalizeWires } from "./netlist";
import { bodyBox, moveWireEnd, polylineWires, relocateComponent, routeToTerminal, routeWire, translateWires, wirePath } from "./wiring";

/** Résistance horizontale en (0,0) reliée par deux fils droits à des points éloignés. */
function resistorWithLeads(): Circuit {
  const r = createComponent("resistor", { x: 0, y: 0 });
  r.name = "R1";
  return {
    components: [r],
    wires: [createWire({ x: -6, y: 0 }, { x: -2, y: 0 }), createWire({ x: 2, y: 0 }, { x: 6, y: 0 })],
  };
}

function nodeOf(c: Circuit, p: Vec): number | undefined {
  return buildNetlist(c).nodeOfPoint.get(pointKey(p));
}

function hasWire(c: Circuit, a: Vec, b: Vec): boolean {
  return c.wires.some((w) => (samePoint(w.a, a) && samePoint(w.b, b)) || (samePoint(w.a, b) && samePoint(w.b, a)));
}

function isOrthogonal(c: Circuit): boolean {
  return c.wires.every((w) => w.a.x === w.b.x || w.a.y === w.b.y);
}

describe("routeToTerminal", () => {
  it("arrive le long de la patte quand le point est devant le terminal", () => {
    expect(routeToTerminal({ x: 6, y: 3 }, { x: 2, y: 0 }, { x: 1, y: 0 })).toEqual([
      { x: 6, y: 3 },
      { x: 6, y: 0 },
      { x: 2, y: 0 },
    ]);
  });

  it("contourne le composant quand le point est derrière le terminal", () => {
    const pts = routeToTerminal({ x: -6, y: 0 }, { x: 0, y: -2 }, { x: 0, y: -1 });
    expect(pts[0]).toEqual({ x: -6, y: 0 });
    expect(pts[pts.length - 1]).toEqual({ x: 0, y: -2 });
    // sort d'une unité vers le haut avant d'arriver
    expect(pts[pts.length - 2]).toEqual({ x: 0, y: -3 });
    for (let k = 0; k + 1 < pts.length; k++) expect(pts[k].x === pts[k + 1].x || pts[k].y === pts[k + 1].y).toBe(true);
  });

  it("fait un détour quand le point est dans l'axe, derrière le composant", () => {
    const pts = routeToTerminal({ x: -6, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 0 });
    // aucun segment ne passe sur l'axe entre -6 et 2 (le corps du composant)
    for (let k = 0; k + 1 < pts.length; k++) {
      const a = pts[k];
      const b = pts[k + 1];
      if (a.y === 0 && b.y === 0) expect(Math.min(a.x, b.x)).toBeGreaterThanOrEqual(2);
    }
    expect(pts[pts.length - 1]).toEqual({ x: 2, y: 0 });
  });
});

describe("relocateComponent", () => {
  it("deux rotations de 90° : jamais de court-circuit entre les terminaux", () => {
    const c = resistorWithLeads();
    const r = c.components[0];
    relocateComponent(c, r, r.pos, 1);
    normalizeWires(c);
    relocateComponent(c, r, r.pos, 2);
    normalizeWires(c);
    const [t0, t1] = terminalPositions(r);
    expect(t0).toEqual({ x: 2, y: 0 });
    expect(t1).toEqual({ x: -2, y: 0 });
    expect(isOrthogonal(c)).toBe(true);
    expect(nodeOf(c, t0)).not.toBe(nodeOf(c, t1));
    // chaque fil d'origine reste relié à un terminal, et à un seul
    const left = nodeOf(c, { x: -6, y: 0 });
    const right = nodeOf(c, { x: 6, y: 0 });
    expect(left).not.toBe(right);
    expect([nodeOf(c, t0), nodeOf(c, t1)]).toContain(left);
    expect([nodeOf(c, t0), nodeOf(c, t1)]).toContain(right);
  });

  it("rotation directe de 180° : le circuit est inchangé, seule l'orientation change", () => {
    const c = resistorWithLeads();
    const r = c.components[0];
    const before = JSON.stringify(c.wires);
    relocateComponent(c, r, r.pos, 2);
    expect(JSON.stringify(c.wires)).toBe(before);
    expect(r.rot).toBe(2);
  });

  it("rotation de 90° : les fils suivent les terminaux sans traverser le composant", () => {
    const c = resistorWithLeads();
    const r = c.components[0];
    relocateComponent(c, r, r.pos, 1);
    normalizeWires(c);
    expect(isOrthogonal(c)).toBe(true);
    const [t0, t1] = terminalPositions(r);
    expect(nodeOf(c, t0)).not.toBe(nodeOf(c, t1));
    expect(nodeOf(c, { x: -6, y: 0 })).toBe(nodeOf(c, t0));
    expect(nodeOf(c, { x: 6, y: 0 })).toBe(nodeOf(c, t1));
    // aucun fil sur le corps du composant (segment vertical en x = 0 entre les terminaux)
    for (const w of c.wires) {
      if (w.a.x === 0 && w.b.x === 0) expect(Math.min(w.a.y, w.b.y) >= 2 || Math.max(w.a.y, w.b.y) <= -2).toBe(true);
    }
  });

  it("déplacement : les fils s'allongent en restant orthogonaux et raccordés", () => {
    const c = resistorWithLeads();
    const r = c.components[0];
    relocateComponent(c, r, { x: 0, y: 3 }, 0);
    normalizeWires(c);
    expect(isOrthogonal(c)).toBe(true);
    const [t0, t1] = terminalPositions(r);
    expect(nodeOf(c, { x: -6, y: 0 })).toBe(nodeOf(c, t0));
    expect(nodeOf(c, { x: 6, y: 0 })).toBe(nodeOf(c, t1));
    expect(nodeOf(c, t0)).not.toBe(nodeOf(c, t1));
  });

  it("déplacement le long de l'axe : un terminal qui passe sur l'ancienne position de l'autre ne vole pas son fil", () => {
    const c = resistorWithLeads();
    const r = c.components[0];
    relocateComponent(c, r, { x: 4, y: 0 }, 0);
    normalizeWires(c);
    const [t0, t1] = terminalPositions(r);
    expect(t0).toEqual({ x: 2, y: 0 });
    expect(nodeOf(c, { x: -6, y: 0 })).toBe(nodeOf(c, t0));
    expect(nodeOf(c, t0)).not.toBe(nodeOf(c, t1));
  });

  it("deux composants bout à bout : celui qui s'éloigne reste relié par un nouveau fil", () => {
    const r1 = createComponent("resistor", { x: 0, y: 0 });
    const r2 = createComponent("resistor", { x: 4, y: 0 });
    const c: Circuit = { components: [r1, r2], wires: [] };
    expect(terminalPositions(r1)[1]).toEqual(terminalPositions(r2)[0]);
    relocateComponent(c, r2, { x: 8, y: 0 }, 0);
    normalizeWires(c);
    expect(c.wires.length).toBeGreaterThan(0);
    expect(nodeOf(c, terminalPositions(r1)[1])).toBe(nodeOf(c, terminalPositions(r2)[0]));
  });
});

describe("translateWires", () => {
  it("déplacer un fil entre deux terminaux le garde raccordé (forme en U)", () => {
    const r1 = createComponent("resistor", { x: 0, y: 0 });
    const r2 = createComponent("resistor", { x: 10, y: 0 });
    const w = createWire({ x: 2, y: 0 }, { x: 8, y: 0 });
    const c: Circuit = { components: [r1, r2], wires: [w] };
    translateWires(c, [w.id], { x: 0, y: 3 });
    normalizeWires(c);
    expect(isOrthogonal(c)).toBe(true);
    expect(hasWire(c, { x: 2, y: 3 }, { x: 8, y: 3 })).toBe(true);
    expect(nodeOf(c, { x: 2, y: 0 })).toBe(nodeOf(c, { x: 8, y: 0 }));
  });

  it("avec detach, le fil est simplement déplacé", () => {
    const r1 = createComponent("resistor", { x: 0, y: 0 });
    const w = createWire({ x: 2, y: 0 }, { x: 8, y: 0 });
    const c: Circuit = { components: [r1], wires: [w] };
    translateWires(c, [w.id], { x: 0, y: 3 }, { detach: true });
    expect(c.wires).toHaveLength(1);
    expect(c.wires[0].a).toEqual({ x: 2, y: 3 });
  });

  it("les fils voisins suivent la jonction", () => {
    const w1 = createWire({ x: 0, y: 0 }, { x: 4, y: 0 });
    const w2 = createWire({ x: 4, y: 0 }, { x: 4, y: 4 });
    const c: Circuit = { components: [], wires: [w1, w2] };
    translateWires(c, [w1.id], { x: 0, y: 2 });
    normalizeWires(c);
    expect(hasWire(c, { x: 0, y: 2 }, { x: 4, y: 2 })).toBe(true);
    expect(hasWire(c, { x: 4, y: 2 }, { x: 4, y: 4 })).toBe(true);
    expect(c.wires).toHaveLength(2);
  });
});

describe("moveWireEnd", () => {
  it("déplace toute la jonction et reste orthogonal", () => {
    const w1 = createWire({ x: 0, y: 0 }, { x: 4, y: 0 });
    const w2 = createWire({ x: 4, y: 0 }, { x: 4, y: 4 });
    const w3 = createWire({ x: 4, y: 0 }, { x: 8, y: 0 });
    const c: Circuit = { components: [], wires: [w1, w2, w3] };
    moveWireEnd(c, w1.id, "b", { x: 5, y: 1 }, { group: true });
    normalizeWires(c);
    expect(isOrthogonal(c)).toBe(true);
    // les trois branches restent reliées entre elles, par la nouvelle position de la jonction
    const n = nodeOf(c, { x: 0, y: 0 });
    expect(nodeOf(c, { x: 4, y: 4 })).toBe(n);
    expect(nodeOf(c, { x: 8, y: 0 })).toBe(n);
    expect(nodeOf(c, { x: 5, y: 1 })).toBe(n);
    expect(connectionDegrees(c).get("4,0") ?? 0).toBeLessThanOrEqual(2);
  });

  it("sans group, seul ce fil est détaché", () => {
    const w1 = createWire({ x: 0, y: 0 }, { x: 4, y: 0 });
    const w2 = createWire({ x: 4, y: 0 }, { x: 4, y: 4 });
    const c: Circuit = { components: [], wires: [w1, w2] };
    moveWireEnd(c, w1.id, "b", { x: 6, y: 0 });
    expect(hasWire(c, { x: 0, y: 0 }, { x: 6, y: 0 })).toBe(true);
    expect(hasWire(c, { x: 4, y: 0 }, { x: 4, y: 4 })).toBe(true);
  });
});

describe("wirePath / normalizeWires", () => {
  it("un chemin s'arrête aux embranchements et aux terminaux", () => {
    const r = createComponent("resistor", { x: 0, y: 0 });
    const w1 = createWire({ x: 2, y: 0 }, { x: 6, y: 0 });
    const w2 = createWire({ x: 6, y: 0 }, { x: 6, y: 4 });
    const w3 = createWire({ x: 6, y: 4 }, { x: 10, y: 4 });
    const w4 = createWire({ x: 6, y: 4 }, { x: 6, y: 8 });
    const c: Circuit = { components: [r], wires: [w1, w2, w3, w4] };
    expect(wirePath(c, w2.id)).toEqual([w1.id, w2.id]);
    expect(wirePath(c, w3.id)).toEqual([w3.id]);
  });

  it("fusionne les segments alignés bout à bout", () => {
    const w1 = createWire({ x: 0, y: 0 }, { x: 4, y: 0 });
    const w2 = createWire({ x: 4, y: 0 }, { x: 8, y: 0 });
    const w3 = createWire({ x: 8, y: 0 }, { x: 8, y: 4 });
    const c: Circuit = { components: [], wires: [w1, w2, w3] };
    normalizeWires(c, new Set([w2.id]));
    expect(c.wires).toHaveLength(2);
    expect(hasWire(c, { x: 0, y: 0 }, { x: 8, y: 0 })).toBe(true);
    expect(c.wires.some((w) => w.id === w2.id)).toBe(true);
  });

  it("ne fusionne pas à travers un terminal ni un embranchement", () => {
    const r = createComponent("resistor", { x: 4, y: 0 });
    const w1 = createWire({ x: 0, y: 0 }, { x: 2, y: 0 });
    const w2 = createWire({ x: 2, y: 0 }, { x: 2, y: -4 });
    const w3 = createWire({ x: 2, y: 0 }, { x: 2, y: 4 });
    const c: Circuit = { components: [r], wires: [w1, w2, w3] };
    normalizeWires(c);
    expect(c.wires).toHaveLength(3);
  });
});

describe("routeWire", () => {
  it("part le long de la patte d'un terminal", () => {
    const r = createComponent("resistor", { x: 0, y: 0 });
    const c: Circuit = { components: [r], wires: [] };
    expect(routeWire(c, { x: 2, y: 0 }, { x: 6, y: 3 })).toEqual([
      { x: 2, y: 0 },
      { x: 6, y: 0 },
      { x: 6, y: 3 },
    ]);
  });
});

describe("bestRoute (obstacles)", () => {
  /** Pile verticale en (0,0), résistance verticale en (8,0), reliées par deux fils droits (haut et bas). */
  function loop(): Circuit {
    const v = createComponent("battery", { x: 0, y: 0 }, 1);
    const r = createComponent("resistor", { x: 8, y: 0 }, 1);
    return {
      components: [v, r],
      wires: [createWire({ x: 0, y: -2 }, { x: 8, y: -2 }), createWire({ x: 8, y: 2 }, { x: 0, y: 2 })],
    };
  }

  function crossesBody(c: Circuit): boolean {
    return c.wires.some((w) =>
      c.components.some((comp) => {
        const b = bodyBox(comp);
        if (w.a.y === w.b.y) return w.a.y > b.y0 && w.a.y < b.y1 && Math.max(Math.min(w.a.x, w.b.x), b.x0) < Math.min(Math.max(w.a.x, w.b.x), b.x1);
        return w.a.x > b.x0 && w.a.x < b.x1 && Math.max(Math.min(w.a.y, w.b.y), b.y0) < Math.min(Math.max(w.a.y, w.b.y), b.y1);
      }),
    );
  }

  it("deux rotations de 90° de la résistance ne traversent jamais la pile ni ne la court-circuitent", () => {
    const c = loop();
    const r = c.components[1];
    const v = c.components[0];
    for (const rot of [2, 3] as const) {
      relocateComponent(c, r, r.pos, rot);
      normalizeWires(c);
      expect(isOrthogonal(c)).toBe(true);
      expect(crossesBody(c)).toBe(false);
      const [v0, v1] = terminalPositions(v);
      expect(nodeOf(c, v0)).not.toBe(nodeOf(c, v1));
      const [r0, r1] = terminalPositions(r);
      expect(nodeOf(c, r0)).not.toBe(nodeOf(c, r1));
      expect(new Set([nodeOf(c, r0), nodeOf(c, r1)])).toEqual(new Set([nodeOf(c, v0), nodeOf(c, v1)]));
    }
  });

  it("un fil tracé entre deux terminaux contourne un composant placé entre eux", () => {
    const a = createComponent("resistor", { x: 0, y: 0 });
    const b = createComponent("resistor", { x: 12, y: 0 });
    const mid = createComponent("capacitor", { x: 6, y: 0 });
    const c: Circuit = { components: [a, b, mid], wires: [] };
    const pts = routeWire(c, { x: 2, y: 0 }, { x: 10, y: 0 });
    c.wires = polylineWires(pts);
    normalizeWires(c);
    expect(crossesBody(c)).toBe(false);
    const [m0, m1] = terminalPositions(mid);
    expect(nodeOf(c, { x: 2, y: 0 })).toBe(nodeOf(c, { x: 10, y: 0 }));
    expect(nodeOf(c, m0)).not.toBe(nodeOf(c, { x: 2, y: 0 }));
    expect(nodeOf(c, m1)).not.toBe(nodeOf(c, { x: 2, y: 0 }));
  });

  it("un fil re-routé ne se raccorde pas à un fil étranger qu'il croiserait par une extrémité", () => {
    const r = createComponent("resistor", { x: 0, y: 0 });
    const w = createWire({ x: 2, y: 0 }, { x: 6, y: 0 });
    const foreign = createWire({ x: 6, y: -4 }, { x: 6, y: -1 });
    const c: Circuit = { components: [r], wires: [w, foreign] };
    relocateComponent(c, r, { x: 0, y: -3 }, 0);
    normalizeWires(c);
    expect(nodeOf(c, { x: 6, y: -4 })).not.toBe(nodeOf(c, { x: 6, y: 0 }));
  });
});
