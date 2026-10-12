import { lazy } from "react";
import type { FenceSpec } from "../registry";
import { summarizeMatrix } from "@kw/widgets/widgetA11y";
import { CANVAS_ATTRS, bool, cells, number, objectList, string } from "./common";

const MatrixView = lazy(() =>
  import("@kw/widgets/MatrixView").then((m) => ({ default: m.MatrixView })),
);

export const matrixSpec: FenceSpec = {
  lang: "matrix",
  aliases: ["grid", "kiwi-grid", "dp"],
  description:
    "An index-addressed table: DP tables, grids, adjacency matrices, confusion matrices. Cells take `[r, c]` or `\"r,c\"`.",
  component: MatrixView,
  required: ["values", "layers"],
  requireOneOf: ["values", "layers"],
  schema: {
    attributes: {
      values: {
        type: "array",
        items: ["array", "string"],
        description:
          "Rows of cell values. Rows may differ in length (ragged / triangular). `null` is unfilled, ±Infinity shows ∞, booleans show T/F.",
      },
      activeCell: cells("The cell being written this step."),
      activeCells: cells("Cells being written this step."),
      readCells: cells("Cells the active cell reads from — diagonal, above, left."),
      highlightCells: cells("Secondary highlight."),
      dimCells: cells("Dimmed cells."),
      mask: {
        type: ["string", "array"],
        description: '`"lower"` or `"upper"` to grey out the unused triangle, or an explicit cell list.',
      },
      cellColors: { type: "array", items: "array", description: "Base color per cell." },
      heatmap: {
        type: ["boolean", "object"],
        description: "Shade numeric cells by value. `true` uses the table's own min/max.",
      },
      sublabels: { type: "array", items: "array", description: "Small caption under each value — a choice arrow, a parent pointer." },
      tooltips: { type: "array", items: "array", description: "Hover text per cell." },
      empty: { type: "array", items: "string", description: 'Strings that render as unfilled slots, e.g. `["."]`.' },
      arrows: objectList("Dependency arrows between cells: `{from, to, label?, dashed?}`."),
      path: { type: "array", description: "A traceback path drawn as a line over the cells." },
      pathColor: string("Color of the traceback path.", false),
      rowPointers: objectList("Row labels right of the table: `{row, label, color?}`."),
      colPointers: objectList("Column labels above the table: `{col, label, color?}`."),
      colHeaders: { type: "array", description: "Captions per column — the characters of a string, item weights, bit place values." },
      rowHeaders: { type: "array", description: "Captions per row." },
      showIndices: bool("Show row and column indices. Default true.", false),
      centerRows: {
        type: ["boolean", "string"],
        description: 'Ragged mode: `"start"` for a staircase, `"center"` for a pyramid.',
        steppable: false,
      },
      roundCells: bool("Circular cells instead of squares, for coin and token grids.", false),
      layers: objectList("Slices of a 3-D table as tabs: `{label, values}`. The shown slice replaces `values`."),
      layer: number("Index of the slice to show. Readers can still click the tabs."),
      flash: bool("Pulse cells whose value changed since the previous step. Default true."),
      readColor: string("Color of cells read by the active cell.", false),
      cellSize: number("Cell size in px. Defaults to 44, shrinking for wide tables.", false),
      ...CANVAS_ATTRS,
    },
  },
  summarize: (props) => summarizeMatrix(props as Parameters<typeof summarizeMatrix>[0]),
  example: `\`\`\`matrix id=lcs caption="Longest common subsequence of ABC and AC"
rowHeaders: ["", A, B, C]
colHeaders: ["", A, C]
values:
  - [0, 0, 0]
  - [0, 1, 1]
  - [0, 1, 1]
  - [0, 1, 2]
steps:
  - note: "Characters match: take the diagonal and add one"
    activeCells: [[1, 1]]
    readCells: [[0, 0]]
    line: 4
  - note: "No match: carry the better of above and left"
    activeCells: [[2, 2]]
    readCells: [[1, 2], [2, 1]]
    line: 6
  - note: "Match again — the answer is 2"
    activeCells: [[3, 2]]
    readCells: [[2, 1]]
    path: [[3, 2], [2, 1], [1, 1]]
code: |
  for i in range(1, n + 1):
      for j in range(1, m + 1):
          if a[i-1] == b[j-1]:
              dp[i][j] = dp[i-1][j-1] + 1
          else:
              dp[i][j] = max(dp[i-1][j], dp[i][j-1])
lang: python
\`\`\``,
};
