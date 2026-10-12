import { createElement, lazy } from "react";
import type React from "react";
import type { FenceSpec } from "../registry";
import type { AttrType, SchemaAttribute } from "../schema";
import { summarizeArray, summarizeArrayStack } from "@kw/widgets/widgetA11y";
import { CANVAS_ATTRS, bool, many, number, objectList, string, stringList } from "./common";

/**
 * One fence, two shapes: `values:` draws a single row, `rows:` draws several
 * on a shared index axis. Two arrays stacked is the same picture as one, not a
 * second widget, so authors should not have to pick a different fence name.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ArrayAny = lazy(() =>
  import("@kw/widgets/ArrayView").then((m) => ({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    default: (props: any) =>
      createElement(
        (Array.isArray(props.rows) ? m.ArrayStack : m.ArrayView) as React.FC<unknown>,
        props,
      ),
  })),
);

/** Keys that work on a single row and inside each entry of `rows:`. */
export const ARRAY_ROW_ATTRS: Record<string, SchemaAttribute> = {
  values: {
    type: ["array", "string"] as AttrType[],
    description:
      "Cell values. `null` is an unfilled slot; ±Infinity shows ∞; a string is split into characters.",
  },
  label: string("Row title in the left gutter, e.g. `nums` or `dp`."),
  sublabels: { type: "array" as AttrType, description: "Caption under each value — a choice arrow ↖ ↑ ←, a parent pointer." },
  activeIndex: many("The cell being written this step."),
  activeIndices: many("Cells being written this step."),
  readIndices: many("Cells the active cell reads from — `dp[i-1]`, `dp[c-w]`."),
  highlightIndices: many("Secondary highlight, e.g. the current window."),
  dimIndices: many("Done / greyed-out cells."),
  cellColors: { type: "array" as AttrType, description: "Base color per cell, matching the same items in a tree or graph." },
  pointers: objectList("Named pointers above or below cells: `{index, label, color?, side?}`."),
  arrows: objectList("Dependency arcs within the row: `{from, to, label?, dashed?, side?}`."),
  ranges: objectList("Brackets over spans: `{start, end, label?, color?, side?}`."),
  tooltips: { type: "array" as AttrType, description: "Hover text per cell." },
  empty: stringList('Strings that render as unfilled slots, e.g. `["."]`.'),
  indexLabels: { type: "array" as AttrType, description: "Index captions instead of 0..n-1 — characters, amounts, `∅`." },
  offset: number("Blank cells before the first value, to line this row up under another."),
  showIndices: {
    type: ["boolean", "string"] as AttrType[],
    description: 'Show the index row. With `rows:`: true, false, "last" (default) or "all".',
  },
};

export const arraySpec: FenceSpec = {
  lang: "array",
  aliases: ["arraystack", "kiwi-arraystack"],
  description:
    "One or more arrays on a shared index axis, with pointers, dependency arrows and span brackets.",
  component: ArrayAny,
  required: ["values", "rows"],
  requireOneOf: ["values", "rows"],
  schema: {
    attributes: {
      ...ARRAY_ROW_ATTRS,
      rows: {
        type: "array",
        items: "object",
        description: "Several rows sharing one index axis. Each entry takes the single-row keys above.",
      },
      arrowsBetweenRows: {
        type: "array",
        items: "object",
        alias: "rowArrows",
        description: "With `rows:`: arrows between rows, `{from: [row, index], to: [row, index], label?}`.",
      },
      rowGap: number("Vertical gap between rows in px. Default 2, or 36 when arrows are drawn.", false),
      cellSize: number("Cell size in px. Defaults to 48, shrinking for long arrays.", false),
      indexBase: number("First index number. Default 0.", false),
      wrap: bool("Wrap long arrays onto more lines instead of scrolling.", false),
      flash: bool("Pulse cells whose value changed since the previous step. Default true."),
      labelWidth: number("Width of the row-label gutter in px.", false),
      readColor: string("Color of cells read by the active cell.", false),
      ...CANVAS_ATTRS,
    },
  },
  normalize(body) {
    if (!Array.isArray(body.rows)) return body;
    // `arrows` at the top level of a stack means row-to-row, which ArrayStack
    // spells `arrows` too — but a single-row author means within-row arrows.
    const { arrowsBetweenRows, ...rest } = body as Record<string, unknown>;
    return arrowsBetweenRows ? { ...rest, arrows: arrowsBetweenRows } : rest;
  },
  summarize(props) {
    const rows = (props as { rows?: { label?: string; values?: unknown[] }[] }).rows;
    return rows
      ? summarizeArrayStack(rows)
      : summarizeArray(props as Parameters<typeof summarizeArray>[0]);
  },
  example: `\`\`\`array id=two-sum caption="Two-pointer sweep on a sorted array"
values: [2, 7, 11, 15, 19]
pointers:
  - {index: 0, label: lo}
  - {index: 4, label: hi}
steps:
  - note: "2 + 19 = 21 > 9 — move hi left"
    activeIndices: [0, 4]
    line: 3
  - note: "2 + 15 = 17 > 9 — move hi left"
    pointers: [{index: 0, label: lo}, {index: 3, label: hi}]
    activeIndices: [0, 3]
  - note: "2 + 7 = 9 — found it"
    pointers: [{index: 0, label: lo}, {index: 1, label: hi}]
    activeIndices: [0, 1]
    breakpoint: true
code: |
  lo, hi = 0, len(a) - 1
  while lo < hi:
      s = a[lo] + a[hi]
      if s == target: return lo, hi
      if s > target: hi -= 1
      else: lo += 1
lang: python
\`\`\``,
};
