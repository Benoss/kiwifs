import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { InputPanel, takeRestorable, type InputField } from "./InputPanel";

const field = (key: string): InputField => ({ key, label: key, type: "number", defaultValue: 0 });

describe("takeRestorable", () => {
  it("returns every saved field in one batch", () => {
    const done = new Set<string>();
    expect(takeRestorable([field("a"), field("b"), field("c")], { a: 1, b: 2 }, done)).toEqual({ a: 1, b: 2 });
  });

  it("restores each field once, so a later save cannot snap a slider back", () => {
    const done = new Set<string>();
    takeRestorable([field("a")], { a: 1 }, done);
    expect(takeRestorable([field("a")], { a: 5 }, done)).toEqual({});
  });

  it("restores a field the fence added after the first load", () => {
    const done = new Set<string>();
    takeRestorable([field("a")], { a: 1, b: 2 }, done);
    expect(takeRestorable([field("a"), field("b")], { a: 1, b: 2 }, done)).toEqual({ b: 2 });
  });

  it("treats a missing document as nothing to restore", () => {
    const done = new Set<string>();
    expect(takeRestorable([field("a")], null, done)).toEqual({});
    expect(done.has("a")).toBe(true);
  });
});

describe("InputPanel", () => {
  it("still renders with only onChange", () => {
    const html = renderToStaticMarkup(
      <InputPanel fields={[field("n")]} values={{ n: 3 }} onChange={() => {}} />,
    );
    expect(html).toContain('value="3"');
  });
});
