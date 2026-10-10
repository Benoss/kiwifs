import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TableView } from "./TableView";
import { NumberLineView } from "./NumberLineView";
import { PlaneView } from "./PlaneView";
import { MapView } from "./MapView";
import { TimelineView, assignLanes as assignTimelineLanes } from "./TimelineView";
import { TreeView } from "./TreeView";
import { heapTreeFromArray, layoutForest, nodeWidth } from "./treeLayout";
import { assignLanes, laneCount } from "./lanes";
import {
  summarizeArray,
  summarizeMap,
  summarizeStack,
  summarizeTable,
  summarizeTree,
} from "./widgetA11y";

describe("TableView", () => {
  const columns = [
    { key: "id", label: "id", pk: true, type: "int" },
    { key: "user", label: "user_id", fk: { table: "users", column: "id" } },
  ];
  const rows = [
    { id: 1, user: 7 },
    { id: 2, user: 9 },
  ];

  it("renders a real table with a sticky header", () => {
    const html = renderToStaticMarkup(<TableView columns={columns} rows={rows} />);
    expect(html).toContain("<table");
    expect(html).toContain('scope="col"');
    expect(html).toContain("sticky");
  });

  it("identifies rows by the primary key, so highlights survive a reorder", () => {
    // Row id 1 is drawn second here. `activeCells: ["1.user"]` must still land
    // on it — a positional `[r, c]` reference is exactly what it must not be.
    const activeCellText = (rowsIn: typeof rows) => {
      const html = renderToStaticMarkup(
        <TableView columns={columns} rows={rowsIn} activeCells={["1.user"]} />,
      );
      const cells = [...html.matchAll(/<td[^>]*background:([^;"]+)[^>]*>(?:<[^>]+>)*([^<]*)/g)];
      return cells.filter((m) => m[1]!.includes("widget-active")).map((m) => m[2]);
    };
    expect(activeCellText(rows)).toEqual(["7"]);
    expect(activeCellText([...rows].reverse())).toEqual(["7"]);
  });

  it("marks inserted and deleted rows", () => {
    const html = renderToStaticMarkup(
      <TableView columns={columns} rows={rows} insertedRows={["1"]} deletedRows={["2"]} />,
    );
    expect(html).toContain("line-through");
    expect(html).toContain("+");
  });

  it("truncates past maxRows and says how many are hidden", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ id: i, user: i }));
    const html = renderToStaticMarkup(<TableView columns={columns} rows={many} maxRows={3} />);
    expect(html).toContain("7 more rows");
  });

  it("says so when there are no rows at all", () => {
    expect(renderToStaticMarkup(<TableView columns={columns} rows={[]} />)).toContain("(no rows)");
  });
});

describe("NumberLineView", () => {
  it("draws open endpoints hollow and closed ones filled", () => {
    const html = renderToStaticMarkup(
      <NumberLineView min={0} max={10} intervals={[{ from: 2, to: 8, fromOpen: true }]} />,
    );
    // The hollow endpoint is filled with the surface color, not the stroke.
    expect(html).toContain("kw-widget-surface");
  });

  it("stacks overlapping intervals onto separate rows", () => {
    const html = renderToStaticMarkup(
      <NumberLineView
        min={0}
        max={10}
        intervals={[
          { from: 0, to: 8, label: "a" },
          { from: 2, to: 10, label: "b" },
        ]}
      />,
    );
    const heights = /height="(\d+)"/.exec(html);
    expect(Number(heights?.[1])).toBeGreaterThan(50);
  });

  it("points a ray at the edge of the axis", () => {
    const html = renderToStaticMarkup(
      <NumberLineView min={0} max={10} rays={[{ at: 4, dir: "right", open: true, label: "x > 4" }]} />,
    );
    expect(html).toContain("marker-end");
  });

  it("names itself from the data", () => {
    const html = renderToStaticMarkup(
      <NumberLineView min={1} max={9} points={[{ x: 3 }, { x: 7 }]} />,
    );
    expect(html).toContain("number line from 1 to 9");
  });
});

describe("PlaneView", () => {
  it("resolves a segment's ends from point ids or literal pairs", () => {
    const html = renderToStaticMarkup(
      <PlaneView
        xMin={0}
        xMax={10}
        yMin={0}
        yMax={10}
        points={[{ id: "a", x: 1, y: 1 }]}
        segments={[{ from: "a", to: [5, 5], arrow: true }]}
      />,
    );
    expect(html).toContain("<line");
    expect(html).toContain("marker-end");
  });

  it("keeps one data unit the same size on both axes by default", () => {
    // A square window over a non-square range must letterbox, not stretch.
    const html = renderToStaticMarkup(
      <PlaneView xMin={0} xMax={20} yMin={0} yMax={5} width={400} height={400} circles={[{ at: [10, 2], r: 2 }]} />,
    );
    const r = /<circle[^>]*\sr="([\d.]+)"/.exec(html);
    expect(Number(r?.[1])).toBeGreaterThan(0);
  });

  it("leaves a hull open when asked, so a work-in-progress reads as one", () => {
    const html = renderToStaticMarkup(
      <PlaneView
        points={[
          { id: "a", x: 0, y: 0 },
          { id: "b", x: 4, y: 1 },
          { id: "c", x: 8, y: 0 },
        ]}
        polygons={[{ points: ["a", "b", "c"], open: true }]}
      />,
    );
    const d = /<path[^>]*\sd="([^"]+)"/.exec(html.slice(html.indexOf("</defs>")));
    expect(d?.[1]).not.toContain("Z");
  });
});

describe("MapView", () => {
  it("draws chains inside their buckets", () => {
    const html = renderToStaticMarkup(
      <MapView
        mode="chain"
        slots={[null, [{ key: "a", value: 1 }, { key: "b", value: 2 }], null]}
      />,
    );
    expect(html).toContain("a: 1");
    expect(html).toContain("b: 2");
  });

  it("renders a tombstone as DEL", () => {
    const html = renderToStaticMarkup(<MapView mode="open" slots={[null, "DEL"]} />);
    expect(html).toContain("DEL");
  });

  it("numbers the probe path", () => {
    const html = renderToStaticMarkup(
      <MapView mode="open" slots={[null, null, null, { key: "x" }]} probePath={[3, 0]} />,
    );
    expect(html).toContain("1↓");
    expect(html).toContain("2↓");
  });

  it("reports the load factor", () => {
    const html = renderToStaticMarkup(
      <MapView mode="open" capacity={4} slots={[{ key: "a" }, null, { key: "b" }, null]} />,
    );
    expect(html).toContain("α = 2/4 = 0.50");
  });

  it("renders the dictionary form as chips, with no slots", () => {
    const html = renderToStaticMarkup(
      <MapView entries={[{ key: "a", value: 2 }]} hashOf={{ a: 3 }} />,
    );
    expect(html).toContain("a: 2");
    expect(html).toContain("h=3");
    expect(html).not.toContain("α =");
  });
});

describe("TimelineView lanes, states and links", () => {
  const intervals = [
    { id: "x", lane: "T1", start: 0, end: 4, state: "holding" },
    { id: "y", lane: "T2", start: 2, end: 5, state: "blocked" },
    { id: "z", lane: "T2", start: 5, end: 8 },
  ];

  it("labels named lanes in declared order", () => {
    const html = renderToStaticMarkup(<TimelineView intervals={intervals} lanes={["T1", "T2"]} />);
    expect(html).toContain("T1");
    expect(html).toContain("T2");
  });

  it("hatches a blocked span, because it is doing no work", () => {
    const html = renderToStaticMarkup(<TimelineView intervals={intervals} lanes={["T1", "T2"]} />);
    expect(html).toContain("<pattern");
    expect(html).toContain("url(#kw-tl-hatch");
  });

  it("draws a diamond for a point event rather than a hairline bar", () => {
    const html = renderToStaticMarkup(
      <TimelineView intervals={[{ start: 3, end: 3, label: "wake" }, { start: 0, end: 6 }]} />,
    );
    expect(html).toContain("<path");
    expect(html).toContain("wake");
  });

  it("draws causal links with an arrowhead", () => {
    const html = renderToStaticMarkup(
      <TimelineView
        intervals={intervals}
        lanes={["T1", "T2"]}
        links={[{ from: "x", to: "z", label: "lock released" }]}
      />,
    );
    expect(html).toContain("lock released");
    expect(html).toContain("url(#kw-tl-link");
  });

  it("names each state in a legend", () => {
    const html = renderToStaticMarkup(<TimelineView intervals={intervals} lanes={["T1", "T2"]} />);
    expect(html).toContain("holding");
    expect(html).toContain("blocked");
  });

  it("resolves an unknown lane name to its own row instead of lane zero", () => {
    expect(assignTimelineLanes([{ start: 0, end: 1, lane: "ghost" }], ["T1", "T2"])).toEqual([2]);
  });
});

describe("heapTreeFromArray", () => {
  it("uses array indices as node ids, so an array fence lines up", () => {
    const tree = heapTreeFromArray([1, 3, 2, 7, 5]);
    expect(tree?.id).toBe(0);
    expect(tree?.children?.map((c) => c.id)).toEqual([1, 2]);
    expect(tree?.children?.[0]?.children?.map((c) => c.id)).toEqual([3, 4]);
  });

  it("supports a k-ary heap", () => {
    const tree = heapTreeFromArray([0, 1, 2, 3, 4], { arity: 4 });
    expect(tree?.children?.map((c) => c.id)).toEqual([1, 2, 3, 4]);
  });

  it("stops at a hole in the array", () => {
    const tree = heapTreeFromArray([1, null, 2]);
    expect(tree?.children?.map((c) => c.id)).toEqual([2]);
  });

  it("returns nothing for an empty heap", () => {
    expect(heapTreeFromArray([])).toBeNull();
  });

  it("renders the tree and the backing array together", () => {
    const html = renderToStaticMarkup(<TreeView fromArray={[1, 3, 2]} />);
    expect(html).toContain("<svg");
  });
});

describe("keyed tree pages", () => {
  const opts = { hGap: 20, vGap: 60, nodeSize: 36, keyCell: 30 };

  it("widens a node to fit its keys", () => {
    expect(nodeWidth({ value: "x" }, opts)).toBe(36);
    expect(nodeWidth({ keys: [1, 2, 3] }, opts)).toBe(90);
  });

  it("hangs child i off gap i", () => {
    const [root] = layoutForest(
      [{ keys: [20, 60], children: [{ keys: [5] }, { keys: [25] }, { keys: [75] }] }],
      opts,
    );
    expect(root!.width).toBe(60);
    expect(root!.children).toHaveLength(3);
  });

  it("leaves plain binary spacing untouched", () => {
    const [root] = layoutForest([{ value: 1, left: { value: 2 }, right: { value: 3 } }], opts);
    const [left, right] = root!.children;
    expect(right!.x - left!.x).toBe(2 * (opts.hGap + opts.nodeSize));
  });

  it("renders key cells with a divider between them", () => {
    const html = renderToStaticMarkup(
      <TreeView root={{ keys: [20, 60], leaf: true }} activeKeys={{ "": [0] }} />,
    );
    expect(html).toContain("<rect");
    expect(html).toContain("20");
    expect(html).toContain("60");
  });
});

describe("lane packing", () => {
  it("counts the rows it used", () => {
    expect(laneCount(assignLanes([{ start: 0, end: 9 }, { start: 1, end: 2 }]))).toBe(2);
  });
});

describe("accessible summaries", () => {
  it("reads as prose, not as a prop dump", () => {
    expect(summarizeArray({ values: [1, 2, 3], label: "nums", activeIndices: [1] })).toBe(
      "nums: array of 3 values; 1, 2, 3; active at index 1.",
    );
  });

  it("counts a tree's nodes, leaves and height", () => {
    expect(summarizeTree({ root: { value: 1, left: { value: 2 }, right: { value: 3 } } })).toBe(
      "tree; 3 nodes, 2 leaves, height 2.",
    );
  });

  it("names a stack's top", () => {
    expect(summarizeStack({ values: [1, 2, 3] })).toContain("top is 3");
  });

  it("describes an empty structure without crashing", () => {
    expect(summarizeTree({})).toBe("Empty tree.");
    expect(summarizeTable({ columns: [], rows: [] })).toContain("0 rows");
    expect(summarizeMap({ slots: [] })).toContain("0 slots");
  });

  it("switches to a count once a list gets long", () => {
    const summary = summarizeArray({ values: Array.from({ length: 40 }, (_, i) => i) });
    expect(summary).toContain("and 28 more");
  });
});
