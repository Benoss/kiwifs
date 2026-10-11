import { describe, expect, it } from "vitest";
import { previewKey } from "./FencePreview";

describe("previewKey", () => {
  it("changes when an edit keeps the body the same length", () => {
    const a = previewKey({ lang: "array", body: "values: [1]", meta: "" });
    const b = previewKey({ lang: "array", body: "values: [2]", meta: "" });
    expect(a).not.toBe(b);
  });

  it("is stable for the same fence", () => {
    const t = { lang: "array", body: "values: [1, 2]", meta: "title=x" };
    expect(previewKey(t)).toBe(previewKey({ ...t }));
  });

  it("changes with the meta string", () => {
    const body = "values: [1]";
    expect(previewKey({ lang: "array", body, meta: "" })).not.toBe(previewKey({ lang: "array", body, meta: "x" }));
  });
});
