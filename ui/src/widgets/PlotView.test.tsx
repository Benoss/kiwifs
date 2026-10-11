import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const hookCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useMemo: <T,>(factory: () => T, deps: unknown[]) => {
      hookCalls.count++;
      return actual.useMemo(factory, deps);
    },
  };
});

import { PlotView } from "./PlotView";

function hooksFor(props: Parameters<typeof PlotView>[0]): number {
  hookCalls.count = 0;
  renderToStaticMarkup(<PlotView {...props} />);
  return hookCalls.count;
}

describe("PlotView", () => {
  it("calls the same hooks with and without data, so data arriving does not crash", () => {
    const empty = hooksFor({ series: [] });
    const full = hooksFor({ series: [{ points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }] });
    expect(empty).toBeGreaterThan(0);
    expect(empty).toBe(full);
  });

  it("draws a regions-only plot instead of saying there is no data", () => {
    const html = renderToStaticMarkup(
      <PlotView series={[]} regions={[{ when: "y < x", label: "below" }]} xMin={0} xMax={1} yMin={0} yMax={1} />,
    );
    expect(html).not.toContain("(no data)");
    expect(html).toContain("<svg");
    expect(html).toContain("below");
  });

  it("treats a predicate that is NaN as false", () => {
    const html = renderToStaticMarkup(
      <PlotView series={[]} regions={[{ when: "sqrt(-1)" }]} xMin={0} xMax={1} yMin={0} yMax={1} />,
    );
    expect(html).toContain("(no data)");
  });

  it("says so when a formula is NaN across the whole domain", () => {
    const html = renderToStaticMarkup(
      <PlotView series={[{ expr: "sqrt(-1 - x^2)", label: "imaginary" }]} xMin={0} xMax={1} />,
    );
    expect(html).toContain("imaginary: no finite values over the x range");
  });

  it("does not flag a formula that drew", () => {
    const html = renderToStaticMarkup(
      <PlotView series={[{ expr: "x^2", label: "square" }, { points: [{ x: 0, y: 1 }] }]} xMin={0} xMax={1} />,
    );
    expect(html).not.toContain("no finite values");
    expect(html).toContain("<path");
  });

  it("still reports a parse error in a region predicate once", () => {
    const html = renderToStaticMarkup(
      <PlotView series={[{ points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }]} regions={[{ when: "y <" }]} />,
    );
    expect(html).toContain("expected");
    expect(html).not.toContain("abs(");
  });
});
