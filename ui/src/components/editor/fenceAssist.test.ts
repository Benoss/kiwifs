import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import {
  MAX_FENCE_LINES,
  fenceAtCursor,
  fenceDiagnostics,
  fenceKeyCompletionSource,
  fenceLinter,
  fencePreviewAt,
  samePreviewTarget,
} from "./fenceAssist";
import type { CompletionContext } from "@codemirror/autocomplete";

function state(doc: string): EditorState {
  return EditorState.create({ doc });
}

/** The cursor sits at the `|` in the document. */
function at(doc: string): { state: EditorState; pos: number } {
  const pos = doc.indexOf("|");
  return { state: state(doc.replace("|", "")), pos };
}

function complete(doc: string) {
  const { state: st, pos } = at(doc);
  const ctx = { state: st, pos, explicit: true } as unknown as CompletionContext;
  return fenceKeyCompletionSource(ctx);
}

describe("fenceAtCursor", () => {
  it("finds the fence the cursor is inside", () => {
    const { state: st, pos } = at("```array\nvalues: [1]\n|\n```\n");
    const found = fenceAtCursor(st, pos);
    expect(found?.spec.lang).toBe("array");
  });

  it("returns nothing outside a fence", () => {
    const { state: st, pos } = at("# Heading\n\n|\n");
    expect(fenceAtCursor(st, pos)).toBeNull();
  });

  it("returns nothing after the fence closes", () => {
    const { state: st, pos } = at("```array\nvalues: [1]\n```\n\n|\n");
    expect(fenceAtCursor(st, pos)).toBeNull();
  });

  it("returns nothing for a fence that is not a widget", () => {
    const { state: st, pos } = at("```python\nx = 1\n|\n```\n");
    expect(fenceAtCursor(st, pos)).toBeNull();
  });

  it("works while the fence is still unclosed, which is how authors type", () => {
    const { state: st, pos } = at("```array\nvalues: [1]\n|");
    expect(fenceAtCursor(st, pos)?.spec.lang).toBe("array");
  });

  it("knows when the cursor is inside a step", () => {
    const inStep = at("```array\nvalues: [1]\nsteps:\n  - note: a\n    |\n```\n");
    expect(fenceAtCursor(inStep.state, inStep.pos)?.inStep).toBe(true);

    const atTop = at("```array\nvalues: [1]\n|\n```\n");
    expect(fenceAtCursor(atTop.state, atTop.pos)?.inStep).toBe(false);
  });
});

describe("fenceKeyCompletionSource", () => {
  it("offers the fence's keys", () => {
    const result = complete("```array\n|\n```\n");
    const labels = result!.options.map((o) => o.label);
    expect(labels).toContain("values");
    expect(labels).toContain("activeIndices");
  });

  it("boosts required keys, so they survive re-ranking", () => {
    const result = complete("```bits\n|\n```\n");
    const value = result!.options.find((o) => o.label === "value");
    const lsbFirst = result!.options.find((o) => o.label === "lsbFirst");
    expect(value!.boost ?? 0).toBeGreaterThan(lsbFirst?.boost ?? 0);
  });

  it("carries the key's description, so the author need not open the docs", () => {
    const values = complete("```array\n|\n```\n")!.options.find((o) => o.label === "values");
    expect(values!.info).toContain("Cell values");
    expect(values!.detail).toContain("array");
  });

  it("offers the reserved keys too", () => {
    const labels = complete("```array\n|\n```\n")!.options.map((o) => o.label);
    expect(labels).toContain("caption");
    expect(labels).toContain("code");
  });

  it("offers step keys inside a step and hides fixed ones", () => {
    const labels = complete("```array\nvalues: [1]\nsteps:\n  - |\n```\n")!.options.map((o) => o.label);
    expect(labels).toContain("note");
    expect(labels).toContain("breakpoint");
    // `cellSize` is pinned across steps, so it must not be offered here.
    expect(labels).not.toContain("cellSize");
  });

  it("completes a partially typed key", () => {
    const result = complete("```array\nactiveI|\n```\n");
    expect(result!.from).toBe(result!.to! - "activeI".length);
    expect(result!.options.map((o) => o.label)).toContain("activeIndices");
  });

  it("stays quiet mid-value, where a key makes no sense", () => {
    expect(complete("```array\nvalues: [1, |\n```\n")).toBeNull();
  });
});

describe("fenceDiagnostics", () => {
  it("finds nothing in a valid fence", () => {
    expect(fenceDiagnostics(state("```array\nvalues: [1, 2]\n```\n"))).toEqual([]);
  });

  it("reports a misspelled key on its own line", () => {
    const doc = "intro\n\n```array\nvalues: [1]\nactiveIndicies: [0]\n```\n";
    const [issue] = fenceDiagnostics(state(doc));
    expect(issue!.severity).toBe("warning");
    expect(issue!.message).toContain("activeIndices");
    // Line 5 of the document is where the typo is.
    expect(state(doc).doc.lineAt(issue!.from).number).toBe(5);
  });

  it("reports a missing required key", () => {
    const issues = fenceDiagnostics(state("```bits\nbits: 4\n```\n"));
    expect(issues.some((i) => i.severity === "error" && i.message.includes("value"))).toBe(true);
  });

  it("reports a YAML syntax error", () => {
    const issues = fenceDiagnostics(state("```kiwi-array\nvalues: [1,\n  bad: :\n```\n"));
    expect(issues.some((i) => i.severity === "error")).toBe(true);
  });

  it("leaves non-widget fences alone", () => {
    expect(fenceDiagnostics(state("```python\nvalues = [1,\n```\n"))).toEqual([]);
  });

  it("checks every fence on the page", () => {
    const doc = [
      "```array",
      "values: [1]",
      "nope: 1",
      "```",
      "",
      "```matrix",
      "values: [[1]]",
      "alsoNope: 1",
      "```",
      "",
    ].join("\n");
    expect(fenceDiagnostics(state(doc))).toHaveLength(2);
  });
});

describe("fencePreviewAt", () => {
  it("returns the body and meta of the fence the caret is in", () => {
    const { state: st, pos } = at('```array id=a caption="hi"\nvalues: [1, 2]\n|\n```\n');
    const target = fencePreviewAt(st, pos);
    expect(target?.lang).toBe("array");
    expect(target?.body).toContain("values: [1, 2]");
    expect(target?.meta).toBe('id=a caption="hi"');
  });

  it("has an empty meta when the opening line is just a tag", () => {
    const { state: st, pos } = at("```array\nvalues: [1]\n|\n```\n");
    expect(fencePreviewAt(st, pos)?.meta).toBe("");
  });

  it("returns nothing outside a widget fence", () => {
    const { state: st, pos } = at("# Heading\n\n|\n");
    expect(fencePreviewAt(st, pos)).toBeNull();
  });
});

describe("bounded scanning", () => {
  it("does not look further back than MAX_FENCE_LINES for an opening fence", () => {
    const prose = "text\n".repeat(MAX_FENCE_LINES + 5);
    const { state: st, pos } = at("```array\n" + prose + "|\n");
    expect(fenceAtCursor(st, pos)).toBeNull();
  });

  it("still finds a fence within the window", () => {
    const { state: st, pos } = at("```array\n" + "values: [1]\n".repeat(50) + "|\n```\n");
    expect(fenceAtCursor(st, pos)?.lang).toBe("array");
  });
});

describe("samePreviewTarget", () => {
  it("compares by content, not identity", () => {
    const a = { lang: "array", body: "values: [1]", meta: "" };
    expect(samePreviewTarget(a, { ...a })).toBe(true);
    expect(samePreviewTarget(a, { ...a, body: "values: [2]" })).toBe(false);
    expect(samePreviewTarget(null, null)).toBe(true);
    expect(samePreviewTarget(a, null)).toBe(false);
  });
});

describe("fenceLinter", () => {
  it("builds a CodeMirror extension", () => {
    expect(() => EditorState.create({ doc: "```array\nvalues: [1]\n```\n", extensions: fenceLinter() })).not.toThrow();
  });

  it("returns the same diagnostics for an unchanged fence on a re-run", () => {
    const st = state("```array\nvaluez: [1]\n```\n");
    expect(fenceDiagnostics(st)).toEqual(fenceDiagnostics(st));
    expect(fenceDiagnostics(st).length).toBeGreaterThan(0);
  });
});
