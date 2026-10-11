import { describe, expect, it } from "vitest";
import { assignLanes, legendLayout, stateLabel } from "./TimelineView";

describe("assignLanes", () => {
  it("keeps disjoint intervals on one lane", () => {
    expect(assignLanes([
      { start: 0, end: 5 },
      { start: 5, end: 10 },
      { start: 12, end: 20 },
    ])).toEqual([0, 0, 0]);
  });

  it("stacks overlapping intervals", () => {
    expect(assignLanes([
      { start: 0, end: 30 },
      { start: 5, end: 10 },
      { start: 15, end: 20 },
    ])).toEqual([0, 1, 1]);
  });

  it("needs as many lanes as the peak overlap", () => {
    const lanes = assignLanes([
      { start: 0, end: 10 },
      { start: 1, end: 10 },
      { start: 2, end: 10 },
    ]);
    expect(new Set(lanes).size).toBe(3);
  });

  it("honours an explicit lane", () => {
    expect(assignLanes([
      { start: 0, end: 5, lane: 2 },
      { start: 0, end: 5 },
    ])).toEqual([2, 0]);
  });

  it("does not reuse a lane an explicit interval already occupies", () => {
    expect(assignLanes([
      { start: 0, end: 10, lane: 0 },
      { start: 5, end: 15 },
    ])).toEqual([0, 1]);
  });

  it("tolerates a reversed interval", () => {
    expect(assignLanes([
      { start: 10, end: 0 },
      { start: 12, end: 20 },
    ])).toEqual([0, 0]);
  });
});

describe("assignLanes with named lanes", () => {
  it("packs unlaned intervals into rows below the named ones instead of lane 0", () => {
    expect(assignLanes([
      { start: 0, end: 10, lane: "cpu" },
      { start: 2, end: 8 },
      { start: 3, end: 9 },
      { start: 12, end: 14 },
    ], ["cpu", "io"])).toEqual([0, 2, 3, 2]);
  });

  it("puts unlaned rows after lanes named only by intervals", () => {
    expect(assignLanes([
      { start: 0, end: 1, lane: "disk" },
      { start: 0, end: 1 },
    ], ["cpu"])).toEqual([1, 2]);
  });

  it("is unchanged without named lanes", () => {
    expect(assignLanes([{ start: 0, end: 5, lane: 2 }, { start: 0, end: 5 }])).toEqual([2, 0]);
  });
});

describe("stateLabel", () => {
  it("prints inherited property names as themselves", () => {
    expect(stateLabel("constructor")).toBe("constructor");
    expect(stateLabel("toString")).toBe("toString");
    expect(stateLabel("blocked")).toBe("blocked");
  });
});

describe("legendLayout", () => {
  it("spaces items by label width rather than a fixed pitch", () => {
    const [a, b] = legendLayout(["a-very-long-state-name", "x"], 1000);
    expect(b!.x - a!.x).toBeGreaterThan(86);
  });

  it("wraps onto a second row when the labels do not fit", () => {
    const items = legendLayout(["running", "blocked", "waiting", "holding"], 120);
    expect(Math.max(...items.map((i) => i.row))).toBeGreaterThan(0);
    expect(items[0]).toEqual({ x: 0, row: 0 });
  });
});
