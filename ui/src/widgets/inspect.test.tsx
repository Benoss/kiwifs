import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  holdsTabStop,
  InspectContext,
  linkedKeysFor,
  moveFocus,
  nextSelection,
  parseLinks,
  partHandlers,
  refEquals,
  toKeySet,
  useInspectState,
  whyFor,
} from "./inspect";
import type { InspectRef, InspectState } from "./inspect";
import { ArrayView } from "./ArrayView";
import { MatrixView } from "./MatrixView";
import { TreeView } from "./TreeView";
import { LinkedListView } from "./LinkedListView";
import { StackView } from "./StackView";
import { GraphView } from "./GraphView";

/** A bus with whatever is selected or hovered, for server-rendered checks. */
function bus(over: Partial<InspectState> = {}): InspectState {
  return {
    selected: null,
    hovered: null,
    select: () => {},
    hover: () => {},
    why: {},
    linkedKeys: () => new Set(),
    links: [],
    ...over,
  };
}

function withBus(state: InspectState, node: React.ReactElement) {
  return renderToStaticMarkup(
    <InspectContext.Provider value={state}>{node}</InspectContext.Provider>,
  );
}

describe("refs", () => {
  it("compare on all three parts", () => {
    const a = { widget: "w", kind: "cell" as const, key: "1" };
    expect(refEquals(a, { ...a })).toBe(true);
    expect(refEquals(a, { ...a, key: "2" })).toBe(false);
    expect(refEquals(a, { ...a, widget: "x" })).toBe(false);
    expect(refEquals(null, null)).toBe(true);
    expect(refEquals(a, null)).toBe(false);
  });
});

describe("whyFor", () => {
  it("prefers a kind-qualified key over a bare one", () => {
    const why = { "3": "bare", "cell:3": "qualified" };
    expect(whyFor(why, { widget: "w", kind: "cell", key: "3" })).toBe("qualified");
    expect(whyFor(why, { widget: "w", kind: "node", key: "3" })).toBe("bare");
    expect(whyFor(why, null)).toBeUndefined();
  });
});

describe("parseLinks", () => {
  it("takes a bare name as an identity mapping", () => {
    expect(parseLinks("heap-tree")).toEqual([{ to: "heap-tree", map: "index" }]);
  });

  it("takes an explicit mapping", () => {
    expect(parseLinks({ to: "t", map: { a: "1" } })).toEqual([{ to: "t", map: { a: "1" } }]);
  });

  it("takes a list, and ignores a link with no target", () => {
    expect(parseLinks([{ to: "a" }, { map: "index" }])).toEqual([{ to: "a", map: "index" }]);
    expect(parseLinks(undefined)).toEqual([]);
  });
});

describe("toKeySet", () => {
  it("accepts one key or many", () => {
    expect([...toKeySet("a")]).toEqual(["a"]);
    expect([...toKeySet(["a", "b"])]).toEqual(["a", "b"]);
    expect(toKeySet(null).size).toBe(0);
  });
});

describe("canvases become selectable only when there is something to say", () => {
  it("leaves a plain array as a picture", () => {
    const html = withBus(bus(), <ArrayView values={[1, 2, 3]} />);
    expect(html).toContain('role="img"');
    expect(html).not.toContain("graphics-symbol");
  });

  it("marks the cells with a why as graphics symbols", () => {
    const html = withBus(bus(), <ArrayView values={[1, 2, 3]} why={{ "1": "carried over" }} />);
    expect(html).toContain('role="graphics-document"');
    expect(html).toContain('role="graphics-symbol"');
    // Exactly one tab stop, per the APG roving-tabindex pattern.
    expect([...html.matchAll(/tabindex="0"/g)]).toHaveLength(1);
    expect([...html.matchAll(/role="graphics-symbol"/g)]).toHaveLength(1);
  });

  it("makes every cell selectable once onSelect is given, with one tab stop", () => {
    const html = withBus(bus(), <MatrixView values={[[1, 2], [3, 4]]} onSelect={() => {}} />);
    expect([...html.matchAll(/role="graphics-symbol"/g)]).toHaveLength(4);
    expect([...html.matchAll(/tabindex="0"/g)]).toHaveLength(1);
    expect([...html.matchAll(/tabindex="-1"/g)]).toHaveLength(3);
  });

  it("marks the selected part with aria-selected", () => {
    const html = withBus(
      bus({ selected: { widget: "array", kind: "cell", key: "1" } }),
      <ArrayView values={[1, 2]} onSelect={() => {}} />,
    );
    expect(html).toContain('aria-selected="true"');
  });
});

describe("cross-widget correspondence", () => {
  const linkedTo = (widget: string, key: string) =>
    bus({ linkedKeys: (w) => (w === widget ? new Set([key]) : new Set()) });

  it("outlines the array cell a linked tree node points at", () => {
    const html = withBus(linkedTo("array", "2"), <ArrayView values={[9, 8, 7, 6]} />);
    expect(html).toContain("outline:2px solid");
  });

  it("lights the tree node a linked array cell points at", () => {
    const html = withBus(
      linkedTo("tree", "0"),
      <TreeView fromArray={[1, 2, 3]} highlightColor="#abcdef" />,
    );
    expect(html).toContain("#abcdef");
  });

  it("ignores a link aimed at another widget", () => {
    const html = withBus(linkedTo("other", "2"), <ArrayView values={[9, 8, 7]} />);
    expect(html).not.toContain("outline:2px solid");
  });
});

describe("hoverPredecessors uses the data the author already passed", () => {
  const hovering = (widget: string, key: string, kind: "cell" | "node" = "cell") =>
    bus({ hovered: { widget, kind, key } });

  it("lights the array cell an arrow comes from", () => {
    const html = withBus(
      hovering("array", "3"),
      <ArrayView values={[1, 2, 3, 4]} arrows={[{ from: 1, to: 3 }]} hoverPredecessors />,
    );
    expect(html).toContain("outline:2px solid");
  });

  it("lights the matrix cell a dependency arrow comes from", () => {
    const html = withBus(
      hovering("matrix", "1,1"),
      <MatrixView
        values={[[1, 2], [3, 4]]}
        arrows={[{ from: [0, 0], to: [1, 1] }]}
        hoverPredecessors
        highlightColor="#abcdef"
      />,
    );
    expect(html).toContain("#abcdef");
  });

  it("lights a tree node's parent", () => {
    const html = withBus(
      hovering("tree", "1", "node"),
      <TreeView fromArray={[5, 3, 8]} hoverPredecessors highlightColor="#abcdef" />,
    );
    expect(html).toContain("#abcdef");
  });

  it("lights the list node whose next lands on the hovered one", () => {
    const html = withBus(
      hovering("list", "2", "node"),
      <LinkedListView
        nodes={[{ value: 1 }, { value: 2 }, { value: 3 }]}
        hoverPredecessors
        highlightColor="#abcdef"
      />,
    );
    expect(html).toContain("#abcdef");
  });

  it("lights the graph nodes with an edge into the hovered one", () => {
    const html = withBus(
      hovering("graph", "C", "node"),
      <GraphView
        nodes={[{ id: "A" }, { id: "B" }, { id: "C" }]}
        edges={[{ from: "A", to: "C" }]}
        hoverPredecessors
        highlightColor="#abcdef"
      />,
    );
    expect(html).toContain("#abcdef");
  });

  it("does nothing when the author did not ask for it", () => {
    const html = withBus(
      hovering("array", "3"),
      <ArrayView values={[1, 2, 3, 4]} arrows={[{ from: 1, to: 3 }]} />,
    );
    expect(html).not.toContain("outline:2px solid");
  });
});

describe("StackView selection", () => {
  it("makes an item with a why focusable", () => {
    const html = withBus(bus(), <StackView values={[1, 2, 3]} why={{ "2": "the top" }} />);
    expect(html).toContain('role="graphics-symbol"');
  });
});

/** Just enough of an element for roving focus: attributes, scope, focus. */
class FakeEl {
  tabIndex: number;
  focused = false;
  attrs: Record<string, string>;
  scope: FakeScope | null = null;
  constructor(attrs: Record<string, string>, tabIndex: number) {
    this.attrs = attrs;
    this.tabIndex = tabIndex;
  }
  getAttribute(name: string) {
    return this.attrs[name] ?? null;
  }
  closest(sel: string) {
    return sel === "[data-kw-canvas]" ? this.scope : null;
  }
  focus() {
    this.focused = true;
  }
}

class FakeScope {
  parts: FakeEl[];
  constructor(parts: FakeEl[]) {
    this.parts = parts;
    for (const p of parts) p.scope = this;
  }
  querySelectorAll(sel: string) {
    if (sel === "[data-kw-part]") return this.parts.filter((p) => p.attrs["data-kw-part"] !== undefined);
    return this.parts;
  }
}

describe("moveFocus", () => {
  it("declines keys it does not own, so the event keeps bubbling", () => {
    expect(moveFocus(null, "ArrowRight")).toBe(false);
  });

  it("reaches parts outside the tab order, and hands the tab stop over", () => {
    const parts = [0, -1, -1].map((t) => new FakeEl({ "data-kw-part": "array" }, t));
    new FakeScope(parts);
    expect(moveFocus(parts[0] as unknown as Element, "ArrowRight")).toBe(true);
    expect(parts[1]!.focused).toBe(true);
    expect(parts.map((p) => p.tabIndex)).toEqual([-1, 0, -1]);

    expect(moveFocus(parts[1] as unknown as Element, "End")).toBe(true);
    expect(parts[2]!.focused).toBe(true);
    expect(parts.map((p) => p.tabIndex)).toEqual([-1, -1, 0]);
  });

  it("stays inside its own panel", () => {
    const array = [new FakeEl({ "data-kw-part": "array" }, 0), new FakeEl({ "data-kw-part": "array" }, -1)];
    const tree = [new FakeEl({ "data-kw-part": "tree" }, 0)];
    new FakeScope([...array, ...tree]);
    expect(moveFocus(array[1] as unknown as Element, "ArrowRight")).toBe(true);
    expect(tree[0]!.focused).toBe(false);
  });
});

describe("the roving tab stop", () => {
  const ref = (key: string, widget = "array"): InspectRef => ({ widget, kind: "cell", key });

  it("starts where the canvas says and then follows focus", () => {
    expect(holdsTabStop(ref("0"), null, true)).toBe(true);
    expect(holdsTabStop(ref("2"), ref("2"), false)).toBe(true);
    expect(holdsTabStop(ref("0"), ref("2"), true)).toBe(false);
  });

  it("is not moved by focus in another panel", () => {
    expect(holdsTabStop(ref("0"), ref("5", "tree"), true)).toBe(true);
  });

  it("is rendered by partHandlers from the bus's focused part", () => {
    const focusedBus = bus({ focused: ref("1"), why: { "0": "a", "1": "b" } });
    expect(partHandlers("array", "cell", "0", focusedBus, { tabbable: true }).tabIndex).toBe(-1);
    expect(partHandlers("array", "cell", "1", focusedBus, { tabbable: false }).tabIndex).toBe(0);
  });

  it("marks only describable parts as roving targets", () => {
    const b = bus({ why: { "1": "b" } });
    expect(partHandlers("array", "cell", "1", b)["data-kw-part"]).toBe("array");
    expect(partHandlers("array", "cell", "2", b)["data-kw-part"]).toBeUndefined();
  });
});

describe("selection", () => {
  const a = { widget: "w", kind: "cell" as const, key: "1" };

  it("toggles off when the same part is selected again", () => {
    expect(nextSelection(null, a)).toEqual(a);
    expect(nextSelection(a, { ...a })).toBe(null);
    expect(nextSelection(a, null)).toBe(null);
  });

  it("tells onSelect about the toggle-off with null", () => {
    const calls: (InspectRef | null)[] = [];
    let state: InspectState | null = null;
    function Probe() {
      state = useInspectState({ onSelect: (r) => calls.push(r) });
      return null;
    }
    renderToStaticMarkup(<Probe />);
    state!.select(a);
    state!.select(a);
    expect(calls).toEqual([a, null]);
  });

  it("hands out the same empty why and links on every render", () => {
    const seen: InspectState[] = [];
    function Probe() {
      seen.push(useInspectState());
      return null;
    }
    renderToStaticMarkup(<Probe />);
    renderToStaticMarkup(<Probe />);
    expect(seen[0]!.why).toBe(seen[1]!.why);
    expect(seen[0]!.links).toBe(seen[1]!.links);
  });
});

describe("directional links", () => {
  const hover = (widget: string, key: string): InspectRef => ({ widget, kind: "cell", key });

  it("fires only from the widget the link was written on, and back", () => {
    const links = parseLinks({ to: "tree", map: { "0": "root" } }, "array");
    expect(links).toEqual([{ from: "array", to: "tree", map: { "0": "root" } }]);
    expect([...linkedKeysFor(hover("array", "0"), "tree", links)]).toEqual(["root"]);
    expect([...linkedKeysFor(hover("tree", "root"), "array", links)]).toEqual(["0"]);
    expect(linkedKeysFor(hover("matrix", "0"), "tree", links).size).toBe(0);
  });

  it("keeps an unsourced link working from any widget", () => {
    const links = parseLinks("tree");
    expect([...linkedKeysFor(hover("matrix", "3"), "tree", links)]).toEqual(["3"]);
  });

  it("lets a link name its own source", () => {
    expect(parseLinks({ from: "list", to: "tree" }, "array")).toEqual([{ from: "list", to: "tree", map: "index" }]);
  });
});
