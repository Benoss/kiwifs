import { alpha } from "./colors";
import { toSet, type Many } from "./sets";
import { WidgetText } from "./WidgetText";
import { summarizeMap } from "./widgetA11y";
import { partHandlers, useInspect, whyFor } from "./inspect";

/**
 * Slots, chains and probe paths: hash tables, caches, symbol tables, routing
 * tables, and the unordered `{key: value}` panel that two-sum walkthroughs
 * have been drawing out of ad-hoc chips.
 *
 * Three modes, because the three pictures differ in what the reader must see:
 *   chain — buckets of entries (separate chaining)
 *   open  — one entry per slot, with `DEL` tombstones and a probe path
 *   map   — an unordered dictionary, no slots at all
 *
 * Probe conventions (`DEL`, the load factor readout, the arrow path) follow
 * VisuAlgo, so a reader who learned there recognises this.
 */

export interface MapEntry {
  key: string | number;
  value?: string | number | null;
}

export type MapSlot = null | "DEL" | MapEntry | MapEntry[];

export interface MapViewProps {
  /** Default "chain" when `slots` is given, "map" when `entries` is. */
  mode?: "chain" | "open" | "map";
  /** Slot count. Defaults to `slots.length`. */
  capacity?: number;
  /** One entry per slot, a list for a chain, `null` for empty, `"DEL"` for a tombstone. */
  slots?: MapSlot[];
  /** Unordered dictionary form — what a frequency map or seen-set actually is. */
  entries?: MapEntry[];
  /** Shows an `h(k)=i` badge beside the key. */
  hashOf?: Record<string, number>;
  highlightSlots?: Many<number>;
  activeSlots?: Many<number>;
  dimSlots?: Many<number>;
  /** The key being inserted or looked up this step. */
  activeKey?: string | number;
  /** Slots visited in order, drawn as arrows between them. */
  probePath?: number[];
  /** Slot indices holding a tombstone, if not already `"DEL"` in `slots`. */
  tombstones?: Many<number>;
  /** Show α = n/m. Default true when slots are given. */
  showLoadFactor?: boolean;
  /** Index captions under the slots. Default true. */
  showIndices?: boolean;
  /** Widget id for the inspect bus. */
  widgetId?: string;
  why?: Record<string, string>;
  slotWidth?: number;
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
  tombstone: "var(--kw-widget-accent-rose, #f43f5e)",
  slotWidth: 54,
};

function isEntry(v: MapSlot): v is MapEntry {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function entriesOf(slot: MapSlot): MapEntry[] {
  if (slot == null || slot === "DEL") return [];
  if (Array.isArray(slot)) return slot;
  return [slot];
}

function entryText(e: MapEntry): string {
  return e.value == null || e.value === "" ? String(e.key) : `${e.key}: ${e.value}`;
}

export function MapView({
  mode,
  capacity,
  slots,
  entries,
  hashOf,
  highlightSlots,
  activeSlots,
  dimSlots,
  activeKey,
  probePath,
  tombstones,
  showLoadFactor,
  showIndices = true,
  widgetId = "map",
  why,
  slotWidth = DEFAULTS.slotWidth,
  activeColor = DEFAULTS.activeColor,
  highlightColor = DEFAULTS.highlightColor,
  ariaLabel,
}: MapViewProps) {
  const bus = useInspect();
  const resolved = mode ?? (slots ? "chain" : "map");
  const mergedWhy = { ...bus.why, ...(why ?? {}) };
  const linked = bus.linkedKeys(widgetId);

  if (resolved === "map" || (!slots && entries)) {
    const list = entries ?? [];
    return (
      <div
        role="img"
        aria-label={ariaLabel ?? summarizeMap({ mode: "map", entries: list })}
        style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "0.5rem 0", justifyContent: "center" }}
      >
        {list.length === 0 && (
          <span style={{ color: DEFAULTS.dimColor, fontSize: "0.8rem" }}>(empty map)</span>
        )}
        {list.map((e, i) => {
          const key = String(e.key);
          const active = activeKey != null && String(activeKey) === key;
          const lit = linked.has(key);
          const hasWhy = whyFor(mergedWhy, { widget: widgetId, kind: "slot", key }) !== undefined;
          return (
            <span
              key={`${key}-${i}`}
              {...(hasWhy ? partHandlers(widgetId, "slot", key, bus) : {})}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                padding: "3px 9px",
                borderRadius: 999,
                fontSize: "0.75rem",
                fontFamily: "ui-monospace, SFMono-Regular, monospace",
                border: `1.5px solid ${active ? activeColor : lit ? highlightColor : DEFAULTS.border}`,
                background: active ? activeColor : lit ? alpha(highlightColor, 18) : "transparent",
                color: active ? "var(--kw-widget-active-foreground, #111827)" : DEFAULTS.text,
                cursor: hasWhy ? "pointer" : undefined,
                transition: "background 0.25s ease, border-color 0.25s ease",
              }}
            >
              <WidgetText text={entryText(e)} />
              {hashOf?.[key] != null && (
                <span style={{ fontSize: "0.62rem", color: DEFAULTS.dimColor }}>
                  h={hashOf[key]}
                </span>
              )}
            </span>
          );
        })}
      </div>
    );
  }

  const list = slots ?? [];
  const m = capacity ?? list.length;
  const cells: MapSlot[] = Array.from({ length: m }, (_, i) => list[i] ?? null);
  const tombSet = toSet(tombstones);
  const activeSet = toSet(activeSlots);
  const highlightSet = toSet(highlightSlots);
  const dimSet = toSet(dimSlots);
  const probeOrder = new Map<number, number>();
  (probePath ?? []).forEach((slot, i) => {
    if (!probeOrder.has(slot)) probeOrder.set(slot, i + 1);
  });

  const occupied = cells.filter((c, i) => entriesOf(c).length > 0 && !tombSet.has(i)).length;
  const load = m > 0 ? occupied / m : 0;
  const showLoad = showLoadFactor ?? true;
  const maxChain = Math.max(1, ...cells.map((c) => entriesOf(c).length));

  return (
    <div
      role="img"
      aria-label={ariaLabel ?? summarizeMap({ mode: resolved, capacity: m, slots: cells })}
      style={{ padding: "0.5rem 0", overflowX: "auto" }}
    >
      <div style={{ display: "flex", gap: 2, width: "max-content", margin: "0 auto", alignItems: "flex-start" }}>
        {cells.map((slot, i) => {
          const isTomb = slot === "DEL" || tombSet.has(i);
          const items = entriesOf(slot);
          const active = activeSet.has(i);
          const lit = highlightSet.has(i) || items.some((e) => linked.has(String(e.key)));
          const dim = dimSet.has(i);
          const probe = probeOrder.get(i);
          const hasWhy = whyFor(mergedWhy, { widget: widgetId, kind: "slot", key: String(i) }) !== undefined;
          const border = active ? activeColor : lit ? highlightColor : isTomb ? DEFAULTS.tombstone : DEFAULTS.border;
          return (
            <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
              {probe != null && (
                <span
                  title={`probe ${probe}`}
                  style={{
                    fontSize: "0.6rem",
                    fontWeight: 700,
                    color: activeColor,
                    fontFamily: "ui-monospace, SFMono-Regular, monospace",
                  }}
                >
                  {probe}↓
                </span>
              )}
              <div
                {...(hasWhy ? partHandlers(widgetId, "slot", String(i), bus) : {})}
                style={{
                  width: slotWidth,
                  minHeight: 30,
                  display: "flex",
                  flexDirection: "column",
                  gap: 1,
                  padding: 2,
                  borderRadius: 4,
                  border: `1.5px solid ${border}`,
                  background: active
                    ? alpha(activeColor, 22)
                    : lit
                      ? alpha(highlightColor, 16)
                      : DEFAULTS.surface,
                  opacity: dim ? 0.45 : 1,
                  cursor: hasWhy ? "pointer" : undefined,
                  transition: "background 0.25s ease, border-color 0.25s ease, opacity 0.25s ease",
                }}
              >
                {isTomb && items.length === 0 && (
                  <span
                    style={{
                      fontSize: "0.62rem",
                      fontWeight: 700,
                      color: DEFAULTS.tombstone,
                      textAlign: "center",
                      fontFamily: "ui-monospace, SFMono-Regular, monospace",
                    }}
                  >
                    DEL
                  </span>
                )}
                {items.length === 0 && !isTomb && (
                  <span style={{ fontSize: "0.68rem", color: DEFAULTS.dimColor, textAlign: "center" }}>·</span>
                )}
                {items.map((e, j) => {
                  const key = String(e.key);
                  const isActiveKey = activeKey != null && String(activeKey) === key;
                  return (
                    <span
                      key={`${key}-${j}`}
                      style={{
                        fontSize: "0.66rem",
                        fontFamily: "ui-monospace, SFMono-Regular, monospace",
                        textAlign: "center",
                        padding: "1px 2px",
                        borderRadius: 3,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        background: isActiveKey ? activeColor : alpha(DEFAULTS.border, 45),
                        color: isActiveKey ? "var(--kw-widget-active-foreground, #111827)" : DEFAULTS.text,
                      }}
                      title={entryText(e)}
                    >
                      {entryText(e)}
                    </span>
                  );
                })}
                {/* Reserve the tallest chain's height so the row does not jump
                    as entries move between buckets. */}
                {resolved === "chain" && items.length < maxChain && (
                  <span aria-hidden style={{ height: (maxChain - items.length) * 15 }} />
                )}
              </div>
              {showIndices && (
                <span
                  style={{
                    fontSize: "0.6rem",
                    color: DEFAULTS.dimColor,
                    fontFamily: "ui-monospace, SFMono-Regular, monospace",
                  }}
                >
                  {i}
                </span>
              )}
            </div>
          );
        })}
      </div>
      {showLoad && (
        <div
          style={{
            textAlign: "center",
            marginTop: 6,
            fontSize: "0.7rem",
            color: DEFAULTS.dimColor,
            fontFamily: "ui-monospace, SFMono-Regular, monospace",
          }}
        >
          α = {occupied}/{m} = {load.toFixed(2)}
          {isFinite(load) && load > 0.75 && <span style={{ color: DEFAULTS.tombstone }}> · resize soon</span>}
        </div>
      )}
    </div>
  );
}

export { isEntry as isMapEntry };
