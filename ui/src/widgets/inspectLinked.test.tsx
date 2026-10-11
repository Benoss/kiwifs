import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { GraphView } from "./GraphView";
import { TreeView } from "./TreeView";
import { InspectContext, type InspectRef, type InspectState } from "./inspect";
import { inspectLinked } from "./inspectLinked";

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

/** What the real bus reports while the reader hovers `key` on `widget`. */
function hovering(widget: string, key: string, over: Partial<InspectState> = {}): InspectState {
  const ref: InspectRef = { widget, kind: "node", key };
  return bus({ hovered: ref, linkedKeys: (w) => (w === widget ? new Set([key]) : new Set()), ...over });
}

const withBus = (state: InspectState, node: React.ReactElement) =>
  renderToStaticMarkup(<InspectContext.Provider value={state}>{node}</InspectContext.Provider>);

const RING = "#abcdef";

describe("inspectLinked", () => {
  it("ignores a canvas's own hover when no inspect feature is in use", () => {
    expect(inspectLinked(hovering("g", "A"), "g", false).size).toBe(0);
  });

  it("keeps it once the author opted in, or the page has why / links", () => {
    expect(inspectLinked(hovering("g", "A"), "g", true).has("A")).toBe(true);
    expect(inspectLinked(hovering("g", "A", { why: { A: "x" } }), "g", false).has("A")).toBe(true);
    expect(inspectLinked(hovering("g", "A", { links: [{ to: "t" }] }), "g", false).has("A")).toBe(true);
  });

  it("always keeps keys that arrived from another widget", () => {
    const state = bus({
      hovered: { widget: "array", kind: "cell", key: "2" },
      linkedKeys: (w) => (w === "g" ? new Set(["2"]) : new Set()),
    });
    expect(inspectLinked(state, "g", false).has("2")).toBe(true);
  });
});

describe("GraphView keeps its look for onNodeClick-only graphs", () => {
  const nodes = [{ id: "A" }, { id: "B" }];

  it("does not restyle a hovered node", () => {
    const plain = renderToStaticMarkup(
      <GraphView nodes={nodes} edges={[]} onNodeClick={() => {}} highlightColor={RING} layout="circular" />,
    );
    const hovered = withBus(
      hovering("graph", "A"),
      <GraphView nodes={nodes} edges={[]} onNodeClick={vi.fn()} highlightColor={RING} layout="circular" />,
    );
    expect(hovered).not.toContain(RING);
    expect(hovered.replace(/ tabindex="-?\d"/g, "")).toBe(plain.replace(/ tabindex="-?\d"/g, ""));
  });

  it("adds a ring around an active node instead of repainting it", () => {
    const html = withBus(
      hovering("graph", "A"),
      <GraphView nodes={nodes} edges={[]} activeNodes={["A"]} activeColor="#111111" hoverPredecessors highlightColor={RING} layout="circular" />,
    );
    expect(html).toContain('fill="#111111" stroke="#111111"');
    expect(html).toContain(`fill="none" stroke="${RING}"`);
  });

  it("leaves a dim node dim when it is linked", () => {
    const html = withBus(
      hovering("graph", "C"),
      <GraphView
        nodes={[{ id: "A" }, { id: "C" }]}
        edges={[{ from: "A", to: "C" }]}
        dimNodes={["A"]}
        hoverPredecessors
        highlightColor={RING}
        layout="circular"
      />,
    );
    expect(html).toContain(`fill="none" stroke="${RING}"`);
    expect(html).toContain("opacity:0.5");
  });
});

describe("TreeView keeps its look without inspect features", () => {
  it("does not restyle a hovered node", () => {
    const html = withBus(hovering("tree", "0"), <TreeView fromArray={[1, 2, 3]} highlightColor={RING} />);
    expect(html).not.toContain(`stroke="${RING}"`);
  });

  it("rings an active node it links to, keeping the active fill", () => {
    const html = withBus(
      hovering("tree", "0", { why: { "0": "root" } }),
      <TreeView fromArray={[1, 2, 3]} activeNodes={[1]} activeColor="#111111" highlightColor={RING} />,
    );
    expect(html).toContain('fill="#111111" stroke="#111111"');
    expect(html).toContain(`fill="none" stroke="${RING}"`);
  });
});
