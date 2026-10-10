import { describe, expect, it } from "vitest";
import { fenceLang, fenceMeta, parseLineRanges } from "./FenceBlock";

describe("fenceLang", () => {
  it("reads the language out of react-markdown's class name", () => {
    expect(fenceLang("language-array")).toBe("array");
    expect(fenceLang("language-widget:live")).toBe("widget:live");
    expect(fenceLang("language-kiwi-steps")).toBe("kiwi-steps");
  });

  it("returns undefined for inline code with no language", () => {
    expect(fenceLang(undefined)).toBeUndefined();
    expect(fenceLang("")).toBeUndefined();
    expect(fenceLang("some-other-class")).toBeUndefined();
  });
});

describe("fenceMeta", () => {
  it("prefers data.meta, falling back to the rehype-copied property", () => {
    expect(fenceMeta({ data: { meta: 'id=a' } })).toBe("id=a");
    expect(fenceMeta({ properties: { metastring: "id=b" } })).toBe("id=b");
    expect(fenceMeta(undefined)).toBe("");
  });
});

describe("parseLineRanges", () => {
  it("expands singles and ranges", () => {
    expect([...parseLineRanges("1,3-5,8")]).toEqual([1, 3, 4, 5, 8]);
  });

  it("ignores junk rather than throwing", () => {
    expect([...parseLineRanges("1, ,x")]).toEqual([1]);
  });
});
