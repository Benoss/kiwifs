import { lazy } from "react";
import type { FencePanel, FenceSpec } from "../registry";
import { summarizeTree } from "@kw/widgets/widgetA11y";
import { CANVAS_ATTRS, bool, enumOf, many, number, objectList } from "./common";

const TreeView = lazy(() =>
  import("@kw/widgets/TreeView").then((m) => ({ default: m.TreeView })),
);
const ArrayView = lazy(() =>
  import("@kw/widgets/ArrayView").then((m) => ({ default: m.ArrayView })),
);

export const treeSpec: FenceSpec = {
  lang: "tree",
  description:
    "Binary, n-ary and keyed trees: BSTs, tries, recursion trees, heaps (`fromArray`), union-find forests (`parents`), B-tree pages (`keys`).",
  component: TreeView,
  // A bare ```tree holding a directory listing has none of these and falls
  // through to a plain code block, which is the whole point of sniffing.
  required: ["root", "roots", "parents", "fromArray"],
  requireOneOf: ["root", "roots", "parents", "fromArray"],
  schema: {
    attributes: {
      root: {
        type: "object",
        description:
          "Nested node: `{value, id?, badge?, edgeLabel?, keys?, leaf?, left?, right?, children?}`.",
      },
      roots: objectList("Several trees side by side — a disjoint-set forest, a trie split per letter."),
      parents: {
        type: ["array", "object"],
        description:
          "Parent pointers instead of nesting: `parents[i]` is the parent of `i`. Self, `null` or `-1` marks a root. Node keys are the indices or object keys.",
      },
      fromArray: {
        type: "array",
        description:
          "Build a complete heap from an array: ids are indices, children of `i` are `2i+1`/`2i+2`. Pair with an `array` fence and `link:` for the two-representation view.",
      },
      arity: number("`fromArray` children per node. 2 (default) for a binary heap.", false),
      withArray: bool(
        "With `fromArray`: also draw the backing array beside the tree, highlights kept in step. Default true.",
        false,
      ),
      badges: { type: "object", description: "Badge per node key — subtree size, the range a segment-tree node covers." },
      nodeColors: { type: "object", description: "Base color per node key, e.g. one per connected component." },
      activeNodes: many("Node keys active this step."),
      highlightNodes: many("Secondary-highlighted node keys."),
      dimNodes: many("Dimmed (already processed) node keys."),
      prunedNodes: many("Node keys the search abandoned — drawn dashed and struck through."),
      highlightEdges: many('Child keys, or `"parent->child"`, whose edge lights up.'),
      activeKeys: {
        type: "object",
        description: "Which key cells light inside a keyed page: `{nodeId: [keyIndex, …]}`.",
      },
      ghostEdges: objectList("Edges that no longer exist, drawn dashed: `{from, to, label?}` — the old link after a rotation."),
      edgeDirection: enumOf(["none", "down", "up"], 'Arrowheads on edges. "up" for parent pointers and union-find.', false),
      nextLinks: objectList("Same-level arrows: `{from, to}` — next-right pointers, the B+-tree leaf chain."),
      pointers: objectList("Labels next to nodes: `{value?|id?, label, color?}`."),
      showEdgeLabels: bool("Show each node's `edgeLabel`. Default true.", false),
      showNulls: bool("Dashed empty slot on the missing side of a one-child binary node. Default true.", false),
      animate: bool("Glide nodes to new positions when the tree changes. Default true.", false),
      hGap: number("Horizontal gap between sibling subtrees, px.", false),
      vGap: number("Vertical gap between levels, px.", false),
      nodeSize: number("Node diameter, px.", false),
      keyCell: number("Width of one key cell in a keyed page, px. Default 30.", false),
      ...CANVAS_ATTRS,
    },
  },
  /**
   * `fromArray` draws two views of one structure: the tree and the array it
   * lives in. Node ids are already array indices, so the highlight sets
   * transfer unchanged — no mapping table, no HeapView.
   */
  panels(body): FencePanel[] {
    const values = body.fromArray as unknown[] | undefined;
    if (!Array.isArray(values) || body.withArray === false) {
      return [{ key: "tree", component: TreeView, props: body }];
    }
    const active = body.activeNodes ?? body.activeIndices;
    const highlight = body.highlightNodes ?? body.highlightIndices;
    const dim = body.dimNodes ?? body.dimIndices;
    return [
      { key: "tree", label: "Tree", component: TreeView, props: body },
      {
        key: "array",
        label: "Backing array",
        component: ArrayView,
        props: {
          values,
          activeIndices: active,
          highlightIndices: highlight,
          dimIndices: dim,
          showIndices: true,
        },
      },
    ];
  },
  summarize: (props) => summarizeTree(props as Parameters<typeof summarizeTree>[0]),
  example: `\`\`\`tree id=heap caption="Sift-down after popping the root"
fromArray: [1, 3, 2, 7, 5, 9]
steps:
  - note: "Pop the root; move the last element up"
    activeNodes: [0]
  - note: "9 is bigger than both children — swap with the smaller, 2"
    activeNodes: [0, 2]
    highlightNodes: [1]
  - note: "Heap property restored"
    dimNodes: [0, 1, 2]
\`\`\``,
};

/** A B+-tree page as a keyed node. Documented separately because the shape is
 *  the least obvious thing the `tree` fence can draw. */
export const TREE_KEYS_EXAMPLE = `\`\`\`tree caption="B+-tree search for 42"
root:
  keys: [20, 60]
  children:
    - {keys: [5, 12], leaf: true}
    - {keys: [25, 42], leaf: true}
    - {keys: [75, 90], leaf: true}
nextLinks:
  - {from: 1, to: 2}
  - {from: 2, to: 3}
steps:
  - note: "42 ≥ 20 and < 60 — follow the middle pointer"
    activeKeys: {0: [0]}
  - note: "Found 42 in the leaf"
    activeKeys: {2: [1]}
\`\`\``;
