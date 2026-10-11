import { describe, expect, it } from "vitest";
import {
  escapeAttr,
  findCanvas,
  inlineDeclarations,
  pickCanvasSvg,
  SnapshotError,
  toSnapshotError,
  wrapForeignObject,
} from "./snapshot";
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

describe("attribute escaping", () => {
  it("escapes quotes and markup", () => {
    expect(escapeAttr(`"Inter", 'Helvetica' <&>`)).toBe("&quot;Inter&quot;, &#39;Helvetica&#39; &lt;&amp;&gt;");
  });

  it("keeps a quoted font family from breaking the envelope", () => {
    const svg = wrapForeignObject("<div/>", 10, 20, "#fff", `"Inter Variable", sans-serif`);
    expect(svg).toContain(`style="font-family:&quot;Inter Variable&quot;, sans-serif"`);
    expect(svg).toContain(`fill="#fff"`);
  });
});

describe("inlineDeclarations", () => {
  it("writes the computed layout a div canvas needs, vars resolved", () => {
    const computed = {
      getPropertyValue: (name: string) =>
        ({ display: "grid", gap: "4px", color: "var(--fg)", "--fg": "red" })[name] ?? "",
    } as unknown as CSSStyleDeclaration;
    expect(inlineDeclarations(computed, ["display", "gap", "color", "padding"])).toBe(
      "display:grid;gap:4px;color:red",
    );
  });
});

/** A node with a size and a place in a tree, for picking the canvas's SVG. */
interface Node {
  tag: string;
  area: number;
  parent: Node | null;
  children: Node[];
  attrs: Record<string, string>;
}

function node(tag: string, area: number, children: Node[] = [], attrs: Record<string, string> = {}): Node {
  const n: Node = { tag, area, parent: null, children, attrs };
  for (const c of children) c.parent = n;
  return n;
}

function all(n: Node): Node[] {
  return n.children.flatMap((c) => [c, ...all(c)]);
}

function matches(n: Node, sel: string): boolean {
  return sel.split(",").some((s) => {
    const t = s.trim();
    if (t === "[data-kw-canvas]") return "data-kw-canvas" in n.attrs;
    if (t === "[role='toolbar']") return n.attrs.role === "toolbar";
    return n.tag === t;
  });
}

function el(n: Node): Element {
  return {
    getBoundingClientRect: () => ({ width: n.area, height: 1 }),
    get parentElement() {
      return n.parent ? el(n.parent) : null;
    },
    closest: (sel: string) => {
      for (let cur: Node | null = n; cur; cur = cur.parent) if (matches(cur, sel)) return el(cur);
      return null;
    },
    querySelector: (sel: string) => {
      const hit = all(n).find((c) => matches(c, sel));
      return hit ? el(hit) : null;
    },
    querySelectorAll: (sel: string) => all(n).filter((c) => matches(c, sel)).map(el),
    _node: n,
  } as unknown as Element;
}

const nodeOf = (e: Element | null) => (e as unknown as { _node: Node } | null)?._node;

describe("finding what to picture", () => {
  it("prefers the canvas over the whole widget", () => {
    const canvas = node("div", 100, [], { "data-kw-canvas": "" });
    const root = node("figure", 200, [canvas, node("div", 20)]);
    expect(nodeOf(findCanvas(el(root)))).toBe(canvas);
    expect(nodeOf(findCanvas(el(node("figure", 10))))?.tag).toBe("figure");
  });

  it("takes the drawing, not an icon in a control", () => {
    const drawing = node("svg", 90, [node("svg", 5)]);
    const icon = node("svg", 1);
    const canvas = node("div", 100, [node("button", 2, [icon]), drawing]);
    expect(nodeOf(pickCanvasSvg(el(canvas)))).toBe(drawing);
  });

  it("treats a div canvas with a small svg inside as a div canvas", () => {
    const canvas = node("div", 100, [node("div", 80, [node("svg", 4)])]);
    expect(pickCanvasSvg(el(canvas))).toBe(null);
  });
});

describe("snapshot failures", () => {
  it("names a tainted canvas so the caller can fall back to SVG", () => {
    const err = toSnapshotError(Object.assign(new Error("tainted"), { name: "SecurityError" }));
    expect(err).toBeInstanceOf(SnapshotError);
    expect(err.reason).toBe("tainted");
    expect(toSnapshotError(new Error("boom")).reason).toBe("rasterise");
  });
});
