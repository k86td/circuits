import { describe, expect, it } from "vitest";
import { compileExpr, evalValue } from "./expr";

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
