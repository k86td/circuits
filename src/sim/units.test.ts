import { describe, expect, it } from "vitest";
import { formatSI, parseSI } from "./units";

describe("parseSI", () => {
  it("lit les préfixes SI", () => {
    expect(parseSI("4.7k")).toBeCloseTo(4700);
    expect(parseSI("100u")).toBeCloseTo(100e-6);
    expect(parseSI("100µF")).toBeCloseTo(100e-6);
    expect(parseSI("2,2M")).toBeCloseTo(2.2e6);
    expect(parseSI("10 mA")).toBeCloseTo(0.01);
    expect(parseSI("1meg")).toBeCloseTo(1e6);
    expect(parseSI("1e-6")).toBeCloseTo(1e-6);
    expect(parseSI("-5")).toBe(-5);
    expect(parseSI("abc")).toBeNull();
  });
});

describe("formatSI", () => {
  it("formate avec préfixes", () => {
    expect(formatSI(4700, "Ω")).toBe("4.7 kΩ");
    expect(formatSI(0.01, "A")).toBe("10 mA");
    expect(formatSI(100e-6, "F")).toBe("100 µF");
    expect(formatSI(5, "V")).toBe("5 V");
    expect(formatSI(0, "V")).toBe("0 V");
    expect(formatSI(-3.333, "V")).toBe("-3.33 V");
  });
});
