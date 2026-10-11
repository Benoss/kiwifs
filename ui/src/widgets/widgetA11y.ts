/**
 * Accessible names for widget canvases.
 *
 * A diagram with `role="img"` and no name is announced as "image" and nothing
 * else, which is worse than no role at all. Every canvas therefore derives a
 * one-sentence summary from the data it was already given; authors override it
 * with `ariaLabel`. The same summaries are what a PDF export and the search
 * index fall back to, so they have to read as prose rather than as a prop dump.
 *
 * Refs: W3C Graphics ARIA (graphics-document / graphics-symbol roles),
 * ACT rule 7d6734 ("image has accessible name").
 */

import { toSet, type CellRef, type Many, type ManyCells, cellKey } from "./sets";

/** Longest list we spell out before switching to a count. */
const MAX_ITEMS = 12;

function num(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/**
 * Display text for a value an author or a model may have handed over in any
 * shape. Objects and arrays read as truncated JSON rather than
 * `[object Object]`.
 */
export function shortText(v: unknown, max = 60): string {
  if (v == null) return String(v);
  if (typeof v !== "object" && typeof v !== "function") return String(v);
  let text: string;
  try {
    text = JSON.stringify(v) ?? String(v);
  } catch {
    text = Array.isArray(v) ? "[…]" : "{…}";
  }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Only the plain objects in what should have been a list of them. */
export function objectsOf<T extends object>(value: unknown): T[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is T => typeof v === "object" && v !== null && !Array.isArray(v));
}

function cellText(v: unknown): string {
  if (v == null) return "empty";
  if (v === Infinity) return "infinity";
  if (v === -Infinity) return "negative infinity";
  if (typeof v === "boolean") return v ? "true" : "false";
  return shortText(v);
}

function list(values: readonly unknown[]): string {
  if (values.length <= MAX_ITEMS) return values.map(cellText).join(", ");
  return `${values.slice(0, MAX_ITEMS).map(cellText).join(", ")}, and ${values.length - MAX_ITEMS} more`;
}

function indexList(set: Set<number>): string {
  const sorted = [...set].sort((a, b) => a - b);
  if (sorted.length === 0) return "";
  if (sorted.length === 1) return `index ${sorted[0]}`;
  if (sorted.length <= MAX_ITEMS) return `indices ${sorted.join(", ")}`;
  return `${sorted.length} indices`;
}

/** Join non-empty clauses into one sentence. */
export function sentence(...parts: (string | false | null | undefined)[]): string {
  const kept = parts.filter((p): p is string => Boolean(p && p.trim()));
  if (kept.length === 0) return "";
  const text = kept.join("; ");
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

export function summarizeArray(opts: {
  values?: readonly unknown[];
  label?: string;
  activeIndices?: Many<number>;
  highlightIndices?: Many<number>;
  pointers?: readonly { index: number; label: string }[];
}): string {
  const values = opts.values ?? [];
  const active = toSet(opts.activeIndices);
  const highlight = toSet(opts.highlightIndices);
  return sentence(
    `${opts.label ? `${opts.label}: ` : ""}array of ${num(values.length, "value")}`,
    values.length ? list(values) : "",
    active.size ? `active at ${indexList(active)}` : "",
    highlight.size ? `highlighted at ${indexList(highlight)}` : "",
    opts.pointers?.length
      ? `pointers ${opts.pointers.map((p) => `${p.label} at ${p.index}`).join(", ")}`
      : "",
  );
}

export function summarizeArrayStack(rows: readonly { label?: string; values?: readonly unknown[] }[]): string {
  if (rows.length === 0) return "Empty table.";
  return sentence(
    `${num(rows.length, "row")} over a shared index`,
    rows
      .slice(0, 6)
      .map((r, i) => `${r.label || `row ${i + 1}`} of ${num((r.values ?? []).length, "value")}`)
      .join(", "),
  );
}

export function summarizeMatrix(opts: {
  values?: readonly (readonly unknown[])[];
  activeCells?: ManyCells;
  highlightCells?: ManyCells;
  path?: readonly CellRef[];
}): string {
  const rows = opts.values?.length ?? 0;
  const cols = rows ? Math.max(...opts.values!.map((r) => r.length)) : 0;
  const active = [...toCellKeys(opts.activeCells)];
  const highlight = toCellKeys(opts.highlightCells);
  return sentence(
    `table of ${rows} rows by ${cols} columns`,
    active.length ? `active cell${active.length > 1 ? "s" : ""} ${active.slice(0, MAX_ITEMS).join(" ")}` : "",
    highlight.size ? `${num(highlight.size, "highlighted cell")}` : "",
    opts.path?.length ? `traceback path of ${num(opts.path.length, "cell")}` : "",
  );
}

function toCellKeys(value: ManyCells): Set<string> {
  if (value == null) return new Set();
  if (value instanceof Set) {
    const out = new Set<string>();
    for (const v of value) out.add(cellKey(v as CellRef));
    return out;
  }
  try {
    return new Set((value as readonly CellRef[]).map(cellKey));
  } catch {
    return new Set();
  }
}

interface TreeLike {
  value?: string | number;
  id?: string | number;
  keys?: readonly (string | number)[];
  left?: TreeLike | null;
  right?: TreeLike | null;
  children?: readonly (TreeLike | null | undefined)[];
}

function treeStats(node: TreeLike | null | undefined, depth = 1): { nodes: number; height: number; leaves: number } {
  if (!node) return { nodes: 0, height: depth - 1, leaves: 0 };
  const kids = [node.left, node.right, ...(node.children ?? [])].filter(Boolean) as TreeLike[];
  if (kids.length === 0) return { nodes: 1, height: depth, leaves: 1 };
  let nodes = 1;
  let height = depth;
  let leaves = 0;
  for (const kid of kids) {
    const s = treeStats(kid, depth + 1);
    nodes += s.nodes;
    leaves += s.leaves;
    height = Math.max(height, s.height);
  }
  return { nodes, height, leaves };
}

export function summarizeTree(opts: {
  root?: TreeLike | null;
  roots?: readonly (TreeLike | null | undefined)[];
  parents?: unknown;
  activeNodes?: Many<string | number>;
}): string {
  const trees = [opts.root, ...(opts.roots ?? [])].filter(Boolean) as TreeLike[];
  if (trees.length === 0 && opts.parents) {
    const count = Array.isArray(opts.parents)
      ? opts.parents.length
      : Object.keys(opts.parents as object).length;
    return sentence(`forest built from ${num(count, "parent pointer")}`);
  }
  if (trees.length === 0) return "Empty tree.";
  const stats = trees.map((t) => treeStats(t));
  const nodes = stats.reduce((a, s) => a + s.nodes, 0);
  const height = Math.max(...stats.map((s) => s.height));
  const leaves = stats.reduce((a, s) => a + s.leaves, 0);
  const active = toSet(opts.activeNodes);
  return sentence(
    trees.length > 1 ? `${num(trees.length, "tree")}` : "tree",
    `${num(nodes, "node")}, ${num(leaves, "leaf", "leaves")}, height ${height}`,
    active.size ? `active node${active.size > 1 ? "s" : ""} ${[...active].slice(0, MAX_ITEMS).join(", ")}` : "",
  );
}

export function summarizeLinkedList(opts: {
  nodes?: readonly { value: string | number; next?: boolean | number | null }[];
  doubly?: boolean;
  pointers?: readonly { index: number; label: string }[];
}): string {
  const nodes = opts.nodes ?? [];
  const cycle = nodes.some((n) => typeof n.next === "number");
  return sentence(
    `${opts.doubly ? "doubly " : ""}linked list of ${num(nodes.length, "node")}`,
    nodes.length ? list(nodes.map((n) => n.value)) : "",
    cycle ? "contains a cycle" : "",
    opts.pointers?.length
      ? `pointers ${opts.pointers.map((p) => `${p.label} at ${p.index}`).join(", ")}`
      : "",
  );
}

export function summarizeStack(opts: {
  values?: readonly (string | number)[];
  growth?: "top" | "bottom";
  title?: string;
}): string {
  const values = opts.values ?? [];
  if (values.length === 0) return sentence(`${opts.title || "stack"} is empty`);
  return sentence(
    `${opts.title || "stack"} of ${num(values.length, "item")}`,
    `bottom to top: ${list(values)}`,
    `top is ${cellText(values[values.length - 1])}`,
  );
}

export function summarizeBits(opts: {
  value?: number;
  bits?: number;
  label?: string;
  activeBits?: Many<number>;
}): string {
  const value = Number(opts.value ?? 0);
  const width = opts.bits ?? Math.max(1, value.toString(2).length);
  const active = toSet(opts.activeBits);
  const popcount = value.toString(2).split("").filter((c) => c === "1").length;
  return sentence(
    `${opts.label ? `${opts.label}: ` : ""}${width}-bit value ${value}`,
    `binary ${(value >>> 0).toString(2).padStart(width, "0")}`,
    `${num(popcount, "bit")} set`,
    active.size ? `bit${active.size > 1 ? "s" : ""} ${[...active].sort((a, b) => a - b).join(", ")} active this step` : "",
  );
}

export function summarizeGraph(opts: {
  nodes?: readonly { id: string | number; label?: string }[];
  edges?: readonly unknown[];
  directed?: boolean;
  groups?: readonly { id: string; label?: string }[];
}): string {
  const nodes = opts.nodes ?? [];
  return sentence(
    `${opts.directed ? "directed" : "undirected"} graph of ${num(nodes.length, "node")} and ${num((opts.edges ?? []).length, "edge")}`,
    nodes.length ? `nodes ${list(nodes.map((n) => n.label ?? n.id))}` : "",
    opts.groups?.length ? `grouped into ${list(opts.groups.map((g) => g.label ?? g.id))}` : "",
  );
}

export function summarizeSequence(opts: {
  participants?: readonly { id: string; label?: string }[];
  items?: readonly unknown[];
  step?: number;
}): string {
  const participants = opts.participants ?? [];
  return sentence(
    `sequence diagram between ${list(participants.map((p) => p.label ?? p.id))}`,
    `${num((opts.items ?? []).length, "message")}`,
    opts.step ? `showing the first ${opts.step}` : "",
  );
}

export function summarizeBars(opts: {
  values?: readonly number[];
  labels?: readonly (string | number | null)[];
  activeIndices?: Many<number>;
}): string {
  const values = opts.values ?? [];
  if (values.length === 0) return "Empty bar chart.";
  const active = toSet(opts.activeIndices);
  return sentence(
    `bar chart of ${num(values.length, "column")}`,
    `values ${list(values)}`,
    `from ${Math.min(...values)} to ${Math.max(...values)}`,
    active.size ? `active at ${indexList(active)}` : "",
  );
}

export function summarizePlot(opts: {
  series?: readonly { id?: string | number; label?: string; points?: readonly unknown[] }[];
  xLabel?: string;
  yLabel?: string;
}): string {
  const series = opts.series ?? [];
  return sentence(
    `plot of ${num(series.length, "series")}`
      + (opts.xLabel || opts.yLabel ? ` with ${opts.xLabel || "x"} against ${opts.yLabel || "y"}` : ""),
    series
      .slice(0, 6)
      .map((s, i) => `${s.label ?? s.id ?? `series ${i + 1}`} (${num((s.points ?? []).length, "point")})`)
      .join(", "),
  );
}

export function summarizeTimeline(opts: {
  intervals?: readonly { start: number; end: number; label?: string; lane?: number | string }[];
  lanes?: readonly string[];
  sweep?: number;
}): string {
  const intervals = opts.intervals ?? [];
  if (intervals.length === 0) return "Empty timeline.";
  const min = Math.min(...intervals.map((i) => i.start));
  const max = Math.max(...intervals.map((i) => i.end));
  return sentence(
    `timeline of ${num(intervals.length, "interval")} from ${min} to ${max}`,
    opts.lanes?.length ? `lanes ${list(opts.lanes)}` : "",
    opts.sweep != null ? `sweep at ${opts.sweep}` : "",
  );
}

export function summarizeNumberLine(opts: {
  min?: number;
  max?: number;
  points?: readonly { x: number; label?: string }[];
  intervals?: readonly { from: number; to: number; label?: string }[];
}): string {
  const points = objectsOf<{ x: number }>(opts.points);
  const intervals = objectsOf<{ from: number; to: number }>(opts.intervals);
  return sentence(
    `number line from ${cellText(opts.min ?? 0)} to ${cellText(opts.max ?? 0)}`,
    points.length ? `${num(points.length, "point")} at ${list(points.map((p) => p.x))}` : "",
    intervals.length
      ? `intervals ${intervals.slice(0, MAX_ITEMS).map((i) => `${cellText(i.from)} to ${cellText(i.to)}`).join(", ")}`
      : "",
  );
}

export function summarizeTable(opts: {
  columns?: readonly ({ key: string; label?: string } | string)[];
  rows?: readonly unknown[];
  caption?: string;
}): string {
  const columns = (Array.isArray(opts.columns) ? opts.columns : []).filter(
    (c): c is { key: string; label?: string } | string => typeof c === "string" || (typeof c === "object" && c !== null),
  );
  const rows = Array.isArray(opts.rows) ? opts.rows : [];
  return sentence(
    typeof opts.caption === "string" ? opts.caption : "",
    `table of ${num(rows.length, "row")} and ${num(columns.length, "column")}`,
    columns.length ? `columns ${list(columns.map((c) => (typeof c === "string" ? c : c.label ?? c.key)))}` : "",
  );
}

export function summarizeMap(opts: {
  mode?: string;
  capacity?: number;
  slots?: readonly unknown[];
  entries?: readonly { key: string | number }[] | Readonly<Record<string, unknown>>;
}): string {
  if (opts.entries != null && typeof opts.entries === "object") {
    const keys = Array.isArray(opts.entries)
      ? objectsOf<{ key: unknown }>(opts.entries).map((e) => e.key)
      : Object.keys(opts.entries);
    return sentence(`map of ${num(keys.length, "entry", "entries")}`, keys.length ? `keys ${list(keys)}` : "");
  }
  const slots = Array.isArray(opts.slots) ? opts.slots : [];
  const used = slots.filter((s) => s != null && s !== "DEL").length;
  const capacity =
    typeof opts.capacity === "number" && Number.isFinite(opts.capacity)
      ? Math.max(0, Math.trunc(opts.capacity))
      : slots.length;
  return sentence(
    `hash table of ${num(capacity, "slot")}`,
    `${used} occupied`,
    opts.mode && opts.mode !== "map" ? `${opts.mode} collision resolution` : "",
  );
}

export function summarizePlane(opts: {
  points?: readonly unknown[];
  segments?: readonly unknown[];
  polygons?: readonly unknown[];
  circles?: readonly unknown[];
  xMin?: number;
  xMax?: number;
  yMin?: number;
  yMax?: number;
}): string {
  const shapes: string[] = [];
  const count = (v: readonly unknown[] | undefined) => (Array.isArray(v) ? v.length : 0);
  if (count(opts.points)) shapes.push(num(count(opts.points), "point"));
  if (count(opts.segments)) shapes.push(num(count(opts.segments), "segment"));
  if (count(opts.polygons)) shapes.push(num(count(opts.polygons), "polygon"));
  if (count(opts.circles)) shapes.push(num(count(opts.circles), "circle"));
  return sentence(
    `coordinate plane from (${cellText(opts.xMin ?? 0)}, ${cellText(opts.yMin ?? 0)}) to (${cellText(opts.xMax ?? 0)}, ${cellText(opts.yMax ?? 0)})`,
    shapes.join(", "),
  );
}

// ── Roles ───────────────────────────────────────────────────────────────────

export interface CanvasAria {
  role: string;
  "aria-label": string;
}

/**
 * `role="img"` collapses a canvas to its name, which is right for a picture
 * and wrong the moment the reader can click a cell or switch a tab: it hides
 * the very controls they need. Interactive canvases therefore take the W3C
 * Graphics-ARIA `graphics-document` role, which keeps its children reachable.
 */
export function canvasAria(label: string, interactive = false): CanvasAria {
  return { role: interactive ? "graphics-document" : "img", "aria-label": label };
}
