import { describe, expect, it } from "vitest";
import { ExprError, compile, evaluate, evaluateBool, freeNames, parseExpr } from "./expr";

describe("arithmetic", () => {
  it("evaluates the four operations with the usual precedence", () => {
    expect(evaluate("1 + 2 * 3")).toBe(7);
    expect(evaluate("(1 + 2) * 3")).toBe(9);
    expect(evaluate("10 / 4")).toBe(2.5);
    expect(evaluate("10 % 3")).toBe(1);
  });

  it("binds ^ tighter than * and right-associatively", () => {
    expect(evaluate("2 * 3 ^ 2")).toBe(18);
    // 2^(3^2) = 512, not (2^3)^2 = 64.
    expect(evaluate("2 ^ 3 ^ 2")).toBe(512);
  });

  it("handles unary minus, including before a power", () => {
    expect(evaluate("-3 + 1")).toBe(-2);
    expect(evaluate("-(2 + 3)")).toBe(-5);
    expect(evaluate("2 * -3")).toBe(-6);
  });

  it("reads decimals and exponent notation", () => {
    expect(evaluate("1.5 * 2")).toBe(3);
    expect(evaluate(".5 + .25")).toBe(0.75);
    expect(evaluate("1e3 + 1")).toBe(1001);
    expect(evaluate("2.5e-1")).toBe(0.25);
  });
});

describe("names", () => {
  it("reads from the scope", () => {
    expect(evaluate("n * 2", { n: 21 })).toBe(42);
  });

  it("falls back to a lowercase match, then to a constant", () => {
    expect(evaluate("N * 2", { n: 4 })).toBe(8);
    expect(evaluate("pi")).toBeCloseTo(Math.PI);
    expect(evaluate("2 * PI")).toBeCloseTo(2 * Math.PI);
  });

  it("leaves magnitude units to whoever puts them in scope", () => {
    // `y = m*x + b` has to mean slope and intercept, not mega and billion.
    expect(() => evaluate("m * x + b", { x: 2 })).toThrow(/unknown name "m"/);
    expect(evaluate("m * x + b", { m: 3, x: 2, b: 1 })).toBe(7);
  });

  it("names an unknown identifier rather than returning NaN", () => {
    expect(() => evaluate("qps * 2")).toThrow(/unknown name "qps"/);
  });

  it("lets the scope shadow a constant", () => {
    expect(evaluate("e", { e: 1 })).toBe(1);
  });

  it("coerces a boolean in the scope", () => {
    expect(evaluate("flag * 5", { flag: true })).toBe(5);
    expect(evaluate("flag * 5", { flag: false })).toBe(0);
  });
});

describe("functions", () => {
  it("evaluates the named functions", () => {
    expect(evaluate("sqrt(16)")).toBe(4);
    expect(evaluate("max(1, 9, 3)")).toBe(9);
    expect(evaluate("floor(2.7) + ceil(0.2)")).toBe(3);
    expect(evaluate("log2(1024)")).toBe(10);
    expect(evaluate("log(8, 2)")).toBe(3);
    expect(evaluate("log(100)")).toBe(2);
    expect(evaluate("clamp(12, 0, 10)")).toBe(10);
    expect(evaluate("sin(0)")).toBe(0);
  });

  it("checks arity and names the function", () => {
    expect(() => evaluate("sqrt(1, 2)")).toThrow(/sqrt\(\) takes 1 arguments, got 2/);
    expect(() => evaluate("atan2(1)")).toThrow(/takes 2 arguments/);
  });

  it("rejects an unknown function", () => {
    expect(() => evaluate("frobnicate(2)")).toThrow(/unknown function "frobnicate"/);
  });
});

describe("predicates", () => {
  it("evaluates comparisons as 1 and 0", () => {
    expect(evaluate("3 > 2")).toBe(1);
    expect(evaluate("3 < 2")).toBe(0);
    expect(evaluate("2 == 2")).toBe(1);
    expect(evaluate("2 != 2")).toBe(0);
  });

  it("binds comparisons looser than arithmetic", () => {
    expect(evaluate("1 + 1 == 2")).toBe(1);
    expect(evaluate("2 * 3 > 5")).toBe(1);
  });

  it("supports and / or as words and as symbols", () => {
    expect(evaluate("1 and 1")).toBe(1);
    expect(evaluate("1 and 0")).toBe(0);
    expect(evaluate("0 or 1")).toBe(1);
    expect(evaluate("1 && 0")).toBe(0);
    expect(evaluate("0 || 0")).toBe(0);
  });

  it("short-circuits, so a guard actually guards", () => {
    // Without short-circuiting the right side divides by zero and the whole
    // predicate becomes NaN-ish rather than false.
    expect(evaluate("n > 0 and 10 / n > 2", { n: 0 })).toBe(0);
    expect(evaluate("n == 0 or 10 / n > 2", { n: 0 })).toBe(1);
  });

  it("supports not", () => {
    expect(evaluate("not 0")).toBe(1);
    expect(evaluate("!1")).toBe(0);
    expect(evaluate("not (3 > 2)")).toBe(0);
  });

  it("evaluateBool reads as a boolean", () => {
    expect(evaluateBool("x < 5", { x: 1 })).toBe(true);
    expect(evaluateBool("x < 5", { x: 9 })).toBe(false);
  });
});

describe("errors", () => {
  it("rejects an empty expression", () => {
    expect(() => evaluate("")).toThrow(ExprError);
  });

  it("names the offending character", () => {
    expect(() => evaluate("1 $ 2")).toThrow(/unexpected character "\$"/);
  });

  it("reports an unbalanced parenthesis", () => {
    expect(() => evaluate("(1 + 2")).toThrow(/expected \)/);
    expect(() => evaluate("1 + 2)")).toThrow(/expected eof/);
  });

  it("reports a dangling operator", () => {
    expect(() => evaluate("1 +")).toThrow(ExprError);
    expect(() => evaluate("* 2")).toThrow(ExprError);
  });

  it("never reaches a JS evaluator, whatever the input", () => {
    // The point of the parser: there is no path from author text to code.
    for (const attack of [
      "constructor",
      "this",
      "globalThis.alert(1)",
      "[].constructor",
      "1;alert(1)",
      // Inherited properties must not resolve as names, or an expression can
      // name something the author never put in scope.
      "__proto__",
      "toString",
      "valueOf",
      "hasOwnProperty",
      "constructor(1)",
      "toString(1)",
    ]) {
      expect(() => evaluate(attack), attack).toThrow(ExprError);
    }
  });
});

describe("compile", () => {
  it("parses once and evaluates many times", () => {
    const f = compile("sin(x) + a");
    expect(f({ x: 0, a: 1 })).toBe(1);
    expect(f({ x: Math.PI / 2, a: 0 })).toBeCloseTo(1);
  });

  it("reports a parse error at compile time, not per sample", () => {
    expect(() => compile("1 +")).toThrow(ExprError);
  });
});

describe("freeNames", () => {
  it("lists what has to be bound, ignoring constants and functions", () => {
    expect(freeNames("sin(x) * amplitude + pi").sort()).toEqual(["amplitude", "x"]);
  });

  it("returns nothing for a closed expression", () => {
    expect(freeNames("2 * pi")).toEqual([]);
  });
});

describe("parseExpr", () => {
  it("returns a tree a caller can inspect", () => {
    expect(parseExpr("1 + 2")).toEqual({
      kind: "binary",
      op: "+",
      left: { kind: "num", value: 1 },
      right: { kind: "num", value: 2 },
    });
  });
});
