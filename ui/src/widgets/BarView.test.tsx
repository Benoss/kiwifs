import { describe, expect, it } from "vitest";
import { binSamples } from "./BarView";

describe("binSamples", () => {
  it("falls back to ten bins for a NaN or junk binCount", () => {
    expect(binSamples({ samples: [1, 2, 3], binCount: NaN }).counts).toHaveLength(10);
    expect(binSamples({ samples: [1, 2, 3], binCount: "lots" as unknown as number }).counts).toHaveLength(10);
  });

  it("clamps the bin count", () => {
    expect(binSamples({ samples: [1], binCount: 0 }).counts).toHaveLength(1);
    expect(binSamples({ samples: [1], binCount: 10_000 }).counts).toHaveLength(200);
  });

  it("bins a sample set too large to spread into Math.min", () => {
    const samples = Array.from({ length: 300_000 }, (_, i) => i % 100);
    const { counts } = binSamples({ samples, binCount: 4 });
    expect(counts.reduce((a, b) => a + b, 0)).toBe(300_000);
  });

  it("puts the maximum in the last bin", () => {
    expect(binSamples({ samples: [0, 5, 10], binCount: 2 }).counts).toEqual([1, 2]);
  });
});
