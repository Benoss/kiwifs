import { useRef } from "react";
import { alpha } from "./colors";
import { toSet, type Many } from "./sets";
import { WidgetText } from "./WidgetText";
import { CellOverlay, linkPath, useCellRects, type OverlayShape } from "./cellOverlay";
import { canvasAria, sentence } from "./widgetA11y";
import { partHandlers, useInspect, whyFor, type InspectRef } from "./inspect";
import {
  describeHeapObject,
  formatValue,
  frameOrder,
  heapOrder,
  isRef,
  refTarget,
  slotKey,
  type HeapId,
  type HeapObject,
  type StackFrame,
  type TraceValue,
} from "./memoryTrace";

export type {
  HeapId,
  HeapObject,
  StackFrame,
  TraceValue,
} from "./memoryTrace";

/**
 * Frames on the left, heap on the right, pointers drawn between them.
 *
 * The missing primitive for anything about aliasing, mutation, closures, or
 * "why did changing `b` change `a`". `widget:code` can show a value; only this
 * can show that two names are the same object.
 *
 * The props are Python Tutor's trace format rather than a tidier shape of our
 * own, so a recorded trace drops straight in and a tracer could drive this
 * later without an API change.
 */

export interface MemoryViewProps {
  /** Call stack, outermost first. */
  frames?: StackFrame[];
  /** Heap objects by id. Values reference them as `["REF", id]`. */
  heap?: Record<string, HeapObject>;
  /** Which frame is executing. Defaults to the last, as a call stack does. */
  activeFrame?: string | number;
  /** Heap ids to emphasise this step. */
  activeIds?: Many<HeapId>;
  /** Secondary-highlighted heap ids. */
  highlightIds?: Many<HeapId>;
  /** Dimmed heap ids — garbage, or a frame about to return. */
  dimIds?: Many<HeapId>;
  /**
   * Draw a primitive inside its slot rather than as a separate box. Default
   * true: a diagram where `3` gets its own heap object teaches the wrong
   * thing about Python, and the right thing about nothing.
   */
  inlinePrimitives?: boolean;
  /** Caption above the frames column. Default "Frames". */
  framesLabel?: string;
  /** Caption above the heap column. Default "Objects". */
  heapLabel?: string;
  onSelect?: (ref: InspectRef) => void;
  why?: Record<string, string>;
  widgetId?: string;
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
};

const MONO = "ui-monospace, SFMono-Regular, monospace";

function summarize(frames: StackFrame[], heap: Record<string, HeapObject>): string {
  const names = frames.map((f) => f.name);
  return sentence(
    frames.length ? `call stack ${names.join(" → ")}` : "no frames",
    `${Object.keys(heap).length} heap objects`,
  );
}

export function MemoryView({
  frames = [],
  heap = {},
  activeFrame,
  activeIds,
  highlightIds,
  dimIds,
  inlinePrimitives = true,
  framesLabel = "Frames",
  heapLabel = "Objects",
  onSelect,
  why,
  widgetId = "memory",
  activeColor = DEFAULTS.activeColor,
  highlightColor = DEFAULTS.highlightColor,
  ariaLabel,
}: MemoryViewProps) {
  const bus = useInspect();
  const mergedWhy = { ...bus.why, ...(why ?? {}) };
  const linked = bus.linkedKeys(widgetId);
  const boxRef = useRef<HTMLDivElement>(null);
  const rects = useCellRects(boxRef, true);

  const active = toSet(activeIds);
  const highlight = toSet(highlightIds);
  const dim = toSet(dimIds);

  const frameId = (frame: StackFrame, i: number) => frame.id ?? `${frame.name}#${i}`;
  const activeFrameId =
    activeFrame != null
      ? String(activeFrame)
      : frames.find((f) => f.active)
        ? frameId(frames.find((f) => f.active)!, frames.findIndex((f) => f.active))
        : frames.length
          ? frameId(frames[frames.length - 1]!, frames.length - 1)
          : "";

  const order = heapOrder(frames, heap);
  const entries = order
    .map((id) => {
      const raw = heap[String(id)];
      return raw ? describeHeapObject(id, raw) : null;
    })
    .filter((e): e is NonNullable<typeof e> => e !== null);

  const selectable = (key: string) =>
    onSelect !== undefined || whyFor(mergedWhy, { widget: widgetId, kind: "node", key }) !== undefined;
  const firstSelectable = entries.find((e) => selectable(String(e.id)))?.id;

  // Every pointer, drawn from the slot that holds it to the object it names.
  const shapes: OverlayShape[] = [];
  const box = boxRef.current;
  if (box) {
    const arrow = (fromKey: string, target: HeapId, lit: boolean) => {
      const a = rects.get(fromKey);
      const b = rects.get(`obj:${target}`);
      if (!a || !b) return;
      const { d } = linkPath(a, b, { labelAt: 0.5, labelOffset: 0 });
      shapes.push({
        d,
        color: lit ? activeColor : DEFAULTS.dimColor,
        width: lit ? 2 : 1.25,
        arrow: true,
      });
    };
    frames.forEach((frame, i) => {
      const scope = frameId(frame, i);
      const lit = scope === activeFrameId;
      for (const name of frameOrder(frame)) {
        const target = refTarget(frame.vars[name]);
        if (target != null) arrow(`var:${slotKey(scope, name)}`, target, lit);
      }
      const returned = refTarget(frame.returned);
      if (returned != null) arrow(`var:${slotKey(scope, "return")}`, returned, lit);
    });
    for (const entry of entries) {
      entry.slots.forEach((slot, j) => {
        const target = refTarget(slot.value);
        if (target != null) {
          arrow(`slot:${entry.id}:${j}`, target, active.has(entry.id));
        }
      });
    }
  }

  const toneOf = (id: HeapId) => {
    if (active.has(id)) return { border: activeColor, bg: alpha(activeColor, 14), opacity: 1 };
    if (highlight.has(id) || linked.has(String(id))) {
      return { border: highlightColor, bg: alpha(highlightColor, 12), opacity: 1 };
    }
    if (dim.has(id)) return { border: DEFAULTS.dimColor, bg: "transparent", opacity: 0.45 };
    return { border: DEFAULTS.border, bg: DEFAULTS.surface, opacity: 1 };
  };

  if (frames.length === 0 && entries.length === 0) {
    return (
      <div style={{ textAlign: "center", padding: 16, color: DEFAULTS.dimColor, fontSize: "0.8rem" }}>
        (nothing allocated)
      </div>
    );
  }

  const slotValue = (value: TraceValue) => {
    if (isRef(value)) {
      // The arrow says where it points; the text says it is a pointer at all,
      // which matters when the target has scrolled out of view.
      return <span style={{ color: DEFAULTS.dimColor }}>→</span>;
    }
    return <span style={{ color: DEFAULTS.text }}>{formatValue(value)}</span>;
  };

  return (
    <div
      {...canvasAria(ariaLabel ?? summarize(frames, heap), onSelect !== undefined)}
      style={{ padding: "0.5rem 0", overflowX: "auto" }}
    >
      <div
        ref={boxRef}
        style={{
          position: "relative",
          display: "flex",
          gap: 48,
          alignItems: "flex-start",
          width: "max-content",
          minWidth: "100%",
          fontSize: "0.75rem",
          fontFamily: MONO,
        }}
      >
        {/* Frames */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 150 }}>
          <ColumnLabel text={framesLabel} />
          {frames.map((frame, i) => {
            const scope = frameId(frame, i);
            const isActive = scope === activeFrameId;
            const rows = frameOrder(frame);
            return (
              <div
                key={scope}
                style={{
                  borderRadius: 6,
                  border: `2px solid ${isActive ? activeColor : DEFAULTS.border}`,
                  background: isActive ? alpha(activeColor, 10) : "transparent",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    padding: "2px 8px",
                    fontWeight: 700,
                    color: isActive ? activeColor : DEFAULTS.dimColor,
                    borderBottom: `1px solid ${DEFAULTS.border}`,
                  }}
                >
                  <WidgetText text={frame.name} />
                </div>
                {rows.length === 0 && frame.returned === undefined && (
                  <div style={{ padding: "2px 8px", color: DEFAULTS.dimColor }}>(no locals)</div>
                )}
                {rows.map((name) => (
                  <div
                    key={name}
                    style={{ display: "flex", gap: 8, padding: "2px 8px", alignItems: "center" }}
                  >
                    <span style={{ color: DEFAULTS.dimColor }}>{name}</span>
                    <span
                      data-cell={`var:${slotKey(scope, name)}`}
                      style={{ marginLeft: "auto", minWidth: 18, textAlign: "right" }}
                    >
                      {slotValue(frame.vars[name]!)}
                    </span>
                  </div>
                ))}
                {frame.returned !== undefined && (
                  <div
                    style={{
                      display: "flex",
                      gap: 8,
                      padding: "2px 8px",
                      alignItems: "center",
                      borderTop: `1px solid ${DEFAULTS.border}`,
                    }}
                  >
                    <span style={{ color: DEFAULTS.dimColor, fontStyle: "italic" }}>return</span>
                    <span
                      data-cell={`var:${slotKey(scope, "return")}`}
                      style={{ marginLeft: "auto", minWidth: 18, textAlign: "right" }}
                    >
                      {slotValue(frame.returned)}
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Heap */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 150 }}>
          <ColumnLabel text={heapLabel} />
          {entries.map((entry) => {
            const tone = toneOf(entry.id);
            const isTuple = entry.kind === "TUPLE";
            return (
              <div
                key={String(entry.id)}
                data-cell={`obj:${entry.id}`}
                {...(selectable(String(entry.id))
                  ? partHandlers(widgetId, "node", String(entry.id), bus, {
                      onSelect,
                      why: mergedWhy,
                      tabbable: entry.id === firstSelectable,
                    })
                  : {})}
                style={{
                  borderRadius: isTuple ? 12 : 6,
                  border: `2px solid ${tone.border}`,
                  background: tone.bg,
                  opacity: tone.opacity,
                  overflow: "hidden",
                  cursor: selectable(String(entry.id)) ? "pointer" : undefined,
                  transition: "border-color 0.25s ease, background 0.25s ease, opacity 0.25s ease",
                  outline: "none",
                }}
              >
                <div
                  style={{
                    padding: "1px 8px",
                    fontSize: "0.64rem",
                    letterSpacing: "0.06em",
                    color: DEFAULTS.dimColor,
                    borderBottom: entry.slots.length ? `1px solid ${DEFAULTS.border}` : undefined,
                  }}
                >
                  {entry.title ? `${entry.kind.toLowerCase()} ${entry.title}` : entry.kind.toLowerCase()}
                </div>
                {entry.slots.length === 0 && (
                  <div style={{ padding: "2px 8px", color: DEFAULTS.dimColor }}>(empty)</div>
                )}
                {/* A list lays its slots out in a row, which is what makes an
                    index visible; a dict or instance reads better as rows. */}
                <div
                  style={{
                    display: "flex",
                    flexDirection: entry.kind === "LIST" || entry.kind === "TUPLE" ? "row" : "column",
                  }}
                >
                  {entry.slots.map((slot, j) => (
                    <div
                      key={j}
                      style={{
                        display: "flex",
                        flexDirection: entry.kind === "LIST" || entry.kind === "TUPLE" ? "column" : "row",
                        gap: entry.kind === "LIST" || entry.kind === "TUPLE" ? 0 : 8,
                        alignItems: "center",
                        padding: "2px 8px",
                        borderRight:
                          (entry.kind === "LIST" || entry.kind === "TUPLE") && j < entry.slots.length - 1
                            ? `1px solid ${DEFAULTS.border}`
                            : undefined,
                        minWidth: 24,
                      }}
                    >
                      {slot.label != null && (
                        <span style={{ color: DEFAULTS.dimColor, fontSize: "0.62rem" }}>{slot.label}</span>
                      )}
                      <span data-cell={`slot:${entry.id}:${j}`}>
                        {inlinePrimitives || isRef(slot.value) ? (
                          slotValue(slot.value)
                        ) : (
                          <span style={{ color: DEFAULTS.text }}>{formatValue(slot.value)}</span>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        {shapes.length > 0 && (
          <CellOverlay shapes={shapes} width={box?.offsetWidth || 1} height={box?.offsetHeight || 1} />
        )}
      </div>
    </div>
  );
}

function ColumnLabel({ text }: { text: string }) {
  return (
    <div
      style={{
        fontSize: "0.62rem",
        fontWeight: 700,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: DEFAULTS.dimColor,
      }}
    >
      {text}
    </div>
  );
}
