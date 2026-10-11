import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { NumberLineView, axisRange, axisTicks, predicateRuns } from "./NumberLineView";
import { PlaneView } from "./PlaneView";
import { QueueView } from "./QueueView";
import { MapView, normalizeEntries } from "./MapView";
import { TableView, normalizeColumns } from "./TableView";
import { MemoryView } from "./MemoryView";
import { assignLanes, laneCount } from "./lanes";
import { niceTicks } from "./plotLayout";
import { shortText } from "./widgetA11y";

/** Widgets get raw YAML and model output; the types say nothing about it. */
const junk = (v: unknown): never => v as never;

function render(node: ReactElement): string {
  return renderToStaticMarkup(node);
}

function svgHeight(html: string): number {
  return Number(/<svg[^>]*\sheight="([\d.]+)"/.exec(html)?.[1]);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("NumberLineView on malformed input", () => {
  it("bounds the tick count however small the step", () => {
    expect(axisTicks(0, 1e6, { step: 1e-9 }).length).toBeLessThanOrEqual(24);
    const html = render(<NumberLineView min={0} max={1e6} step={1e-9} />);
    expect(html.match(/<text/g)!.length).toBeLessThan(30);
  });

  it("still honours a reasonable step", () => {
    expect(axisTicks(0, 10, { step: 2 })).toEqual([0, 2, 4, 6, 8, 10]);
  });

  it("does not allocate a lane per unit of a huge row", () => {
    const html = render(<NumberLineView min={0} max={10} intervals={[{ from: 1, to: 2, row: 1e9 }]} />);
    expect(svgHeight(html)).toBeLessThan(200);
  });

  it("swaps a reversed range and repairs a missing or NaN one", () => {
    expect(axisRange(10, 0)).toEqual({ min: 0, max: 10, step: undefined });
    expect(axisRange(NaN, undefined)).toEqual({ min: 0, max: 10, step: undefined });
    expect(axisRange(5, 5)).toEqual({ min: 0, max: 10, step: undefined });
    const html = render(<NumberLineView min={junk(NaN)} max={junk("x")} points={[{ x: 3 }]} />);
    expect(html).not.toContain("NaN");
    expect(render(<NumberLineView min={10} max={0} />)).toContain("number line from 0 to 10");
  });

  it("accepts xRange as [min, max, step]", () => {
    expect(axisRange(undefined, undefined, [0, 4, 1])).toEqual({ min: 0, max: 4, step: 1 });
    const html = render(<NumberLineView xRange={[0, 4, 1]} />);
    for (const n of ["0", "1", "2", "3", "4"]) expect(html).toContain(`>${n}</text>`);
  });

  it("puts log ticks on powers of ten and drops values that have no place on a log axis", () => {
    expect(axisTicks(1, 1000, { log: true })).toEqual([1, 10, 100, 1000]);
    const html = render(
      <NumberLineView min={1} max={1000} scale="log" points={[{ x: -5, label: "neg" }, { x: 0, label: "zero" }, { x: 10, label: "ten" }]} />,
    );
    expect(html).not.toContain("neg");
    expect(html).not.toContain("zero");
    expect(html).toContain("ten");
    const xs = [...html.matchAll(/<circle cx="([-\d.]+)"/g)].map((m) => Number(m[1]));
    for (const x of xs) {
      expect(x).toBeGreaterThanOrEqual(34);
      expect(x).toBeLessThanOrEqual(560 - 34);
    }
  });

  it("thins a very wide log range to a readable number of decades", () => {
    expect(axisTicks(1e-100, 1e100, { log: true }).length).toBeLessThanOrEqual(12);
  });

  it("ignores items that are not objects or have no coordinates", () => {
    const html = render(
      <NumberLineView
        min={0}
        max={10}
        points={junk([null, 3, { x: "a" }, { x: 2, label: "ok" }])}
        intervals={junk([null, { from: 1 }, { from: 1, to: 2 }])}
        rays={junk("nope")}
        marks={junk([{ at: null }])}
        pointers={junk([{ at: 5 }])}
        sweep={junk("x")}
      />,
    );
    expect(html).toContain("ok");
  });

  it("shades where a predicate holds", () => {
    const { runs } = predicateRuns("x > 5", 0, 10);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.from).toBeCloseTo(5, 1);
    expect(runs[0]!.to).toBe(10);
    const html = render(<NumberLineView min={0} max={10} predicate="x > 5" predicateLabel="feasible" />);
    expect(html).toContain("<rect");
    expect(html).toContain("feasible");
  });

  it("shades in log space on a log axis", () => {
    const { runs } = predicateRuns("x >= 100", 1, 1000, true);
    expect(runs[0]!.from).toBeGreaterThan(90);
    expect(runs[0]!.from).toBeLessThan(110);
  });

  it("reports a broken predicate instead of throwing", () => {
    expect(predicateRuns("x >", 0, 10).error).toBeTruthy();
    expect(predicateRuns("nope(x)", 0, 10).error).toBeTruthy();
    expect(render(<NumberLineView min={0} max={10} predicate="x >" />)).toContain("predicate:");
  });

  it("makes points and intervals selectable when they have an explanation", () => {
    const html = render(
      <NumberLineView
        min={0}
        max={10}
        points={[{ id: "p", x: 3 }]}
        intervals={[{ id: 7, from: 1, to: 4 }]}
        why={{ p: "the answer", "interval:7": "candidates" }}
        selected={[7]}
      />,
    );
    expect(html).toContain('role="graphics-document"');
    expect(html.match(/role="graphics-symbol"/g)).toHaveLength(2);
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    expect(html).toContain('aria-selected="true"');
  });

  it("matches numeric ids against string highlights", () => {
    const html = render(<NumberLineView min={0} max={10} points={[{ id: 1, x: 3 }]} activeIds={["1"]} />);
    expect(html).toContain("widget-active");
  });
});

describe("lanes", () => {
  it("clamps a garbage lane instead of filling a billion holes", () => {
    const lanes = assignLanes([{ start: 0, end: 1, lane: 1e9 }, { start: 0, end: 1 }]);
    expect(lanes[0]).toBeLessThanOrEqual(256);
    expect(lanes[1]).toBe(0);
  });

  it("keeps small declared lanes as written", () => {
    expect(assignLanes([{ start: 0, end: 1, lane: 3 }])).toEqual([3]);
  });

  it("counts lanes without spreading a huge array", () => {
    expect(laneCount(Array.from({ length: 200_000 }, () => 0))).toBe(1);
  });
});

describe("PlaneView on malformed input", () => {
  it("skips a polygon with no points and shapes that are not objects", () => {
    const html = render(
      <PlaneView
        polygons={junk([{ label: "nothing" }, null, { points: "abc" }])}
        points={junk([null, { x: "a", y: 1 }, { x: 1, y: 1, label: "ok" }])}
        segments={junk([{ from: "nope", to: [1, 1] }, 5])}
        circles={junk([{ at: [1, 1] }])}
      />,
    );
    expect(html).toContain("ok");
    expect(html).not.toContain("nothing");
  });

  it("orders a reversed range and keeps box sizes positive in a tiny canvas", () => {
    const html = render(<PlaneView xMin={10} xMax={0} yMin={5} yMax={5} width={10} height={10} circles={[{ at: [5, 5], r: -2 }]} />);
    expect(html).not.toMatch(/(width|height|r)="-/);
    expect(html).not.toContain("NaN");
    expect(html).toContain("coordinate plane from (0, 0) to (10, 10)");
  });

  it("colours each arrowhead like its line", () => {
    const html = render(
      <PlaneView
        segments={[{ from: [0, 0], to: [1, 1], arrow: true, color: "red" }]}
        vectors={[{ to: [2, 2], color: "blue" }]}
      />,
    );
    expect(html.match(/<marker/g)).toHaveLength(2);
    expect(html).toMatch(/<marker[^>]*>.*fill="red"/);
    expect(html).toMatch(/<marker[^>]*>.*fill="blue"/);
  });

  it("names a point pt<index> for both highlights and references", () => {
    const html = render(
      <PlaneView
        points={[{ x: 1, y: 1 }, { x: 5, y: 5 }]}
        segments={[{ from: "pt0", to: 1 }]}
        activeIds={["pt1"]}
      />,
    );
    expect(html).toContain("<line x1=");
    expect(html.match(/fill="var\(--kw-widget-active/g)).toHaveLength(1);
  });

  it("shades a predicate region on a bounded grid", () => {
    const html = render(<PlaneView regions={[{ when: "x + y <= 6", label: "feasible", resolution: 1000 }]} />);
    expect(html).toContain("feasible");
    const rects = html.match(/<rect/g)!.length;
    // At most one merged run per grid column, plus the frame.
    expect(rects).toBeLessThanOrEqual(61);
    expect(rects).toBeGreaterThan(5);
  });

  it("reports a broken region formula under the plane", () => {
    expect(render(<PlaneView regions={[{ when: "x <" }]} />)).toContain("region:");
  });

  it("lets the reader select a point with an explanation", () => {
    const html = render(<PlaneView points={[{ id: "a", x: 1, y: 1 }]} why={{ a: "the pivot" }} selected="a" />);
    expect(html).toContain('role="graphics-symbol"');
    expect(html).toContain('aria-selected="true"');
  });
});

describe("QueueView on malformed input", () => {
  it("renders with no values at all", () => {
    expect(render(<QueueView values={junk(undefined)} />)).toContain("(empty)");
    expect(render(<QueueView values={junk("abc")} layout="ring" />)).toContain("<svg");
  });

  it("clamps an enormous or negative capacity", () => {
    const huge = render(<QueueView values={[1]} capacity={1e9} />);
    expect(huge).toContain("queue of 1024 slots");
    expect(render(<QueueView values={[1]} capacity={-5} />)).toContain("queue of 1 slots");
  });

  it("wraps pointer indices around a ring", () => {
    const html = render(
      <QueueView layout="ring" capacity={6} values={[]} pointers={[{ index: 7, label: "tail" }, { index: -1, label: "last" }]} />,
    );
    expect(html).toContain("tail");
    expect(html).toContain("last");
  });

  it("tells a full ring from an empty one when front meets back", () => {
    const vals = ["a", "b", "c", "d"];
    expect(render(<QueueView layout="ring" values={vals} front={2} back={2} size={4} />)).toContain(">full<");
    expect(render(<QueueView layout="ring" values={vals} front={2} back={2} size={0} />)).toContain(">empty<");
    expect(render(<QueueView layout="ring" values={vals} front={1} back={3} size={2} />)).toContain(">2/4<");
  });

  it("draws the front marker at 0 when front is omitted", () => {
    expect(render(<QueueView values={["a"]} />)).toContain("front");
  });

  it("grows the ring with the slot count", () => {
    const small = svgHeight(render(<QueueView layout="ring" values={[]} capacity={6} />));
    const big = svgHeight(render(<QueueView layout="ring" values={[]} capacity={40} />));
    expect(big).toBeGreaterThan(small);
  });

  it("shows an object slot as JSON", () => {
    const html = render(<QueueView values={junk([{ a: 1 }])} />);
    expect(html).not.toContain("[object Object]");
    expect(html).toContain("{&quot;a&quot;:1}");
  });

  it("marks a controlled selection", () => {
    expect(render(<QueueView values={[1, 2]} why={{ "1": "next" }} selected={[1]} />)).toContain('aria-selected="true"');
  });
});

describe("MapView on malformed input", () => {
  it("accepts entries written as a plain object", () => {
    expect(normalizeEntries({ apple: 3, pear: 1 })).toEqual([
      { key: "apple", value: 3 },
      { key: "pear", value: 1 },
    ]);
    const html = render(<MapView entries={junk({ apple: 3 })} />);
    expect(html).toContain("apple: 3");
  });

  it("clamps an enormous capacity and never shows a negative load", () => {
    expect(render(<MapView mode="open" slots={[]} capacity={1e9} />)).toContain("α = 0/1024 = 0.00");
    const neg = render(<MapView mode="open" slots={[]} capacity={-3} />);
    expect(neg).toContain("α = 0/0 = 0.00");
    expect(neg).not.toContain("-0.00");
  });

  it("survives a long chain without spreading it into Math.max", () => {
    const chain = Array.from({ length: 200_000 }, (_, i) => ({ key: i }));
    const html = render(<MapView mode="chain" slots={[chain]} showIndices={false} />);
    expect(html).toContain(`+${200_000 - 32} more`);
    expect(html).toContain("α = 200000/1 = 200000.00");
  });

  it("keeps every slot level when only some are on the probe path", () => {
    const html = render(<MapView mode="open" slots={[{ key: "a" }, { key: "b" }, { key: "c" }]} probePath={[1]} />);
    expect(html.match(/visibility:hidden/g)?.length).toBe(2);
    expect(html).toContain("1↓");
  });

  it("shows the hash badge in chain and open modes too", () => {
    expect(render(<MapView mode="chain" slots={[[{ key: "a" }]]} hashOf={{ a: 0 }} />)).toContain("h=0");
    expect(render(<MapView mode="open" slots={[{ key: "a" }]} hashOf={{ a: 0 }} />)).toContain("h=0");
    expect(render(<MapView mode="open" slots={[{ key: "constructor" }]} hashOf={{}} />)).not.toContain("h=");
  });

  it("counts entries, not buckets, for a chained load factor", () => {
    const html = render(<MapView mode="chain" slots={[[{ key: "a" }, { key: "b" }, { key: "c" }], null]} />);
    expect(html).toContain("α = 3/2 = 1.50");
  });

  it("renders a primitive slot as its key", () => {
    const html = render(<MapView mode="open" slots={junk([7, "x", null])} />);
    expect(html).toContain(">7<");
    expect(html).toContain(">x<");
  });

  it("shows object values as JSON", () => {
    const html = render(<MapView entries={junk([{ key: "k", value: { n: 1 } }])} />);
    expect(html).not.toContain("[object Object]");
  });

  it("puts only the first selectable slot in the tab order and exposes its parts", () => {
    const html = render(<MapView mode="open" slots={[null, null, { key: "a" }, { key: "b" }]} why={{ "2": "a", "3": "b" }} />);
    expect(html).toContain('role="graphics-document"');
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    expect(html.match(/tabindex="-1"/g)).toHaveLength(1);
  });

  it("stays an image when nothing is selectable", () => {
    expect(render(<MapView mode="open" slots={[null]} />)).toContain('role="img"');
  });

  it("joins the probe path with arrows", () => {
    const html = render(<MapView mode="open" slots={[null, null, null, null]} probePath={[1, 2, 3]} />);
    expect(html.match(/marker-end/g)).toHaveLength(2);
    expect(html).toContain("1↓");
  });

  it("drops probe steps outside the table", () => {
    const html = render(<MapView mode="open" slots={[null, null]} probePath={junk([0, 99, "x", 1])} />);
    expect(html.match(/marker-end/g)).toHaveLength(1);
  });
});

describe("TableView on malformed input", () => {
  it("normalises string columns and columns with no key", () => {
    expect(normalizeColumns(["a", { label: "B" }, null, {}])).toEqual([
      { key: "a" },
      { key: "B", label: "B" },
      { key: "col3", label: undefined },
    ]);
    const html = render(<TableView columns={junk(["a", "b"])} rows={[{ a: 1, b: 2 }]} />);
    expect(html).toContain(">a<");
    expect(html).toContain(">2<");
  });

  it("does not crash on a keyless column with no sort", () => {
    expect(() => render(<TableView columns={junk([{ label: "x" }, {}])} rows={[{ x: 1 }]} />)).not.toThrow();
  });

  it("accepts a sort given as a bare column key", () => {
    expect(render(<TableView columns={["a"]} rows={[{ a: 1 }]} sort="a" />)).toContain("▲");
  });

  it("skips rows that are not objects", () => {
    const html = render(<TableView columns={["a"]} rows={junk([null, 1, "x", [1], { a: "ok" }])} />);
    expect(html).toContain("ok");
    expect(html.match(/<tr/g)).toHaveLength(2);
  });

  it("matches numeric row keys from YAML against string ids", () => {
    const html = render(
      <TableView
        columns={[{ key: "id", pk: true }, { key: "v" }]}
        rows={[{ id: 1, v: "x" }, { id: 2, v: "y" }]}
        activeRows={[1]}
        deletedRows={2}
      />,
    );
    expect(html).toContain("widget-active");
    expect(html).toContain("line-through");
  });

  it("addresses cells by [row, col] tuples and by keys containing dots", () => {
    const rows = [{ id: "a.b", c: "hit" }, { id: "z", c: "miss" }];
    const cols = [{ key: "id", pk: true }, { key: "c" }];
    const activeText = (activeCells: unknown) => {
      const html = render(<TableView columns={cols} rows={rows} activeCells={junk(activeCells)} />);
      return [...html.matchAll(/<td[^>]*background:([^;"]+)[^>]*>(?:<[^>]+>)*([^<]*)/g)]
        .filter((m) => m[1]!.includes("widget-active"))
        .map((m) => m[2]);
    };
    expect(activeText(["a.b.c"])).toEqual(["hit"]);
    expect(activeText([["a.b", "c"]])).toEqual(["hit"]);
    expect(activeText(["z", "c"])).toEqual(["miss"]);
  });

  it("renders duplicate and missing primary keys as distinct rows, warning once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const html = render(
      <TableView
        columns={[{ key: "id", pk: true }, { key: "id" }]}
        rows={[{ id: 1 }, { id: 1 }, { id: null }, {}]}
      />,
    );
    expect(html.match(/<tr/g)).toHaveLength(5);
    expect(warn).toHaveBeenCalledTimes(1);
    render(<TableView columns={["k"]} rows={[{ k: 1 }, { k: 1 }]} rowKey="k" />);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("ignores a NaN or negative maxRows", () => {
    const rows = Array.from({ length: 4 }, (_, i) => ({ a: i }));
    expect(render(<TableView columns={["a"]} rows={rows} maxRows={NaN} />)).not.toContain("more");
    expect(render(<TableView columns={["a"]} rows={rows} maxRows={-1} />)).not.toContain("more");
    expect(render(<TableView columns={["a"]} rows={rows} maxRows={0} />)).toContain("4 more rows");
  });

  it("renders a foreign key written as a string", () => {
    expect(render(<TableView columns={junk([{ key: "u", fk: "users.id" }])} rows={[{ u: 1 }]} />)).toContain("→ users.id");
  });

  it("shows object cells as JSON", () => {
    const html = render(<TableView columns={["a"]} rows={junk([{ a: { x: [1, 2] } }])} />);
    expect(html).not.toContain("[object Object]");
    expect(html).toContain("{&quot;x&quot;:[1,2]}");
  });

  it("marks a controlled selection", () => {
    const html = render(
      <TableView columns={[{ key: "id", pk: true }]} rows={[{ id: 1 }]} why={{ "1.id": "the key" }} selected={["1.id"]} />,
    );
    expect(html).toContain('aria-selected="true"');
  });
});

describe("MemoryView on malformed input", () => {
  it("renders frames without vars, odd orders, bad pairs and untagged heap values", () => {
    const html = render(
      <MemoryView
        frames={junk([{ name: "f" }, { name: "g", vars: { a: ["REF", 1], b: ["REF", 2] }, order: "a" }, null])}
        heap={junk({ 1: ["DICT", ["k", 1], "junk"], 2: { val: 3 }, 3: 42 })}
      />,
    );
    expect(html).toContain("(no locals)");
    expect(html).toContain("&quot;k&quot;");
    expect(html).toContain("val");
    expect(html).toContain(">42<");
  });

  it("survives heap and frames of the wrong type", () => {
    expect(() => render(<MemoryView frames={junk("x")} heap={junk([1, 2])} />)).not.toThrow();
  });

  it("treats a numeric activeFrame as a frame index", () => {
    const html = render(
      <MemoryView frames={[{ name: "outer", vars: {} }, { name: "inner", vars: {} }]} activeFrame={0} />,
    );
    const borders = [...html.matchAll(/border:2px solid ([^;"]+)/g)].map((m) => m[1]);
    expect(borders[0]).toContain("widget-active");
    expect(borders[1]).toContain("widget-border");
  });

  it("matches numeric heap ids against string highlights and vice versa", () => {
    const html = render(
      <MemoryView frames={[{ name: "f", vars: { a: ["REF", 1] } }]} heap={{ 1: ["LIST", 1] }} activeIds={["1"]} />,
    );
    expect(html).toMatch(/data-cell="obj:1"[^>]*border:2px solid var\(--kw-widget-active/);
  });

  it("boxes frame primitives on the heap when inlinePrimitives is false", () => {
    const frames = [{ name: "f", vars: { n: 3, s: "hi", xs: ["REF", 1] as const } }];
    const inline = render(<MemoryView frames={frames} heap={{ 1: ["LIST"] }} />);
    expect(inline).not.toContain("obj:prim:");
    const boxed = render(<MemoryView frames={frames} heap={{ 1: ["LIST"] }} inlinePrimitives={false} />);
    expect(boxed).toContain('data-cell="obj:prim:f#0.n"');
    expect(boxed).toContain(">int<");
    expect(boxed).toContain(">str<");
  });

  it("shows an inline structure in a frame as JSON", () => {
    const html = render(<MemoryView frames={junk([{ name: "f", vars: { xs: ["LIST", 1, 2] } }])} />);
    expect(html).toContain("[&quot;LIST&quot;,1,2]");
  });
});

describe("shortText", () => {
  it("truncates long JSON", () => {
    const text = shortText({ a: "x".repeat(200) });
    expect(text.length).toBe(60);
    expect(text.endsWith("…")).toBe(true);
  });

  it("survives a cycle", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(shortText(a)).toBe("{…}");
  });
});

describe("niceTicks", () => {
  it("never repeats a tick on a tiny range", () => {
    for (const [lo, hi] of [
      [0, 1e-10],
      [1, 1 + 1e-10],
      [1e6, 1e6 + 1e-10],
    ]) {
      const ticks = niceTicks(lo!, hi!, 5);
      expect(new Set(ticks).size).toBe(ticks.length);
      expect(ticks.length).toBeGreaterThan(0);
    }
    expect(niceTicks(0, 1e-10, 5).length).toBeGreaterThan(2);
  });

  it("keeps ordinary ranges exactly as before", () => {
    expect(niceTicks(0, 10, 6)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(niceTicks(0, 1, 5)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
  });
});
