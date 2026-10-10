import { lazy } from "react";
import type { FenceSpec } from "../registry";
import { summarizeTable } from "@kw/widgets/widgetA11y";
import { CANVAS_ATTRS, anyValue, bool, many, number, objectList, string } from "./common";

const TableView = lazy(() =>
  import("@kw/widgets/TableView").then((m) => ({ default: m.TableView })),
);

export const tableSpec: FenceSpec = {
  lang: "table",
  aliases: ["relation"],
  description:
    "A named-column table: relations, schemas, lock tables, Bayes 2×2, MVCC row versions. Cells are addressed `\"rowKey.colKey\"`.",
  component: TableView,
  // A markdown pipe table in a ```table fence has no `columns:` key and falls
  // through to a code block, which is what an imported vault expects.
  required: ["columns"],
  schema: {
    attributes: {
      columns: {
        type: "array",
        items: "object",
        required: true,
        description: "`{key, label?, pk?, fk?: {table, column}, align?, width?, type?}`.",
        steppable: false,
      },
      rows: {
        type: "array",
        items: "object",
        required: true,
        description: "One object per row, keyed by column `key`.",
      },
      rowKey: string("Column whose value identifies a row. Defaults to the `pk` column.", false),
      activeCells: many('Cells written this step, as `"rowKey.colKey"`.'),
      highlightCells: many("Secondary-highlighted cells."),
      dimCells: many("Dimmed cells."),
      activeRows: many("Row keys active this step."),
      highlightRows: many("Secondary-highlighted row keys."),
      dimRows: many("Dimmed row keys."),
      highlightCols: many("Highlighted column keys — the join key, the column being scanned."),
      insertedRows: many("Rows added this step, drawn green with a `+` gutter."),
      deletedRows: many("Rows removed this step, struck through."),
      arrows: objectList('Cell-to-cell references: `{from: "r.c", to: "r.c", label?}`.'),
      sort: { type: "object", description: "Sort indicator only: `{key, dir}`. Rows render in the order given." },
      caption: string("Caption under the table.", false),
      maxRows: number("Render at most this many rows, then a \"…n more\" line.", false),
      maxHeight: number("Scroll past this height, px. Default 420.", false),
      why: anyValue("Cell key → explanation, revealed when the reader selects it."),
      widgetId: string("Name for the inspect bus, for cross-widget linking.", false),
      showIndices: bool("Unused; accepted so `table` and `matrix` bodies are interchangeable.", false),
      ...CANVAS_ATTRS,
    },
  },
  summarize: (props) => summarizeTable(props as Parameters<typeof summarizeTable>[0]),
  example: `\`\`\`table id=orders caption="A write skew: both transactions read, then both write"
columns:
  - {key: id, label: id, pk: true, type: int}
  - {key: user, label: user_id, fk: {table: users, column: id}}
  - {key: total, label: total, align: right, type: numeric}
rows:
  - {id: 1, user: 7, total: 42.00}
  - {id: 2, user: 7, total: 19.50}
  - {id: 3, user: 9, total: 8.25}
steps:
  - note: "T1 scans user 7's orders"
    highlightCols: [user]
    highlightRows: ["1", "2"]
  - note: "T2 inserts another order for the same user"
    insertedRows: ["4"]
    rows:
      - {id: 1, user: 7, total: 42.00}
      - {id: 2, user: 7, total: 19.50}
      - {id: 3, user: 9, total: 8.25}
      - {id: 4, user: 7, total: 30.00}
  - note: "T1's invariant no longer holds — this is why it needs SERIALIZABLE"
    activeCells: ["4.total"]
\`\`\``,
};
