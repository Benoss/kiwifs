import { describe, expect, it } from "vitest";
import { resolveVars } from "./snapshot";

/** A stand-in for the computed style of a themed widget. */
function style(vars: Record<string, string>): CSSStyleDeclaration {
  return {
    getPropertyValue: (name: string) => vars[name] ?? "",
  } as unknown as CSSStyleDeclaration;
}

describe("resolveVars", () => {
  it("substitutes a custom property", () => {
    expect(resolveVars("var(--kw-widget-border)", style({ "--kw-widget-border": "#3f3f46" }))).toBe("#3f3f46");
  });

  it("takes the fallback when the property is unset", () => {
    // Without this a snapshot of a diagram drawn with `var(--x, #fff)` comes
    // out as `var(--x, #fff)`, which paints as nothing.
    expect(resolveVars("var(--missing, #ffffff)", style({}))).toBe("#ffffff");
  });

  it("resolves a chain of properties", () => {
    const vars = { "--a": "var(--b)", "--b": "red" };
    expect(resolveVars("var(--a)", style(vars))).toBe("red");
  });

  it("handles several references in one value", () => {
    const vars = { "--a": "1px", "--b": "blue" };
    expect(resolveVars("var(--a) solid var(--b)", style(vars))).toBe("1px solid blue");
  });

  it("leaves a plain value alone", () => {
    expect(resolveVars("#abcdef", style({}))).toBe("#abcdef");
    expect(resolveVars("none", style({}))).toBe("none");
  });

  it("produces an empty string for an unset property with no fallback", () => {
    expect(resolveVars("var(--nope)", style({}))).toBe("");
  });

  it("trims whitespace inside the reference", () => {
    expect(resolveVars("var( --a , red )", style({ "--a": "" }))).toBe("red");
  });
});
