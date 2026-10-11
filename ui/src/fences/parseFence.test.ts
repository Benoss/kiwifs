import { afterEach, describe, expect, it } from "vitest";
import { keyLine, loadFenceYaml, parseFence, sniffFence } from "./parseFence";
import { parseFenceMeta, tokenizeMeta } from "./meta";
import { didYouMean, editDistance, serializeSchema, validateAttributes } from "./schema";
import { arraySpec } from "./specs/array";
import { treeSpec } from "./specs/tree";
import { tableSpec } from "./specs/table";
import { bitsSpec } from "./specs/bits";
import { stepsSpec } from "./specs/steps";
import { allFences, clearFences, getFence, isStrictTag, registerBuiltinFences, type FenceSpec } from "./index";
import { registerWidget, unregisterWidget } from "@kw/widgets/registry";

describe("parseFence", () => {
  it("splits base props from reserved keys", () => {
    const parsed = parseFence(arraySpec, `
values: [1, 2, 3]
caption: "a caption"
code: "x = 1"
lang: python
`);
    expect(parsed.base).toEqual({ values: [1, 2, 3] });
    expect(parsed.caption).toBe("a caption");
    expect(parsed.code).toBe("x = 1");
    expect(parsed.lang).toBe("python");
    expect(parsed.issues).toEqual([]);
  });

  it("merges each step over the previous one, so authors write deltas", () => {
    const parsed = parseFence(arraySpec, `
values: [1, 2, 3]
label: nums
steps:
  - activeIndices: [0]
  - activeIndices: [1]
  - dimIndices: [2]
`);
    expect(parsed.steps[0]).toEqual({ values: [1, 2, 3], label: "nums", activeIndices: [0] });
    expect(parsed.steps[1]).toEqual({ values: [1, 2, 3], label: "nums", activeIndices: [1] });
    // The third step inherits step 2's highlight, which is the point of a patch.
    expect(parsed.steps[2]).toEqual({
      values: [1, 2, 3],
      label: "nums",
      activeIndices: [1],
      dimIndices: [2],
    });
  });

  it("reads a step's `label` as the playback label, not as a widget prop", () => {
    // `label` is reserved inside a step. A row title that has to change
    // mid-animation goes through `props:`.
    const parsed = parseFence(arraySpec, `
values: [1]
steps:
  - label: "step one"
  - props: {label: dp}
`);
    expect(parsed.stepMeta[0]!.label).toBe("step one");
    expect(parsed.steps[0]!.label).toBeUndefined();
    expect(parsed.steps[1]!.label).toBe("dp");
  });

  it("merges each frame over the base instead", () => {
    const parsed = parseFence(arraySpec, `
values: [1, 2, 3]
frames:
  - activeIndices: [0]
  - highlightIndices: [2]
`);
    expect(parsed.steps[1]).toEqual({ values: [1, 2, 3], highlightIndices: [2] });
  });

  it("takes a bare string step as a note over unchanged props", () => {
    const parsed = parseFence(arraySpec, `
values: [1]
steps:
  - "first"
  - "second"
`);
    expect(parsed.stepMeta.map((m) => m.note)).toEqual(["first", "second"]);
    expect(parsed.steps[0]).toEqual({ values: [1] });
  });

  it("pulls note, line, breakpoint and why out of a step", () => {
    const parsed = parseFence(arraySpec, `
values: [1]
steps:
  - note: why not
    line: 4
    breakpoint: true
    duration: 1200
    why: {"0": "because"}
`);
    expect(parsed.stepMeta[0]).toEqual({
      note: "why not",
      line: 4,
      breakpoint: true,
      duration: 1200,
      why: { "0": "because" },
    });
    expect(parsed.steps[0]).toEqual({ values: [1] });
  });

  it("lets props: carry a prop whose name is reserved", () => {
    const parsed = parseFence(tableSpec, `
columns: [{key: a}]
rows: []
title: "fence title"
props:
  title: "widget title"
`);
    expect(parsed.title).toBe("fence title");
    expect(parsed.base.title).toBe("widget title");
  });

  it("reports a misspelled key with a suggestion and a line number", () => {
    const parsed = parseFence(arraySpec, `values: [1]\nactiveIndicies: [0]\n`);
    const issue = parsed.issues.find((i) => i.path === "activeIndicies");
    expect(issue?.message).toContain('did you mean "activeIndices"');
    expect(issue?.line).toBe(2);
    expect(issue?.severity).toBe("warning");
  });

  it("errors on a missing required key", () => {
    const parsed = parseFence(bitsSpec, `bits: 4\n`);
    expect(parsed.issues.some((i) => i.severity === "error" && i.path === "value")).toBe(true);
  });

  it("errors when none of a one-of group is present", () => {
    // A table needs its rows from somewhere: `rows:` or `fromData:`.
    const parsed = parseFence(tableSpec, `columns: [{key: a}]\n`);
    const issue = parsed.issues.find((i) => i.severity === "error");
    expect(issue?.message).toContain('needs one of "rows", "fromData"');
  });

  it("accepts either member of a one-of group", () => {
    expect(parseFence(tableSpec, `columns: [{key: a}]\nrows: []\n`).issues).toEqual([]);
    expect(parseFence(tableSpec, `fromData: latency\n`).issues).toEqual([]);
  });

  it("errors on the wrong type", () => {
    const parsed = parseFence(tableSpec, `columns: "a, b"\nrows: []\n`);
    expect(parsed.issues.find((i) => i.path === "columns")?.message).toContain("must be array");
  });

  it("accepts a mapping keyed by node index", () => {
    // `activeKeys: {0: [0]}` is how a B-tree page says "light the first key
    // of the root". js-yaml gives string keys; the Go linter sees integer
    // ones, and both have to call this an object.
    const parsed = parseFence(treeSpec, `
root:
  keys: [20, 60]
steps:
  - activeKeys: {0: [0]}
`);
    expect(parsed.issues).toEqual([]);
  });

  it("accepts a bare value where a highlight set is expected", () => {
    const parsed = parseFence(arraySpec, `values: [1, 2]\nactiveIndices: 1\n`);
    expect(parsed.issues).toEqual([]);
  });

  it("refuses to let a step change a layout constant", () => {
    const parsed = parseFence(arraySpec, `
values: [1]
steps:
  - cellSize: 80
`);
    expect(parsed.issues.find((i) => i.path === "steps[0].cellSize")?.message).toContain(
      "cannot change between steps",
    );
  });

  it("surfaces a YAML syntax error instead of rendering nothing", () => {
    const parsed = parseFence(arraySpec, `values: [1,\n  bad: :\n`);
    expect(parsed.error).toBeTruthy();
  });

  it("rejects a body that is not a mapping", () => {
    expect(parseFence(arraySpec, `- 1\n- 2\n`).error).toContain("YAML mapping");
  });

  it("warns when both steps and frames are given", () => {
    const parsed = parseFence(arraySpec, `
values: [1]
steps:
  - note: a
frames:
  - activeIndices: [0]
`);
    expect(parsed.issues.some((i) => i.path === "frames")).toBe(true);
    expect(parsed.steps).toHaveLength(1);
  });
});

describe("sniffFence", () => {
  it("claims a bare tag only when a required key is present", () => {
    expect(sniffFence(treeSpec, "tree", "root:\n  value: 1\n")).toBe(true);
    expect(sniffFence(treeSpec, "tree", "fromArray: [1, 2]\n")).toBe(true);
  });

  it("leaves a directory listing in a ```tree fence alone", () => {
    const listing = "src/\n  widgets/\n    ArrayView.tsx\n  lib/\n";
    expect(sniffFence(treeSpec, "tree", listing)).toBe(false);
  });

  it("leaves a pipe table in a ```table fence alone", () => {
    expect(sniffFence(tableSpec, "table", "| a | b |\n|---|---|\n| 1 | 2 |\n")).toBe(false);
  });

  it("always claims the explicit kiwi- and widget: spellings", () => {
    expect(sniffFence(treeSpec, "kiwi-tree", "nonsense\n")).toBe(true);
    expect(sniffFence(treeSpec, "widget:tree", "nonsense\n")).toBe(true);
  });
});

describe("parseFenceMeta", () => {
  it("reads ids, clocks, flags and quoted captions", () => {
    const meta = parseFenceMeta('id=two-sum clock=a width=wide caption="Two pointers, moving in" loop');
    expect(meta.id).toBe("two-sum");
    expect(meta.clock).toBe("a");
    expect(meta.width).toBe("wide");
    expect(meta.caption).toBe("Two pointers, moving in");
    expect(meta.loop).toBe(true);
    expect(meta.autoplay).toBe(false);
  });

  it("defaults the clock to the id, so one name is enough", () => {
    expect(parseFenceMeta("id=heap").clock).toBe("heap");
  });

  it("keeps unknown pairs for a spec to read", () => {
    expect(parseFenceMeta("mode=chain").rest).toEqual({ mode: "chain" });
  });

  it("accepts a bare width token", () => {
    expect(parseFenceMeta("full").width).toBe("full");
  });

  it("keeps quoted values whole", () => {
    expect(tokenizeMeta('a="x y" b=z')).toEqual(["a=x y", "b=z"]);
  });

  it("returns defaults for no meta at all", () => {
    expect(parseFenceMeta(undefined)).toEqual({
      width: "inline",
      autoplay: false,
      loop: false,
      rest: {},
    });
  });
});

describe("schema", () => {
  it("measures edit distance and suggests within budget", () => {
    expect(editDistance("activeIndicies", "activeIndices")).toBe(1);
    expect(editDistance("kitten", "sitting")).toBe(3);
    expect(didYouMean("activeIndicies", ["activeIndices", "values"])).toBe("activeIndices");
    expect(didYouMean("zzz", ["activeIndices", "values"])).toBeUndefined();
  });

  it("checks allowed literal values", () => {
    const issues = validateAttributes(
      { attributes: { layout: { type: "string", matches: ["force", "dagre"] } } },
      { layout: "spiral" },
    );
    expect(issues[0]!.message).toContain("must be one of");
  });

  it("serialises to plain JSON for Go and MCP to read", () => {
    const json = serializeSchema({
      attributes: {
        values: { type: ["array", "string"], required: true, description: "cells" },
        cellSize: { type: "number", steppable: false, description: "px" },
      },
    });
    expect(json.values).toEqual({ type: "array|string", required: true, description: "cells" });
    expect(json.cellSize).toEqual({ type: "number", description: "px", steppable: false });
  });
});

describe("keyLine", () => {
  it("finds a top-level key", () => {
    expect(keyLine("a: 1\nb: 2\n", "b")).toBe(2);
  });

  it("finds a key inside a list entry", () => {
    expect(keyLine("steps:\n  - note: hi\n", "note")).toBe(2);
  });

  it("returns undefined for a key that is not written down", () => {
    expect(keyLine("a: 1\n", "b")).toBeUndefined();
  });
});

describe("the registry", () => {
  it("resolves a bare tag, a kiwi- alias and a widget: alias to one spec", () => {
    expect(getFence("array")).toBe(getFence("kiwi-array"));
    expect(getFence("array")).toBe(getFence("widget:array"));
  });

  it("knows nothing about an unregistered name", () => {
    expect(getFence("nope")).toBeUndefined();
    expect(getFence(undefined)).toBeUndefined();
  });

  it("gives every built-in a description and a parseable example", () => {
    const specs = allFences();
    expect(specs.length).toBeGreaterThan(10);
    for (const spec of specs) {
      expect(spec.description, spec.lang).toBeTruthy();
      const body = spec.example.replace(/^```[^\n]*\n/, "").replace(/```$/, "");
      const parsed = parseFence(spec, body);
      expect(parsed.error, `${spec.lang}: ${parsed.error}`).toBeUndefined();
      const errors = parsed.issues.filter((i) => i.severity === "error");
      expect(errors, `${spec.lang}: ${JSON.stringify(errors)}`).toEqual([]);
    }
  });

  it("warns about no unknown keys in any built-in example", () => {
    for (const spec of allFences()) {
      const body = spec.example.replace(/^```[^\n]*\n/, "").replace(/```$/, "");
      const warnings = parseFence(spec, body).issues.filter((i) => i.severity === "warning");
      expect(warnings, `${spec.lang}: ${JSON.stringify(warnings)}`).toEqual([]);
    }
  });
});

describe("the kiwi-steps spec", () => {
  it("reveals one more sequence message per step", () => {
    const parsed = parseFence(stepsSpec, `
diagram: |
  sequenceDiagram
    A->>B: one
    B->>C: two
    C->>A: three
steps:
  - note: a
  - note: b
  - note: c
`);
    const prepared = stepsSpec.prepare!(parsed);
    expect(prepared.steps.map((s) => s.messages)).toEqual([1, 2, 3]);
  });

  it("leaves a flowchart's steps alone", () => {
    const parsed = parseFence(stepsSpec, `
diagram: |
  flowchart LR
    A --> B
steps:
  - focus: [A]
  - focus: [B]
`);
    const prepared = stepsSpec.prepare!(parsed);
    expect(prepared.steps.every((s) => s.messages === undefined)).toBe(true);
  });

  it("reads an old-format body the way lib/stepsBlock did: every step stands alone", () => {
    const parsed = parseFence(stepsSpec, `
diagram: |
  flowchart LR
    A --> B --> C
steps:
  - note: "start"
    dim: [B]
  - focus: [B]
  - focus: A, B
    dim: C
  - "just a note"
`);
    expect(parsed.issues).toEqual([]);
    const shown = parsed.steps.map((s) => stepsSpec.normalize!(s));
    expect(shown.map((s) => [s.focus, s.dim])).toEqual([
      [[], ["B"]],
      // Not dimmed any more: the previous step's `dim` does not carry over.
      [["B"], []],
      [["A", "B"], ["C"]],
      [[], []],
    ]);
  });

  it("counts sequence messages from what each step wrote, not what it inherited", () => {
    const parsed = parseFence(stepsSpec, `
diagram: |
  sequenceDiagram
    A->>B: one
    B->>C: two
    C->>A: three
steps:
  - messages: 3
  - note: b
  - note: c
`);
    expect(stepsSpec.prepare!(parsed).steps.map((s) => s.messages)).toEqual([3, 2, 3]);
  });

  it("requires a non-empty steps list", () => {
    const parsed = parseFence(stepsSpec, `diagram: "flowchart LR\\n  A --> B"\n`);
    expect(parsed.issues.find((i) => i.path === "steps")?.severity).toBe("error");
  });

  it("is the `steps` spec, spelled kiwi-steps without a doubled prefix", () => {
    expect(stepsSpec.lang).toBe("steps");
    expect(getFence("kiwi-steps")).toBe(stepsSpec);
    expect(getFence("kiwi-kiwi-steps")).toBeUndefined();
    expect(getFence("widget:kiwi-steps")).toBeUndefined();
  });
});

describe("strictness by spelling", () => {
  const listing = "src/\n  widgets/\n    ArrayView.tsx\n";

  it("knows kiwi- and widget: as the only strict prefixes", () => {
    expect(isStrictTag("kiwi-array")).toBe(true);
    expect(isStrictTag("Widget:array")).toBe(true);
    expect(isStrictTag("array")).toBe(false);
    expect(isStrictTag("heap")).toBe(false);
  });

  it("sniffs declared aliases instead of claiming them", () => {
    const heap = getFence("heap")!;
    expect(sniffFence(heap, "heap", "the heap grows upward\n")).toBe(false);
    const grid = getFence("grid")!;
    expect(sniffFence(grid, "grid", "a b c\nd e f\n")).toBe(false);
    expect(sniffFence(grid, "grid", "values: [[1, 2]]\n")).toBe(true);
    expect(sniffFence(stepsSpec, "steps", "1. do this\n2. then that\n")).toBe(false);
    expect(sniffFence(stepsSpec, "kiwi-steps", "1. do this\n")).toBe(true);
  });

  it("sniffs a case variant", () => {
    expect(getFence("Tree")).toBe(treeSpec);
    expect(sniffFence(treeSpec, "Tree", listing)).toBe(false);
  });

  it("finds marker keys under props:, in the first step or frame, and by alias", () => {
    expect(sniffFence(bitsSpec, "bits", "props: {value: 5}\n")).toBe(true);
    expect(sniffFence(bitsSpec, "bits", "bits: 4\nsteps:\n  - value: 5\n")).toBe(true);
    expect(sniffFence(bitsSpec, "bits", "bits: 4\nframes:\n  - value: 5\n")).toBe(true);
    const aliased: FenceSpec = {
      ...bitsSpec,
      required: undefined,
      schema: { attributes: { value: { type: "number", required: true, alias: "val" } } },
    };
    expect(sniffFence(aliased, "bits", "val: 5\n")).toBe(true);
  });
});

describe("step and frame validation", () => {
  it("lets a frame set a layout constant, since a frame is a full prop set", () => {
    const parsed = parseFence(arraySpec, `
values: [1]
frames:
  - cellSize: 80
`);
    expect(parsed.issues).toEqual([]);
  });

  it("accepts a fixed key restated unchanged in a step", () => {
    const parsed = parseFence(arraySpec, `
values: [1]
cellSize: 40
steps:
  - cellSize: 40
  - cellSize: 80
`);
    expect(parsed.issues.map((i) => i.path)).toEqual(["steps[1].cellSize"]);
  });

  it("treats a null required key as missing", () => {
    const parsed = parseFence(bitsSpec, `value:\n`);
    expect(parsed.issues.some((i) => i.path === "value" && i.severity === "error")).toBe(true);
    expect(validateAttributes(bitsSpec.schema, { value: null }).some((i) => i.path === "value")).toBe(true);
  });

  it("only counts a real yes as a breakpoint", () => {
    const parsed = parseFence(arraySpec, `
values: [1]
steps:
  - breakpoint: "no"
  - breakpoint: "true"
  - breakpoint: 1
`);
    expect(parsed.stepMeta.map((m) => m.breakpoint)).toEqual([false, true, false]);
  });

  it("never passes `props` itself through to the view", () => {
    const parsed = parseFence(arraySpec, `
values: [1]
steps:
  - props: {label: dp}
`);
    expect(parsed.steps[0]).toEqual({ values: [1], label: "dp" });
    expect(parsed.patches[0]).toEqual({ label: "dp" });
  });
});

describe("loadFenceYaml", () => {
  it("returns the same parse for the same text", () => {
    expect(loadFenceYaml("a: 1\n")).toBe(loadFenceYaml("a: 1\n"));
    expect(loadFenceYaml("a: [\n").error).toBeTruthy();
  });

  it("forgets the oldest entry past its bound", () => {
    const first = loadFenceYaml("evict: me\n");
    for (let i = 0; i < 250; i++) loadFenceYaml(`k: ${i}\n`);
    expect(loadFenceYaml("evict: me\n")).not.toBe(first);
  });
});

describe("legacy registerWidget components", () => {
  const Legacy = () => null;

  afterEach(() => unregisterWidget("thirdparty"));

  it("resolve only through an explicit spelling", () => {
    registerWidget("thirdparty", Legacy);
    expect(getFence("thirdparty")).toBeUndefined();
    expect(getFence("kiwi-thirdparty")?.legacy).toBe(true);
    expect(getFence("widget:thirdparty")?.component).toBe(Legacy);
  });

  it("never shadow a built-in", () => {
    registerWidget("array", Legacy);
    try {
      expect(getFence("kiwi-array")).toBe(arraySpec);
    } finally {
      unregisterWidget("array");
    }
  });
});

describe("clearFences", () => {
  it("lets the built-ins register again", () => {
    clearFences();
    expect(allFences()).toEqual([]);
    registerBuiltinFences();
    expect(getFence("array")).toBe(arraySpec);
  });
});
