import { describe, expect, it } from "vitest";
import { hasNotation, notationClass, parseNotation, withSourceHighlights } from "./codeNotation";

describe("hasNotation", () => {
  it("only fires on a real marker", () => {
    expect(hasNotation("x = 1 // [!code highlight]")).toBe(true);
    expect(hasNotation("x = 1 // just a comment")).toBe(false);
    expect(hasNotation("print('[!code]')")).toBe(false);
  });
});

describe("parseNotation", () => {
  it("strips the marker and records the line", () => {
    const got = parseNotation("a = 1\nb = 2 // [!code highlight]\nc = 3");
    expect(got.code).toBe("a = 1\nb = 2\nc = 3");
    expect([...got.lines.highlight]).toEqual([2]);
  });

  it("accepts the comment syntax of whatever language it is in", () => {
    for (const line of [
      "x = 1 // [!code highlight]",
      "x = 1 # [!code highlight]",
      "x = 1 -- [!code highlight]",
      "x = 1 /* [!code highlight] */",
      "x = 1 <!-- [!code highlight] -->",
    ]) {
      const got = parseNotation(line);
      expect(got.code, line).toBe("x = 1");
      expect([...got.lines.highlight], line).toEqual([1]);
    }
  });

  it("reads the ++ and -- diff aliases", () => {
    const got = parseNotation("keep()\nold() // [!code --]\nnew() // [!code ++]");
    expect([...got.lines.remove]).toEqual([2]);
    expect([...got.lines.add]).toEqual([3]);
    expect(got.code).toBe("keep()\nold()\nnew()");
  });

  it("applies a count to the following lines", () => {
    const got = parseNotation("a\nb // [!code highlight:3]\nc\nd\ne");
    expect([...got.lines.highlight].sort((x, y) => x - y)).toEqual([2, 3, 4]);
  });

  it("drops a marker that sits on its own line", () => {
    const got = parseNotation("a\n// [!code highlight:2]\nb\nc\nd");
    expect(got.code).toBe("a\nb\nc\nd");
    expect([...got.lines.highlight].sort((x, y) => x - y)).toEqual([2, 3]);
  });

  it("collects words to underline", () => {
    const got = parseNotation("const token = 1 // [!code word:token]");
    expect(got.words).toEqual(["token"]);
    expect(got.code).toBe("const token = 1");
  });

  it("reports whether anything is focused", () => {
    expect(parseNotation("a\nb // [!code focus]").hasFocus).toBe(true);
    expect(parseNotation("a\nb").hasFocus).toBe(false);
  });

  it("leaves an unknown kind in place rather than eating the line", () => {
    const line = "x = 1 // [!code nonsense]";
    expect(parseNotation(line).code).toBe(line);
  });

  it("leaves ordinary code untouched", () => {
    const code = "def f():\n    return 1  # a note\n";
    expect(parseNotation(code).code).toBe(code);
  });
});

describe("notationClass", () => {
  it("blurs everything outside the focus", () => {
    const got = parseNotation("a\nb // [!code focus]\nc");
    expect(notationClass(1, got)).toContain("kiwi-line-blur");
    expect(notationClass(2, got)).not.toContain("kiwi-line-blur");
  });

  it("combines a diff marker with a highlight", () => {
    const got = parseNotation("a // [!code ++]\nb");
    got.lines.highlight.add(1);
    const cls = notationClass(1, got);
    expect(cls).toContain("kiwi-diff-add");
    expect(cls).toContain("kiwi-line-highlight");
  });

  it("falls back to the plain line class", () => {
    expect(notationClass(1, parseNotation("a"))).toBe("kiwi-line");
  });
});

describe("withSourceHighlights", () => {
  it("keeps both the notation's highlights and the meta's", () => {
    const notated = parseNotation("a\nb // [!code highlight]\nc\nd");
    const merged = withSourceHighlights(notated, new Set([1, 4]));
    expect([...merged.lines.highlight].sort()).toEqual([1, 2, 4]);
    expect(notationClass(1, merged)).toContain("kiwi-line-highlight");
  });

  it("counts meta lines in the source as written, marker lines included", () => {
    // Source line 2 is a standalone marker, dropped from the output, so source
    // line 4 ("c") renders as row 3.
    const notated = parseNotation("a\n// [!code ++]\nb\nc");
    expect(notated.code).toBe("a\nb\nc");
    const merged = withSourceHighlights(notated, new Set([4]));
    expect([...merged.lines.highlight]).toEqual([3]);
    expect(merged.lines.add.has(2)).toBe(true);
  });

  it("is a no-op without meta highlights", () => {
    const notated = parseNotation("a // [!code focus]");
    expect(withSourceHighlights(notated, new Set())).toBe(notated);
  });
});
