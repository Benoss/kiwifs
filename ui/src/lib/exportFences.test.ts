import { describe, expect, it } from "vitest";
import { rewriteWidgetFences, summarizeFenceBody } from "./exportFences";

const page = [
  "# Two Sum",
  "",
  "```array id=two-sum",
  "values: [2, 7, 11]",
  "caption: Two pointers meet",
  "activeIndices: [0]",
  "steps:",
  "  - note: lo moves right",
  "  - note: they cross",
  "```",
  "",
  "Closing prose.",
  "",
].join("\n");

describe("summarizeFenceBody", () => {
  it("keeps the prose and drops the coordinates", () => {
    const got = summarizeFenceBody(
      "values: [1]\ncaption: A sweep\nactiveIndices: [0]\nsteps:\n  - note: first\n",
    );
    expect(got).toBe("A sweep\nfirst");
  });

  it("keeps a code listing, which a reader can act on", () => {
    expect(summarizeFenceBody('values: [1]\ncode: "x = 1"\n')).toContain("x = 1");
  });

  it("returns nothing for a body it cannot read", () => {
    expect(summarizeFenceBody("values: [1,\n bad: :\n")).toBe("");
    expect(summarizeFenceBody("- a\n- b\n")).toBe("");
  });
});

describe("rewriteWidgetFences", () => {
  it("keeps the surrounding page intact", () => {
    const got = rewriteWidgetFences(page);
    expect(got).toContain("# Two Sum");
    expect(got).toContain("Closing prose.");
  });

  it("quotes the prose and keeps the data as YAML", () => {
    const got = rewriteWidgetFences(page);
    expect(got).toContain("> Two pointers meet");
    expect(got).toContain("> lo moves right");
    expect(got).toContain("Interactive array widget");
    expect(got).toContain("```yaml");
    expect(got).toContain("values: [2, 7, 11]");
    expect(got).not.toContain("```array");
  });

  it("leaves an ordinary code fence alone", () => {
    const code = "```python\nvalues = [1]\n```\n";
    expect(rewriteWidgetFences(code)).toBe(code);
  });

  it("leaves a directory listing in a ```tree fence alone", () => {
    const listing = "```tree\nsrc/\n  lib/\n```\n";
    expect(rewriteWidgetFences(listing)).toBe(listing);
  });

  it("handles a fence with nothing to say", () => {
    const got = rewriteWidgetFences("```array\nvalues: [1, 2]\n```\n");
    expect(got).toContain("Interactive array widget");
    expect(got).toContain("values: [1, 2]");
  });

  it("rewrites every fence on a page, not just the first", () => {
    const two = "```array\nvalues: [1]\ncaption: one\n```\n\n```array\nvalues: [2]\ncaption: two\n```\n";
    const got = rewriteWidgetFences(two);
    expect(got).toContain("> one");
    expect(got).toContain("> two");
  });
});
