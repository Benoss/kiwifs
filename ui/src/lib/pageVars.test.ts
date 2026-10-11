import { beforeEach, describe, expect, it } from "vitest";
import {
  coercePageVarValue,
  getPageVar,
  initPageVar,
  numericPageVars,
  pageVars,
  referencedVars,
  resetPageVars,
  setPageVar,
  subscribePageVars,
  substitutePageVars,
} from "./pageVars";
import { hasInlineTags, parseInlineTags } from "./inlineTags";

describe("pageVars", () => {
  beforeEach(resetPageVars);

  it("stores and reads a value", () => {
    setPageVar("n", 4);
    expect(getPageVar("n")).toBe(4);
    expect(pageVars()).toEqual({ n: 4 });
  });

  it("hands out a stable snapshot between changes", () => {
    setPageVar("n", 1);
    const first = pageVars();
    expect(pageVars()).toBe(first);
    setPageVar("n", 2);
    expect(pageVars()).not.toBe(first);
  });

  it("does not wake subscribers for a no-op write", () => {
    let seen = 0;
    const off = subscribePageVars(() => {
      seen += 1;
    });
    setPageVar("n", 1);
    expect(seen).toBe(1);
    setPageVar("n", 1);
    expect(seen).toBe(1);
    off();
  });

  it("initPageVar does not overwrite what the reader set", () => {
    // A control re-rendering must not snap its own slider back to the default.
    setPageVar("n", 9);
    initPageVar("n", 1);
    expect(getPageVar("n")).toBe(9);
  });

  it("initPageVar fills an unset name", () => {
    initPageVar("n", 1);
    expect(getPageVar("n")).toBe(1);
  });

  it("exposes only the numeric variables to an expression", () => {
    setPageVar("n", 3);
    setPageVar("mode", "chain");
    setPageVar("on", true);
    expect(numericPageVars()).toEqual({ n: 3, on: 1 });
  });
});

describe("substitutePageVars", () => {
  it("replaces a bare and a braced reference", () => {
    expect(substitutePageVars("values: [1, $n, 3]", { n: 7 })).toBe("values: [1, 7, 3]");
    expect(substitutePageVars("label: ${n}x", { n: 7 })).toBe("label: 7x");
  });

  it("quotes a string, so the YAML still parses", () => {
    expect(substitutePageVars("mode: $m", { m: "chain" })).toBe('mode: "chain"');
  });

  it("leaves an unbound name alone, so the error names the right thing", () => {
    expect(substitutePageVars("values: [$n]", {})).toBe("values: [$n]");
  });

  it("is a no-op for a body with no placeholders", () => {
    const body = "values: [1, 2, 3]";
    expect(substitutePageVars(body, { n: 1 })).toBe(body);
  });

  it("writes a boolean as a bare true/false", () => {
    expect(substitutePageVars("wrap: $on", { on: true })).toBe("wrap: true");
  });
});

describe("referencedVars", () => {
  it("lists what a body reads", () => {
    expect(referencedVars("values: [$a, $b, $a]").sort()).toEqual(["a", "b"]);
  });

  it("returns nothing for a body with no references", () => {
    expect(referencedVars("values: [1]")).toEqual([]);
  });
});

describe("parseInlineTags", () => {
  it("reads a self-closing tag with attributes", () => {
    const [tag] = parseInlineTags('a {% range name="n" min=1 max=20 /%} b');
    expect(tag).toMatchObject({ name: "range", attrs: { name: "n", min: 1, max: 20 } });
  });

  it("reads the bare word form", () => {
    const [tag] = parseInlineTags("{% value n /%}");
    expect(tag!.name).toBe("value");
    expect(tag!.positional).toBe("n");
  });

  it("coerces unquoted numbers and booleans, and keeps quoted strings", () => {
    const [tag] = parseInlineTags('{% toggle name="x" default=false step=0.5 label="a b" /%}');
    expect(tag!.attrs).toEqual({ name: "x", default: false, step: 0.5, label: "a b" });
  });

  it("reports offsets so a caller can splice around it", () => {
    const [tag] = parseInlineTags("xx {% value n /%} yy");
    expect("xx {% value n /%} yy".slice(tag!.start, tag!.end)).toBe("{% value n /%}");
  });

  it("finds several tags in one sentence", () => {
    expect(parseInlineTags("{% value a /%} and {% value b /%}")).toHaveLength(2);
  });

  it("ignores text with no tags", () => {
    expect(parseInlineTags("100% done")).toEqual([]);
    expect(hasInlineTags("100% done")).toBe(false);
  });
});

describe("placeholders next to braces", () => {
  it("does not eat a closing brace after a bare name", () => {
    expect(substitutePageVars("{a: $n}", { n: 4 })).toBe("{a: 4}");
    expect(substitutePageVars("{a: ${n}}", { n: 4 })).toBe("{a: 4}");
    expect(substitutePageVars("${n}px", { n: 4 })).toBe("4px");
  });

  it("names the variable either way", () => {
    expect(referencedVars("{a: $n, b: ${m}}")).toEqual(["n", "m"]);
  });
});

describe("select values", () => {
  it("stores a numeric option as a number, so expressions see it", () => {
    expect(coercePageVarValue("4")).toBe(4);
    expect(coercePageVarValue("2.5")).toBe(2.5);
    expect(coercePageVarValue("-1")).toBe(-1);
  });

  it("leaves words and non-canonical spellings as strings", () => {
    expect(coercePageVarValue("fast")).toBe("fast");
    expect(coercePageVarValue("04")).toBe("04");
    expect(coercePageVarValue("")).toBe("");
    expect(coercePageVarValue(" 4")).toBe(" 4");
  });

  it("reaches numericPageVars once coerced", () => {
    resetPageVars();
    setPageVar("k", coercePageVarValue("8"));
    expect(numericPageVars()).toEqual({ k: 8 });
    resetPageVars();
  });
});

describe("inline tags with a percent in a quoted value", () => {
  it("does not end the tag at a quoted %", () => {
    const [tag] = parseInlineTags('{% range name="p" suffix="%" max=100 /%} done');
    expect(tag).toMatchObject({ name: "range", attrs: { name: "p", suffix: "%", max: 100 } });
    const text = '{% value p suffix=\'% off\' /%}';
    const [single] = parseInlineTags(text);
    expect(single!.attrs.suffix).toBe("% off");
    expect(text.slice(single!.start, single!.end)).toBe(text);
  });
});
