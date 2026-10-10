import { alpha } from "./colors";
import { toSet, type Many } from "./sets";
import { WidgetText } from "./WidgetText";
import { canvasAria, sentence } from "./widgetA11y";
import { partHandlers, useInspect, whyFor, type InspectRef } from "./inspect";

/**
 * FIFO: BFS frontiers, work queues, sliding windows, ring buffers.
 *
 * A separate widget rather than a `mode` on StackView, because the two differ
 * in exactly the thing the reader is watching. A stack has one open end and
 * grows; a queue has two ends and a wrap-around, and `front`/`back` crossing
 * the end of the buffer *is* the lesson in a ring. StackView stays LIFO.
 */

export interface QueuePointer {
  index: number;
  label: string;
  color?: string;
}

export interface QueueViewProps {
  /**
   * Slot contents. In `ring` layout this is the whole buffer, including empty
   * slots as `null`; in `horizontal` it is the items in order.
   */
  values: (string | number | null)[];
  /** Index of the head. Defaults to 0. */
  front?: number;
  /** Index one past the tail — where the next enqueue lands. */
  back?: number;
  /** Buffer size. Defaults to `values.length`. Ring layout uses it as the circumference. */
  capacity?: number;
  /** `"horizontal"` (default) for a plain queue, `"ring"` for a circular buffer. */
  layout?: "horizontal" | "ring";
  /** How many slots currently hold data. Needed to tell a full ring from an empty one. */
  size?: number;
  activeIndices?: Many<number>;
  highlightIndices?: Many<number>;
  dimIndices?: Many<number>;
  /** Named markers beside slots, beyond `front` and `back`. */
  pointers?: QueuePointer[];
  /** Show slot indices. Default true. */
  showIndices?: boolean;
  /** Label on the head end. Default "front". */
  frontLabel?: string;
  /** Label on the tail end. Default "back". */
  backLabel?: string;
  title?: string;
  empty?: string;
  slotSize?: number;
  /** Ring radius in px. Default 86. */
  radius?: number;
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
  slotSize: 44,
  radius: 86,
};

function summarize(opts: {
  values: (string | number | null)[];
  front?: number;
  back?: number;
  layout: string;
  size?: number;
}): string {
  const filled = opts.values.filter((v) => v != null);
  return sentence(
    `${opts.layout === "ring" ? "circular " : ""}queue of ${opts.values.length} slots`,
    filled.length ? `holding ${filled.join(", ")}` : "empty",
    opts.front != null ? `front at ${opts.front}` : "",
    opts.back != null ? `back at ${opts.back}` : "",
  );
}

export function QueueView({
  values,
  front,
  back,
  capacity,
  layout = "horizontal",
  size,
  activeIndices,
  highlightIndices,
  dimIndices,
  pointers = [],
  showIndices = true,
  frontLabel = "front",
  backLabel = "back",
  title,
  empty = "(empty)",
  slotSize = DEFAULTS.slotSize,
  radius = DEFAULTS.radius,
  onSelect,
  why,
  widgetId = "queue",
  activeColor = DEFAULTS.activeColor,
  highlightColor = DEFAULTS.highlightColor,
  ariaLabel,
}: QueueViewProps) {
  const bus = useInspect();
  const mergedWhy = { ...bus.why, ...(why ?? {}) };
  const linked = bus.linkedKeys(widgetId);
  const n = capacity ?? values.length;
  const slots = Array.from({ length: Math.max(1, n) }, (_, i) => values[i] ?? null);
  const active = toSet(activeIndices);
  const highlight = toSet(highlightIndices);
  const dim = toSet(dimIndices);
  const selectable = (i: number) =>
    onSelect !== undefined ||
    whyFor(mergedWhy, { widget: widgetId, kind: "slot", key: String(i) }) !== undefined;
  const firstSelectable = slots.findIndex((_, i) => selectable(i));

  const markers = new Map<number, QueuePointer[]>();
  const addMarker = (index: number | undefined, label: string) => {
    if (index == null) return;
    const slot = ((index % slots.length) + slots.length) % slots.length;
    const list = markers.get(slot) ?? [];
    list.push({ index: slot, label });
    markers.set(slot, list);
  };
  addMarker(front, frontLabel);
  addMarker(back, backLabel);
  for (const p of pointers) {
    const list = markers.get(p.index) ?? [];
    list.push(p);
    markers.set(p.index, list);
  }

  const styleFor = (i: number) => {
    const filled = slots[i] != null;
    if (active.has(i)) {
      return { bg: activeColor, border: activeColor, color: "var(--kw-widget-active-foreground, #111827)", opacity: 1 };
    }
    if (highlight.has(i) || linked.has(String(i))) {
      return { bg: alpha(highlightColor, 18), border: highlightColor, color: DEFAULTS.text, opacity: 1 };
    }
    if (dim.has(i)) {
      return { bg: "transparent", border: DEFAULTS.dimColor, color: DEFAULTS.dimColor, opacity: 0.5 };
    }
    return {
      bg: filled ? alpha(DEFAULTS.border, 35) : "transparent",
      border: DEFAULTS.border,
      color: filled ? DEFAULTS.text : DEFAULTS.dimColor,
      opacity: 1,
    };
  };

  const label = ariaLabel ?? summarize({ values: slots, front, back, layout, size });
  const aria = canvasAria(label, selectable(0) || firstSelectable >= 0);

  const slotContent = (i: number) => {
    const v = slots[i];
    return v == null ? "·" : String(v);
  };

  if (layout === "ring") {
    // A ring makes the wrap-around visible, which is the one thing a
    // horizontal row of a circular buffer cannot show.
    const box = (radius + slotSize) * 2 + 24;
    const centre = box / 2;
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "0.5rem 0" }}>
        {title && <Title text={title} />}
        <svg width={box} height={box} {...aria} style={{ display: "block", maxWidth: "100%" }}>
          <circle cx={centre} cy={centre} r={radius} fill="none" stroke={DEFAULTS.border} strokeWidth={1} opacity={0.4} />
          {slots.map((_, i) => {
            const angle = (i / slots.length) * Math.PI * 2 - Math.PI / 2;
            const cx = centre + Math.cos(angle) * radius;
            const cy = centre + Math.sin(angle) * radius;
            const st = styleFor(i);
            const marks = markers.get(i);
            const half = slotSize / 2;
            return (
              <g
                key={i}
                {...(selectable(i)
                  ? partHandlers(widgetId, "slot", String(i), bus, {
                      onSelect,
                      why: mergedWhy,
                      tabbable: i === firstSelectable,
                    })
                  : {})}
                opacity={st.opacity}
                style={{ cursor: selectable(i) ? "pointer" : undefined }}
              >
                <rect
                  x={cx - half}
                  y={cy - half}
                  width={slotSize}
                  height={slotSize}
                  rx={6}
                  fill={st.bg === "transparent" ? DEFAULTS.surface : st.bg}
                  stroke={st.border}
                  strokeWidth={2}
                />
                <text
                  x={cx}
                  y={cy}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fill={st.color}
                  fontSize={13}
                  fontWeight={700}
                  fontFamily="ui-monospace, SFMono-Regular, monospace"
                >
                  {slotContent(i)}
                </text>
                {showIndices && (
                  <text
                    x={centre + Math.cos(angle) * (radius - slotSize * 0.85)}
                    y={centre + Math.sin(angle) * (radius - slotSize * 0.85)}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fill={DEFAULTS.dimColor}
                    fontSize={9}
                    fontFamily="ui-monospace, SFMono-Regular, monospace"
                  >
                    {i}
                  </text>
                )}
                {marks?.map((m, j) => (
                  <text
                    key={j}
                    x={centre + Math.cos(angle) * (radius + slotSize * 0.9 + j * 12)}
                    y={centre + Math.sin(angle) * (radius + slotSize * 0.9 + j * 12)}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fill={m.color ?? activeColor}
                    fontSize={10}
                    fontWeight={700}
                    fontFamily="ui-monospace, SFMono-Regular, monospace"
                  >
                    {m.label}
                  </text>
                ))}
              </g>
            );
          })}
        </svg>
      </div>
    );
  }

  const isEmpty = slots.every((v) => v == null);
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "0.5rem 0" }}>
      {title && <Title text={title} />}
      <div {...aria} style={{ display: "flex", alignItems: "flex-start", gap: 2, overflowX: "auto", maxWidth: "100%" }}>
        {isEmpty && (
          <span style={{ color: DEFAULTS.dimColor, fontSize: "0.7rem", padding: "12px 8px" }}>{empty}</span>
        )}
        {slots.map((_, i) => {
          const st = styleFor(i);
          const marks = markers.get(i);
          return (
            <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
              <div style={{ height: 14, fontSize: "0.65rem", fontWeight: 700, whiteSpace: "nowrap", display: "flex", gap: 3 }}>
                {marks?.map((m, j) => (
                  <span key={j} style={{ color: m.color ?? activeColor }}>
                    <WidgetText text={m.label} />
                  </span>
                ))}
              </div>
              <div
                {...(selectable(i)
                  ? partHandlers(widgetId, "slot", String(i), bus, {
                      onSelect,
                      why: mergedWhy,
                      tabbable: i === firstSelectable,
                    })
                  : {})}
                style={{
                  width: slotSize,
                  height: slotSize,
                  borderRadius: 6,
                  border: `2px solid ${st.border}`,
                  background: st.bg,
                  color: st.color,
                  opacity: st.opacity,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontWeight: 700,
                  fontSize: "0.8rem",
                  fontVariantNumeric: "tabular-nums",
                  fontFamily: "ui-monospace, SFMono-Regular, monospace",
                  cursor: selectable(i) ? "pointer" : undefined,
                  transition: "all 0.2s ease",
                  outline: "none",
                }}
              >
                <WidgetText text={slotContent(i)} />
              </div>
              {showIndices && (
                <span style={{ fontSize: "0.6rem", color: DEFAULTS.dimColor, fontVariantNumeric: "tabular-nums" }}>
                  {i}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Title({ text }: { text: string }) {
  return (
    <div
      style={{
        fontSize: "0.7rem",
        fontWeight: 700,
        color: DEFAULTS.dimColor,
        letterSpacing: "0.04em",
        marginBottom: 4,
      }}
    >
      <WidgetText text={text} />
    </div>
  );
}
