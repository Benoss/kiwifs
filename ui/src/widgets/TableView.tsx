import { useSyncExternalStore } from "react";
import { alpha } from "./colors";
import { getPageData, pageDataVersion, subscribePageData } from "@kw/lib/pageData";
import { toSet, type Many } from "./sets";
import { WidgetText } from "./WidgetText";
import { summarizeTable } from "./widgetA11y";
import { partHandlers, useInspect, whyFor } from "./inspect";
import type { CellValue } from "./cellOverlay";

/**
 * A named-column table: relations, schemas, lock tables, Bayes 2×2, runbook
 * matrices, MVCC row versions.
 *
 * Not `MatrixView` — cells are addressed by row key and column name, not by
 * `[r, c]`, which is what lets a primary key stay the identity of a row while
 * it is inserted, updated and deleted across steps. Not `kiwi-data` either:
 * that is a queryable dataset with no animation surface.
 */

export interface TableColumn {
  key: string;
  label?: string;
  /** Marks the primary key. Rendered with a key glyph and used as `rowKey`. */
  pk?: boolean;
  /** Foreign key target, shown in the header and used by cross-table arrows. */
  fk?: { table: string; column: string };
  align?: "left" | "right" | "center";
  /** Column width in px. */
  width?: number;
  /** Shown under the label — `int`, `text not null`. */
  type?: string;
}

export interface TableArrow {
  /** `"rowKey.colKey"` of the source cell. */
  from: string;
  to: string;
  label?: string;
  color?: string;
}

export interface TableViewProps {
  /**
   * Columns. Omit them to infer one per key seen in `rows`, in first-seen
   * order — which is what you want when the rows came from a dataset rather
   * than from an author.
   */
  columns?: TableColumn[];
  rows?: Record<string, CellValue>[];
  /** Column whose value identifies a row. Defaults to the `pk` column, else the index. */
  rowKey?: string;
  /** Cells being written this step, as `"rowKey.colKey"`. */
  activeCells?: Many<string>;
  /** Secondary-highlighted cells. */
  highlightCells?: Many<string>;
  /** Dimmed cells. */
  dimCells?: Many<string>;
  activeRows?: Many<string>;
  highlightRows?: Many<string>;
  dimRows?: Many<string>;
  highlightCols?: Many<string>;
  /** Rows added this step — green, with a `+` gutter. */
  insertedRows?: Many<string>;
  /** Rows removed this step — struck through. MVCC and diffs. */
  deletedRows?: Many<string>;
  /** Arrows between cells: a join key, a foreign key, a parent pointer. */
  arrows?: TableArrow[];
  /** Sort indicator only; the rows are rendered in the order given. */
  sort?: { key: string; dir?: "asc" | "desc" };
  caption?: string;
  /** Render at most this many rows, then a "…n more" line. */
  maxRows?: number;
  /** Scroll past this height rather than growing the page. Default 420. */
  maxHeight?: number;
  /** Widget id for the inspect bus. Defaults to "table". */
  widgetId?: string;
  /**
   * Render the records of a `kiwi-data` block on the same page, by kind.
   * `rows` wins when both are given, so a fence can override a dataset.
   */
  fromData?: string;
  /** Key → explanation, revealed when the reader selects that cell or row. */
  why?: Record<string, string>;
  activeColor?: string;
  highlightColor?: string;
  ariaLabel?: string;
}

const DEFAULTS = {
  activeColor: "var(--kw-widget-active, #a78bfa)",
  highlightColor: "var(--kw-widget-highlight, #22c55e)",
  dimColor: "var(--kw-widget-dim, #64748b)",
  border: "var(--kw-widget-border, #3f3f46)",
  text: "var(--kw-widget-text, #e5e7eb)",
  surface: "var(--kw-widget-surface, #18181b)",
  inserted: "var(--kw-widget-highlight, #22c55e)",
  deleted: "var(--kw-widget-accent-rose, #f43f5e)",
};

/** One column per key seen across the rows, in the order they first appear. */
export function inferColumns(rows: readonly Record<string, CellValue>[]): TableColumn[] {
  const seen: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) if (!seen.includes(key)) seen.push(key);
  }
  return seen.map((key) => ({
    key,
    label: key,
    align: rows.every((r) => r[key] == null || typeof r[key] === "number") ? "right" : "left",
  }));
}

function format(v: CellValue): string {
  if (v == null) return "∅";
  if (v === Infinity) return "∞";
  if (v === -Infinity) return "−∞";
  if (typeof v === "boolean") return v ? "T" : "F";
  return String(v);
}

export function TableView({
  columns: columnsIn,
  rows: rowsIn,
  fromData,
  rowKey,
  activeCells,
  highlightCells,
  dimCells,
  activeRows,
  highlightRows,
  dimRows,
  highlightCols,
  insertedRows,
  deletedRows,
  arrows,
  sort,
  caption,
  maxRows,
  maxHeight = 420,
  widgetId = "table",
  why,
  activeColor = DEFAULTS.activeColor,
  highlightColor = DEFAULTS.highlightColor,
  ariaLabel,
}: TableViewProps) {
  const bus = useInspect();
  // Re-read on every registration so a data block that mounts after this
  // fence still fills it.
  useSyncExternalStore(subscribePageData, pageDataVersion, pageDataVersion);
  const linked_ = fromData ? getPageData(fromData) : undefined;
  const rows = rowsIn ?? (linked_?.records as Record<string, CellValue>[] | undefined) ?? [];
  // Inferred columns keep first-seen key order, so a dataset reads in the
  // order it was written rather than alphabetically.
  const columns = columnsIn ?? inferColumns(rows);
  const pkColumn = columns.find((c) => c.pk)?.key;
  const idOf = (row: Record<string, CellValue>, i: number) => {
    const key = rowKey ?? pkColumn;
    const v = key ? row[key] : undefined;
    return v == null ? String(i) : String(v);
  };

  const activeCellSet = toSet(activeCells);
  const highlightCellSet = toSet(highlightCells);
  const dimCellSet = toSet(dimCells);
  const activeRowSet = toSet(activeRows);
  const highlightRowSet = toSet(highlightRows);
  const dimRowSet = toSet(dimRows);
  const highlightColSet = toSet(highlightCols);
  const insertedSet = toSet(insertedRows);
  const deletedSet = toSet(deletedRows);
  const linked = bus.linkedKeys(widgetId);
  const mergedWhy = { ...bus.why, ...(why ?? {}) };

  const selectableCell = (cellId: string) =>
    whyFor(mergedWhy, { widget: widgetId, kind: "cell", key: cellId }) !== undefined;
  const firstSelectable = (() => {
    for (let i = 0; i < rows.length; i++) {
      for (const col of columns) {
        const id = `${idOf(rows[i]!, i)}.${col.key}`;
        if (selectableCell(id)) return id;
      }
    }
    return undefined;
  })();

  const shown = maxRows != null ? rows.slice(0, maxRows) : rows;
  const hidden = rows.length - shown.length;

  // Arrows between <td>s would need measured geometry; a glyph in the source
  // cell plus the target's key says the same thing and survives a reflow.
  const arrowFrom = new Map<string, TableArrow>();
  for (const a of arrows ?? []) arrowFrom.set(a.from, a);

  const label = ariaLabel ?? summarizeTable({ columns, rows, caption });

  return (
    <div style={{ overflow: "auto", maxHeight, padding: "0.25rem 0" }}>
      <table
        role="table"
        aria-label={label}
        style={{
          borderCollapse: "separate",
          borderSpacing: 0,
          fontSize: "0.8rem",
          fontVariantNumeric: "tabular-nums",
          width: "max-content",
          minWidth: "100%",
          color: DEFAULTS.text,
        }}
      >
        {caption && (
          <caption
            style={{
              captionSide: "bottom",
              paddingTop: 8,
              fontSize: "0.72rem",
              color: DEFAULTS.dimColor,
              textAlign: "left",
            }}
          >
            <WidgetText text={caption} />
          </caption>
        )}
        <thead>
          <tr>
            {columns.map((col) => {
              const lit = highlightColSet.has(col.key);
              return (
                <th
                  key={col.key}
                  scope="col"
                  style={{
                    position: "sticky",
                    top: 0,
                    zIndex: 1,
                    textAlign: col.align ?? "left",
                    padding: "6px 10px",
                    width: col.width,
                    whiteSpace: "nowrap",
                    background: lit ? alpha(highlightColor, 18) : DEFAULTS.surface,
                    borderBottom: `2px solid ${lit ? highlightColor : DEFAULTS.border}`,
                    fontWeight: 700,
                  }}
                >
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                    {col.pk && (
                      <span title="primary key" style={{ color: activeColor, fontSize: "0.7rem" }}>
                        ⚿
                      </span>
                    )}
                    <WidgetText text={col.label ?? col.key} />
                    {sort?.key === col.key && (
                      <span style={{ color: DEFAULTS.dimColor }}>
                        {sort.dir === "desc" ? "▼" : "▲"}
                      </span>
                    )}
                  </span>
                  {(col.type || col.fk) && (
                    <div
                      style={{
                        fontWeight: 400,
                        fontSize: "0.65rem",
                        color: DEFAULTS.dimColor,
                        fontFamily: "ui-monospace, SFMono-Regular, monospace",
                      }}
                    >
                      {col.fk ? `→ ${col.fk.table}.${col.fk.column}` : col.type}
                    </div>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {shown.map((row, i) => {
            const id = idOf(row, i);
            const inserted = insertedSet.has(id);
            const deleted = deletedSet.has(id);
            const rowActive = activeRowSet.has(id);
            const rowLit = highlightRowSet.has(id) || linked.has(id);
            const rowDim = dimRowSet.has(id);
            return (
              <tr
                key={id}
                style={{
                  opacity: rowDim || deleted ? 0.5 : 1,
                  background: rowActive
                    ? alpha(activeColor, 14)
                    : rowLit
                      ? alpha(highlightColor, 12)
                      : inserted
                        ? alpha(DEFAULTS.inserted, 10)
                        : "transparent",
                  transition: "background 0.25s ease, opacity 0.25s ease",
                }}
              >
                {columns.map((col, ci) => {
                  const cellId = `${id}.${col.key}`;
                  const active = activeCellSet.has(cellId);
                  const lit = highlightCellSet.has(cellId);
                  const dim = dimCellSet.has(cellId);
                  const arrow = arrowFrom.get(cellId);
                  const hasWhy = whyFor(mergedWhy, { widget: widgetId, kind: "cell", key: cellId }) !== undefined;
                  const handlers = hasWhy
                    ? partHandlers(widgetId, "cell", cellId, bus, {
                          why: mergedWhy,
                          tabbable: cellId === firstSelectable,
                        })
                    : {};
                  return (
                    <td
                      key={col.key}
                      {...handlers}
                      style={{
                        textAlign: col.align ?? "left",
                        padding: "5px 10px",
                        whiteSpace: "nowrap",
                        borderBottom: `1px solid ${DEFAULTS.border}`,
                        background: active
                          ? activeColor
                          : lit
                            ? alpha(highlightColor, 22)
                            : highlightColSet.has(col.key)
                              ? alpha(highlightColor, 8)
                              : "transparent",
                        color: active ? "var(--kw-widget-active-foreground, #111827)" : undefined,
                        opacity: dim ? 0.45 : 1,
                        fontWeight: col.pk ? 700 : 400,
                        textDecoration: deleted ? "line-through" : undefined,
                        cursor: hasWhy ? "pointer" : undefined,
                        outline: "none",
                        transition: "background 0.25s ease",
                      }}
                    >
                      {ci === 0 && (inserted || deleted) && (
                        <span
                          aria-hidden
                          style={{
                            color: inserted ? DEFAULTS.inserted : DEFAULTS.deleted,
                            marginRight: 6,
                            fontWeight: 700,
                          }}
                        >
                          {inserted ? "+" : "−"}
                        </span>
                      )}
                      <WidgetText text={format(row[col.key] ?? null)} />
                      {arrow && (
                        <span
                          title={arrow.label ?? `→ ${arrow.to}`}
                          style={{ color: arrow.color ?? activeColor, marginLeft: 6 }}
                        >
                          ↳
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
          {hidden > 0 && (
            <tr>
              <td
                colSpan={columns.length}
                style={{ padding: "5px 10px", color: DEFAULTS.dimColor, fontStyle: "italic" }}
              >
                …{hidden} more {hidden === 1 ? "row" : "rows"}
              </td>
            </tr>
          )}
          {rows.length === 0 && (
            <tr>
              <td
                colSpan={columns.length}
                style={{ padding: "10px", color: DEFAULTS.dimColor, textAlign: "center" }}
              >
                (no rows)
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
