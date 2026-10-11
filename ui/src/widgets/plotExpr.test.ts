import { describe, expect, it } from "vitest";
import { sampleRegion, sampleSeries, type PlotPoint } from "./plotLayout";

/** The shape sampleSeries works over; mirrors PlotSeries's relevant keys. */
type Series = {
  id?: string | number;
  label?: string;
  points?: PlotPoint[];
  expr?: string;
  samples?: number;
  domain?: [number, number];
};

describe("sampleSeries", () => {
  it("leaves point series untouched", () => {
    const input: Series[] = [{ points: [{ x: 0, y: 1 }] }];
    const { series, exprErrors } = sampleSeries(input, undefined);
    expect(series).toEqual(input);
    expect(exprErrors).toEqual([]);
  });

  it("samples a formula across the x axis", () => {
    const { series } = sampleSeries<Series>([{ expr: "x * 2", samples: 5 }], undefined, { xMin: 0, xMax: 4 });
    expect(series[0]!.points).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 2 },
      { x: 2, y: 4 },
      { x: 3, y: 6 },
      { x: 4, y: 8 },
    ]);
  });

  it("binds free names from the scope", () => {
    const { series } = sampleSeries<Series>([{ expr: "x + a", samples: 2 }], { a: 10 }, { xMin: 0, xMax: 1 });
    expect(series[0]!.points!.map((p) => p.y)).toEqual([10, 11]);
  });

  it("takes the x range from the other series when none is given", () => {
    const { series } = sampleSeries<Series>(
      [{ points: [{ x: 5, y: 0 }, { x: 7, y: 0 }] }, { expr: "x", samples: 3 }],
      undefined,
    );
    expect(series[1]!.points!.map((p) => p.x)).toEqual([5, 6, 7]);
  });

  it("honours a per-series domain", () => {
    const { series } = sampleSeries<Series>(
      [{ expr: "x", samples: 2, domain: [10, 20] }],
      undefined,
      { xMin: 0, xMax: 1 },
    );
    expect(series[0]!.points!.map((p) => p.x)).toEqual([10, 20]);
  });

  it("drops a pole instead of spiking off-canvas", () => {
    const { series } = sampleSeries<Series>([{ expr: "1 / x", samples: 3 }], undefined, { xMin: -1, xMax: 1 });
    // x = 0 gives Infinity, which is not plotted.
    expect(series[0]!.points!.map((p) => p.x)).toEqual([-1, 1]);
  });

  it("reports a broken formula by name instead of taking the chart down", () => {
    const { series, exprErrors } = sampleSeries<Series>(
      [{ label: "bad", expr: "1 +" }, { points: [{ x: 0, y: 0 }] }],
      undefined,
    );
    expect(series).toHaveLength(1);
    expect(exprErrors[0]).toContain("bad");
  });

  it("reports an unbound name", () => {
    const { exprErrors } = sampleSeries<Series>([{ label: "curve", expr: "x * qps" }], undefined, { xMin: 0, xMax: 1 });
    expect(exprErrors[0]).toMatch(/unknown name "qps"/);
  });

  it("clamps the sample count", () => {
    const { series } = sampleSeries<Series>([{ expr: "x", samples: 1 }], undefined, { xMin: 0, xMax: 1 });
    expect(series[0]!.points).toHaveLength(2);
  });
});

const unitSquare = { xMin: 0, xMax: 1, yMin: 0, yMax: 1 };

describe("sampleRegion", () => {
  it("covers the whole area for an always-true predicate", () => {
    const { cells } = sampleRegion("1", unitSquare, undefined, 4);
    expect(cells).toHaveLength(4);
    for (const cell of cells) {
      expect(cell.y0).toBe(0);
      expect(cell.y1).toBeCloseTo(1);
    }
  });

  it("covers nothing for an always-false predicate", () => {
    expect(sampleRegion("0", unitSquare, undefined, 4).cells).toEqual([]);
  });

  it("merges a column's run into one rectangle", () => {
    // y < 0.5 is a contiguous run per column, so one rect per column.
    const { cells } = sampleRegion("y < 0.5", unitSquare, undefined, 8);
    expect(cells).toHaveLength(8);
  });

  it("splits a column with a gap into separate rectangles", () => {
    const { cells } = sampleRegion("y < 0.2 or y > 0.8", unitSquare, undefined, 10);
    expect(cells.length).toBeGreaterThan(10);
  });

  it("binds extra names", () => {
    expect(sampleRegion("y < limit", unitSquare, { limit: 1 }, 4).cells).toHaveLength(4);
    expect(sampleRegion("y < limit", unitSquare, { limit: 0 }, 4).cells).toEqual([]);
  });

  it("reports a broken predicate", () => {
    expect(sampleRegion("y <", unitSquare, undefined, 4).error).toBeTruthy();
    expect(sampleRegion("y < limit", unitSquare, undefined, 4).error).toMatch(/unknown name "limit"/);
  });
});
