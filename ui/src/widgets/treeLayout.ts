/** Structural tree accepted by the layout. Matches `TreeNode` in TreeView. */
export interface LayoutInput {
  value?: string | number;
  id?: string | number;
  /**
   * Several keys in one node — a B-tree or B+-tree page, a segment-tree
   * summary row. Wins over `value` when present, and widens the node, which
   * is why the layout tracks a width per node rather than one `nodeSize`.
   */
  keys?: (string | number)[];
  /** Marks a B+-tree leaf, so the renderer can draw the sibling chain. */
  leaf?: boolean;
  badge?: string | number;
  edgeLabel?: string | number;
  left?: LayoutInput | null;
  right?: LayoutInput | null;
  children?: LayoutInput[];
}

export interface LayoutNode {
  value: string | number;
  key: string | number;
  keys?: (string | number)[];
  leaf?: boolean;
  badge?: string | number;
  edgeLabel?: string | number;
  x: number;
  y: number;
  /** Outer width in px. `nodeSize` for a plain node, wider for a keyed page. */
  width: number;
  children: LayoutNode[];
  /** Dashed empty slot for a missing binary child when the other side exists. */
  ghost?: boolean;
}

export interface LayoutEdge {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  label?: string | number;
  childKey: string | number;
  parentKey: string | number;
  ghost?: boolean;
}

export interface TreeLayoutOptions {
  hGap: number;
  vGap: number;
  nodeSize: number;
  /** Width of one key cell in a keyed page. Default 30. */
  keyCell?: number;
  /** Place a ghost on the empty side of a one-child binary node. Default true. */
  showNulls?: boolean;
}

export const DEFAULT_KEY_CELL = 30;

/**
 * A keyed page without an id is named by its keys (`"10,20"`), so pages are
 * addressable and don't all share `""`. TreeView suffixes any remaining
 * duplicates (`#1`) for drawing.
 */
function nodeKey(node: LayoutInput): string | number {
  return node.id ?? node.value ?? (node.keys?.length ? node.keys.join(",") : "");
}

/** A keyed page is as wide as its keys; everything else is `nodeSize`. */
export function nodeWidth(node: LayoutInput, opts: TreeLayoutOptions): number {
  const keys = node.keys;
  if (!keys?.length) return opts.nodeSize;
  return Math.max(opts.nodeSize, keys.length * (opts.keyCell ?? DEFAULT_KEY_CELL));
}

/**
 * Where child `index` hangs off a keyed page: a page with k keys has k+1
 * pointers, one in each gap between keys plus one at each end.
 */
export function childAnchorX(node: Pick<LayoutNode, "x" | "width" | "keys">, index: number): number {
  const k = node.keys?.length ?? 0;
  if (k === 0) return node.x;
  const cell = node.width / k;
  return node.x - node.width / 2 + Math.max(0, Math.min(index, k)) * cell;
}

function getTreeBounds(node: LayoutNode): { minX: number; maxX: number } {
  let minX = node.x - node.width / 2;
  let maxX = node.x + node.width / 2;
  for (const child of node.children) {
    const cb = getTreeBounds(child);
    if (cb.minX < minX) minX = cb.minX;
    if (cb.maxX > maxX) maxX = cb.maxX;
  }
  return { minX, maxX };
}

function shiftTree(node: LayoutNode, dx: number): void {
  node.x += dx;
  for (const child of node.children) shiftTree(child, dx);
}

function makeGhost(
  parentKey: string | number,
  side: "left" | "right",
  depth: number,
  opts: TreeLayoutOptions,
): LayoutNode {
  return {
    value: "",
    key: `${String(parentKey)}__null_${side}`,
    y: depth * opts.vGap,
    x: 0,
    width: opts.nodeSize,
    children: [],
    ghost: true,
  };
}

/**
 * Binary layout keeps left and right in their own slots. A missing child does
 * not collapse the tree into a vertical stick — the surviving child stays on
 * its side of the parent. When `showNulls` is on (default), a one-child node
 * also gets a ghost on the empty side so the hole is visible.
 */
export function layoutTree(
  node: LayoutInput | null | undefined,
  depth: number,
  opts: TreeLayoutOptions,
): LayoutNode | null {
  if (!node) return null;

  const { hGap, vGap, showNulls = true } = opts;
  const key = nodeKey(node);
  const width = nodeWidth(node, opts);
  const base = {
    value: node.value ?? "",
    key,
    keys: node.keys,
    leaf: node.leaf,
    badge: node.badge,
    edgeLabel: node.edgeLabel,
    width,
    y: depth * vGap,
  };

  const isBinary = node.children === undefined;

  if (!isBinary) {
    const kids = node.children ?? [];
    const childLayouts = kids
      .map((c) => layoutTree(c, depth + 1, opts))
      .filter((c): c is LayoutNode => c !== null);
    if (childLayouts.length === 0) {
      return { ...base, x: 0, children: [] };
    }
    let offset = 0;
    for (const child of childLayouts) {
      const bounds = getTreeBounds(child);
      shiftTree(child, offset - bounds.minX);
      offset = getTreeBounds(child).maxX + hGap;
    }
    const firstX = childLayouts[0]!.x;
    const lastX = childLayouts[childLayouts.length - 1]!.x;
    return { ...base, x: (firstX + lastX) / 2, children: childLayouts };
  }

  const hasLeft = node.left != null;
  const hasRight = node.right != null;
  const leftLayout = hasLeft
    ? layoutTree(node.left, depth + 1, opts)
    : showNulls && hasRight
      ? makeGhost(key, "left", depth + 1, opts)
      : null;
  const rightLayout = hasRight
    ? layoutTree(node.right, depth + 1, opts)
    : showNulls && hasLeft
      ? makeGhost(key, "right", depth + 1, opts)
      : null;

  if (!leftLayout && !rightLayout) {
    return { ...base, x: 0, children: [] };
  }

  // Centre-to-centre, so uniform nodes keep the spacing they always had and a
  // wide keyed page pushes its siblings out by exactly its extra width.
  const sepFor = (child: LayoutNode) => hGap + (width + child.width) / 2;
  if (leftLayout) shiftTree(leftLayout, -sepFor(leftLayout) - leftLayout.x);
  if (rightLayout) shiftTree(rightLayout, sepFor(rightLayout) - rightLayout.x);

  if (leftLayout && rightLayout) {
    const gap = getTreeBounds(rightLayout).minX - getTreeBounds(leftLayout).maxX;
    const need = hGap;
    if (gap < need) {
      const extra = need - gap;
      shiftTree(leftLayout, -extra / 2);
      shiftTree(rightLayout, extra / 2);
    }
  }

  const children = [leftLayout, rightLayout].filter((c): c is LayoutNode => c !== null);
  return { ...base, x: 0, children };
}

type ParentLinks =
  | readonly (string | number | null | undefined)[]
  | Readonly<Record<string, string | number | null | undefined>>;

/**
 * Build a forest from parent pointers: `parents[i]` is the parent of node `i`
 * (array) or `parents[key]` the parent of `key` (object). A node is a root when
 * its parent is itself, missing, `null`, `-1`, or unknown. Roots and children
 * keep key order, so the picture stays stable as links change. A cycle that
 * never reaches a root is broken at its first key, which becomes a root.
 */
export function forestFromParents(parents: ParentLinks): LayoutInput[] {
  const isArray = Array.isArray(parents);
  const keys: (string | number)[] = isArray
    ? (parents as readonly unknown[]).map((_, i) => i)
    : Object.keys(parents);
  const byId = new Map<string, string | number>(keys.map((k) => [String(k), k]));
  const parentOf = (k: string | number): string | number | null => {
    const p = isArray
      ? (parents as readonly (string | number | null | undefined)[])[k as number]
      : (parents as Record<string, string | number | null | undefined>)[String(k)];
    if (p == null || p === -1 || String(p) === String(k)) return null;
    return byId.get(String(p)) ?? null;
  };

  const children = new Map<string, (string | number)[]>();
  for (const k of keys) {
    const p = parentOf(k);
    if (p === null) continue;
    const list = children.get(String(p)) ?? [];
    list.push(k);
    children.set(String(p), list);
  }

  const visited = new Set<string>();
  const build = (k: string | number): LayoutInput => {
    visited.add(String(k));
    const kids = (children.get(String(k)) ?? []).filter((c) => !visited.has(String(c)));
    return { value: k, id: k, children: kids.map(build) };
  };

  const roots: LayoutInput[] = [];
  for (const k of keys) if (parentOf(k) === null) roots.push(build(k));
  for (const k of keys) if (!visited.has(String(k))) roots.push(build(k));
  return roots;
}

/** Lay each tree out independently, then push it clear of the previous one. */
export function layoutForest(
  roots: (LayoutInput | null | undefined)[],
  opts: TreeLayoutOptions,
): LayoutNode[] {
  const layouts: LayoutNode[] = [];
  let offset = 0;
  for (const root of roots) {
    const layout = layoutTree(root, 0, opts);
    if (!layout) continue;
    shiftTree(layout, offset - getTreeBounds(layout).minX);
    offset = getTreeBounds(layout).maxX + opts.hGap * 2;
    layouts.push(layout);
  }
  return layouts;
}

export function flattenTree(node: LayoutNode): LayoutNode[] {
  const result: LayoutNode[] = [node];
  for (const child of node.children) result.push(...flattenTree(child));
  return result;
}

export function collectEdges(node: LayoutNode): LayoutEdge[] {
  const edges: LayoutEdge[] = [];
  for (const child of node.children) {
    edges.push({
      x1: node.x,
      y1: node.y,
      x2: child.x,
      y2: child.y,
      label: child.edgeLabel,
      childKey: child.key,
      parentKey: node.key,
      ghost: child.ghost,
    });
    edges.push(...collectEdges(child));
  }
  return edges;
}

export function positionsByKey(node: LayoutNode): Map<string | number, { x: number; y: number }> {
  const map = new Map<string | number, { x: number; y: number }>();
  for (const n of flattenTree(node)) {
    map.set(n.key, { x: n.x, y: n.y });
  }
  return map;
}

export interface HeapTreeOptions {
  /** Children per node. 2 for a binary heap, 4 for a 4-ary one. Default 2. */
  arity?: number;
  /** Values equal to this are treated as absent (a hole in the array). */
  nullAs?: unknown;
  /** Label each edge with the index formula, e.g. `2i+1`. Default false. */
  edgeLabels?: boolean;
}

/**
 * A complete tree read out of an array, the way a heap is stored: node ids are
 * array indices, and the children of `i` are `arity*i + 1 … arity*i + arity`.
 *
 * Ids being indices is the whole point — an ` ```array ` fence over the same
 * values lines up with this tree key-for-key, so `activeIndices` and
 * `activeNodes` are the same set and one `link:` keeps them in step. The same
 * shape serves segment trees and k-ary heaps; a HeapView would add nothing.
 */
export function heapTreeFromArray(
  values: readonly unknown[],
  opts: HeapTreeOptions = {},
): LayoutInput | null {
  const { arity = 2, nullAs, edgeLabels = false } = opts;
  const k = Math.max(2, Math.trunc(arity));
  const present = (i: number) =>
    i < values.length && values[i] !== undefined && values[i] !== null && values[i] !== nullAs;
  if (!present(0)) return null;

  const build = (i: number, childOrder: number): LayoutInput => {
    const node: LayoutInput = { value: values[i] as string | number, id: i };
    if (edgeLabels && i > 0) node.edgeLabel = `${k}i+${childOrder}`;
    // Binary heaps use left/right, so a lone left child (the last internal
    // node of an even-length heap) hangs left instead of straight down.
    if (k === 2) {
      if (present(2 * i + 1)) node.left = build(2 * i + 1, 1);
      if (present(2 * i + 2)) node.right = build(2 * i + 2, 2);
      return node;
    }
    const kids: LayoutInput[] = [];
    for (let c = 1; c <= k; c++) {
      const child = k * i + c;
      if (present(child)) kids.push(build(child, c));
    }
    if (kids.length > 0) node.children = kids;
    return node;
  };

  return build(0, 0);
}
