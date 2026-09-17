import { describe, expect, it } from "vitest";
import { compileExpr, evalValue, exprRefs, isTimeDependent } from "./expr";

describe("compileExpr", () => {
  it("évalue des expressions de t", () => {
    expect(compileExpr("5*sin(2*pi*60*t)")(1 / 240)).toBeCloseTo(5);
    expect(compileExpr("12*step(t-2m)")(0.001)).toBe(0);
    expect(compileExpr("12*step(t-2m)")(0.003)).toBe(12);
    expect(compileExpr("1k+500")(0)).toBe(1500);
    expect(compileExpr("2^3^1")(0)).toBe(8);
    expect(compileExpr("-t^2")(3)).toBe(-9);
    expect(compileExpr("pulse(t, 10m, 0.25)")(0.002)).toBe(1);
    expect(compileExpr("pulse(t, 10m, 0.25)")(0.005)).toBe(0);
    expect(compileExpr("max(1, 2, t)")(5)).toBe(5);
    expect(compileExpr("1meg")(0)).toBe(1e6);
    expect(compileExpr("2,2k")(0)).toBeCloseTo(2200);
  });
  it("rejette les expressions invalides", () => {
    expect(() => compileExpr("5*")).toThrow();
    expect(() => compileExpr("foo(t)")).toThrow();
    expect(() => compileExpr("x+1")).toThrow();
    expect(() => compileExpr("(1+2")).toThrow();
  });
  it("evalValue accepte nombres et chaînes", () => {
    expect(evalValue(3, 10)).toBe(3);
    expect(evalValue("t*2", 10)).toBe(20);
    expect(evalValue("??", 10)).toBeNaN();
  });
});

describe("références à d'autres composants", () => {
  it("évalue i_X et v_X avec un contexte et les expose dans refs", () => {
    const ctx = (kind: "i" | "v", name: string) => (kind === "i" && name === "R1" ? 3 : kind === "v" && name === "R2" ? 4 : 0);
    const f = compileExpr("2*i_R1 + v_R2");
    expect(f(0, ctx)).toBeCloseTo(10, 12);
    expect(f(0)).toBe(0);
    expect(f.refs).toEqual([
      { kind: "i", name: "R1" },
      { kind: "v", name: "R2" },
    ]);
    expect(exprRefs("2*i_R1 + i_R1")).toHaveLength(1);
    expect(exprRefs(5)).toEqual([]);
    expect(isTimeDependent("2*i_R1")).toBe(true);
  });

  it("accepte la multiplication implicite", () => {
    const ctx = (kind: "i" | "v", name: string) => (kind === "i" && name === "R1" ? 3 : 0);
    expect(compileExpr("2 i_R1")(0, ctx)).toBeCloseTo(6, 12);
    expect(compileExpr("2 sin(pi/2)")(0)).toBeCloseTo(2, 12);
    expect(compileExpr("2(t+1)")(1)).toBeCloseTo(4, 12);
    expect(compileExpr("3 i_R1^2")(0, ctx)).toBeCloseTo(27, 12);
  });
});
