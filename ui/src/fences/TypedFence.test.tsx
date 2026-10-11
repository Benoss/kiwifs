import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ErrorBoundary } from "@kw/components/ErrorBoundary";
import { expectMet, TypedFence } from "./TypedFence";
import { fenceCatalogue } from "./schemaJson";
import { getFence, type FenceSpec } from "./index";

const array = () => getFence("array")!;

describe("TypedFence", () => {
  it("wraps the canvas, and only the canvas, in data-kw-canvas", () => {
    const html = renderToStaticMarkup(
      <TypedFence spec={array()} source={"values: [1, 2]\nsteps:\n  - note: hi\n"} />,
    );
    const canvas = html.slice(html.indexOf("data-kw-canvas"));
    expect(html).toContain("data-kw-canvas");
    // The step note and the transport come after the canvas wrapper closes.
    expect(canvas.indexOf("hi")).toBeGreaterThan(0);
  });

  it("names the figure from summarize, unless ariaLabel says otherwise", () => {
    const spec: FenceSpec = { ...array(), summarize: () => "two numbers" };
    expect(renderToStaticMarkup(<TypedFence spec={spec} source={"values: [1, 2]\n"} />)).toContain(
      'aria-label="two numbers"',
    );
    expect(
      renderToStaticMarkup(<TypedFence spec={spec} source={"values: [1, 2]\nariaLabel: mine\n"} />),
    ).toContain('aria-label="mine"');
  });

  it("shows its source and the issues for a body that does not validate", () => {
    const html = renderToStaticMarkup(<TypedFence spec={array()} source="just some words" />);
    expect(html).toContain("fence could not be rendered");
    expect(html).toContain("just some words");
  });

  it("hands a legacy widget the whole YAML body as config", () => {
    const seen = vi.fn(() => null);
    const spec: FenceSpec = {
      lang: "thirdparty",
      description: "",
      component: seen,
      schema: { attributes: {} },
      example: "",
      legacy: true,
    };
    renderToStaticMarkup(<TypedFence spec={spec} source={"title: kept\nsteps: [1, 2]\nx: 1\n"} />);
    expect(seen).toHaveBeenCalled();
    expect((seen.mock.calls[0] as unknown[])[0]).toEqual({ config: { title: "kept", steps: [1, 2], x: 1 } });
  });
});

describe("expectMet", () => {
  const sel = { widget: "heap", kind: "node" as const, key: "3" };

  it("matches on the key alone when that is all a step names", () => {
    expect(expectMet({ select: 3 }, sel)).toBe(true);
    expect(expectMet({ select: 4 }, sel)).toBe(false);
    expect(expectMet({ select: 3 }, null)).toBe(false);
  });

  it("also checks widget and kind when the step names them", () => {
    expect(expectMet({ select: "3", widget: "heap", kind: "node" }, sel)).toBe(true);
    expect(expectMet({ select: "3", widget: "array" }, sel)).toBe(false);
    expect(expectMet({ key: "3", kind: "cell" }, sel)).toBe(false);
  });

  it("accepts the fence id as the widget name", () => {
    const fromArray = { widget: "array", kind: "cell" as const, key: "3" };
    expect(expectMet({ select: "3", widget: "two-sum" }, fromArray, "two-sum")).toBe(true);
    expect(expectMet({ select: "3", widget: "other" }, fromArray, "two-sum")).toBe(false);
  });
});

describe("ErrorBoundary", () => {
  it("passes the caught error to a function fallback", () => {
    const b = new ErrorBoundary({ children: null, fallback: (e: Error) => `boom: ${e.message}` });
    b.state = ErrorBoundary.getDerivedStateFromError(new Error("bad prop"));
    expect(b.render()).toBe("boom: bad prop");
  });

  it("still accepts a plain node fallback", () => {
    const b = new ErrorBoundary({ children: null, fallback: "plain" });
    b.state = { error: new Error("x") };
    expect(b.render()).toBe("plain");
  });

  it("clears the error once the keys differ from the ones it was caught under", () => {
    const b = new ErrorBoundary({ children: null, resetKeys: ["a"] });
    b.state = { error: new Error("x") };
    b.componentDidCatch();
    const setState = vi.spyOn(b, "setState").mockImplementation(() => {});
    b.componentDidUpdate();
    expect(setState).not.toHaveBeenCalled();
    (b as { props: unknown }).props = { children: null, resetKeys: ["b"] };
    b.componentDidUpdate();
    expect(setState).toHaveBeenCalledWith({ error: null });
  });

  it("stays caught when the update that changed the keys is the one that threw", () => {
    const b = new ErrorBoundary({ children: null, resetKeys: ["b"] });
    b.state = { error: new Error("x") };
    b.componentDidCatch();
    const setState = vi.spyOn(b, "setState").mockImplementation(() => {});
    b.componentDidUpdate();
    expect(setState).not.toHaveBeenCalled();
  });
});

describe("fenceCatalogue", () => {
  const cat = fenceCatalogue();

  it("is sorted by code unit, not locale", () => {
    const langs = cat.fences.map((f) => f.lang);
    expect(langs).toEqual([...langs].sort());
  });

  it("lists each alias once and never doubles a prefix", () => {
    for (const doc of cat.fences) {
      expect(new Set(doc.aliases).size, doc.lang).toBe(doc.aliases.length);
      expect(doc.aliases, doc.lang).not.toContain(doc.lang);
      for (const alias of doc.aliases) expect(alias, doc.lang).not.toMatch(/^(kiwi-|widget:)(kiwi-|widget:)/);
    }
    const steps = cat.fences.find((f) => f.lang === "steps")!;
    expect(steps.strictAliases).toEqual(["kiwi-steps", "widget:steps"]);
    expect(steps.aliases).toContain("mermaid-steps");
    expect(steps.independentSteps).toBe(true);
  });

  it("separates the strict spellings", () => {
    for (const doc of cat.fences) {
      expect(doc.strictAliases.every((a) => /^(kiwi-|widget:)/.test(a) && doc.aliases.includes(a))).toBe(true);
      expect(doc.aliases.filter((a) => /^(kiwi-|widget:)/.test(a))).toEqual(doc.strictAliases);
    }
  });

  it("tells Go which reserved keys a fence takes back", () => {
    expect(cat.fences.find((f) => f.lang === "sequence")!.reclaims).toEqual(["frames"]);
    expect(cat.fences.find((f) => f.lang === "array")!.reclaims).toBeUndefined();
  });

  it("does not describe link as a tree prop", () => {
    expect(cat.fences.find((f) => f.lang === "tree")!.attributes.link).toBeUndefined();
  });
});
