/**
 * The inspect bus: "why is this cell 7?"
 *
 * Every canvas can report what the reader pointed at as an `InspectRef`, and
 * read back what is selected. The answer itself is author-supplied text in a
 * `why` map — deterministic, diffable, and in the file. Asking a model at read
 * time is explicitly not what this is.
 *
 * The bus also carries correspondence: a `link` maps one widget's keys onto
 * another's, so hovering index 3 of an array lights node 3 of the heap tree
 * drawn beside it. That one mechanism is what makes a separate HeapView,
 * UnionFindView and MappingView unnecessary.
 */

import { createContext, useCallback, useContext, useMemo, useState } from "react";

export type InspectKind =
  | "cell"
  | "node"
  | "edge"
  | "bit"
  | "row"
  | "col"
  | "slot"
  | "interval"
  | "point"
  | "series";

export interface InspectRef {
  /** Which widget on the page, usually the fence `id` or a panel key. */
  widget: string;
  kind: InspectKind;
  /** `cellKey()` for matrix cells, the index for arrays, the id for nodes. */
  key: string;
}

export function refEquals(a: InspectRef | null, b: InspectRef | null): boolean {
  if (!a || !b) return a === b;
  return a.widget === b.widget && a.kind === b.kind && a.key === b.key;
}

/**
 * How one widget's keys correspond to another's.
 *
 * `map: "index"` is the identity — array index 3 ↔ tree node `3`, which is how
 * heaps, union-find forests and parent arrays line up. An explicit object
 * handles the rest.
 */
export interface InspectLink {
  /** Widget (or panel key) the keys translate into. */
  to: string;
  map?: "index" | Record<string, string>;
}

export interface InspectState {
  selected: InspectRef | null;
  hovered: InspectRef | null;
  select: (ref: InspectRef | null) => void;
  hover: (ref: InspectRef | null) => void;
  /** Explanations, keyed as `"<kind>:<key>"` or bare `"<key>"`. */
  why: Record<string, string>;
  /** Keys in `widget` that correspond to what is currently selected/hovered. */
  linkedKeys: (widget: string) => Set<string>;
  links: InspectLink[];
}

const NOOP: InspectState = {
  selected: null,
  hovered: null,
  select: () => {},
  hover: () => {},
  why: {},
  linkedKeys: () => new Set(),
  links: [],
};

export const InspectContext = createContext<InspectState>(NOOP);

export function useInspect(): InspectState {
  return useContext(InspectContext);
}

/** The `why` entry for a ref, tried most specific first. */
export function whyFor(why: Record<string, string>, ref: InspectRef | null): string | undefined {
  if (!ref) return undefined;
  return why[`${ref.kind}:${ref.key}`] ?? why[ref.key];
}

function translate(link: InspectLink, key: string): string | null {
  if (!link.map || link.map === "index") return key;
  return link.map[key] ?? null;
}

/** Normalise the `link:` value an author wrote into a list. */
export function parseLinks(raw: unknown): InspectLink[] {
  if (!raw) return [];
  if (typeof raw === "string") return [{ to: raw, map: "index" }];
  if (Array.isArray(raw)) return raw.flatMap(parseLinks);
  const rec = raw as Record<string, unknown>;
  if (typeof rec.to !== "string") return [];
  const map = rec.map;
  if (map === "index" || map == null) return [{ to: rec.to, map: "index" }];
  if (typeof map === "object") {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(map as Record<string, unknown>)) out[k] = String(v);
    return [{ to: rec.to, map: out }];
  }
  return [{ to: rec.to, map: "index" }];
}

export interface InspectProviderOptions {
  why?: Record<string, string>;
  links?: InspectLink[];
  onSelect?: (ref: InspectRef | null) => void;
}

/**
 * The state a `TypedFence` (or a `widget:live` block) hands its canvases.
 * Returned rather than rendered so the caller owns the provider element.
 */
export function useInspectState(opts: InspectProviderOptions = {}): InspectState {
  const [selected, setSelected] = useState<InspectRef | null>(null);
  const [hovered, setHovered] = useState<InspectRef | null>(null);
  const why = opts.why ?? {};
  const links = opts.links ?? [];
  const onSelect = opts.onSelect;

  const select = useCallback(
    (ref: InspectRef | null) => {
      setSelected((prev) => (refEquals(prev, ref) ? null : ref));
      onSelect?.(ref);
    },
    [onSelect],
  );

  const linkedKeys = useCallback(
    (widget: string) => {
      const out = new Set<string>();
      const source = hovered ?? selected;
      if (!source) return out;
      if (source.widget === widget) {
        out.add(source.key);
        return out;
      }
      for (const link of links) {
        if (link.to !== widget) continue;
        const key = translate(link, source.key);
        if (key != null) out.add(key);
      }
      return out;
    },
    [hovered, selected, links],
  );

  return useMemo(
    () => ({ selected, hovered, select, hover: setHovered, why, linkedKeys, links }),
    [selected, hovered, select, why, linkedKeys, links],
  );
}

// ── Canvas-side helpers ─────────────────────────────────────────────────────

/** Props every canvas that can be inspected accepts. */
export interface InspectableProps {
  /** Reported when the reader clicks or presses Enter on a part. */
  onSelect?: (ref: InspectRef) => void;
  /** Controlled selection, as keys. */
  selected?: Iterable<string> | string | null;
  /** Key → explanation. Selecting a part with an entry reveals it. */
  why?: Record<string, string>;
  /**
   * On hover, light the parts the hovered one reads from: incoming `arrows`,
   * the parent edge, incoming graph edges, earlier `links` on a timeline.
   * Uses data the author already passed.
   */
  hoverPredecessors?: boolean;
}

export interface PartOptions {
  /** Called in addition to the bus, for an author-supplied callback. */
  onSelect?: (ref: InspectRef) => void;
  /**
   * The canvas's resolved explanations (its own `why` merged over the bus's).
   * A part with an entry here is selectable even with no `onSelect`.
   */
  why?: Record<string, string>;
  /**
   * Roving tabindex (APG grid pattern): exactly one part of a canvas is in the
   * tab order, and the arrows move focus within it. Making every cell tabbable
   * instead would put forty stops between the reader and the next paragraph.
   */
  tabbable?: boolean;
}

/**
 * DOM props that make one part of a canvas selectable and hoverable.
 * Callers spread this onto the cell / node element.
 */
export function partHandlers(
  widget: string,
  kind: InspectKind,
  key: string,
  bus: InspectState,
  opts: PartOptions = {},
): Record<string, unknown> {
  const ref: InspectRef = { widget, kind, key };
  const { onSelect, tabbable = true } = opts;
  const why = opts.why ?? bus.why;
  const describable = whyFor(why, ref) !== undefined || onSelect !== undefined;
  return {
    role: "graphics-symbol",
    tabIndex: describable && tabbable ? 0 : -1,
    "aria-selected": refEquals(bus.selected, ref) || undefined,
    onClick: (e: { stopPropagation: () => void }) => {
      e.stopPropagation();
      bus.select(ref);
      onSelect?.(ref);
    },
    onMouseEnter: () => bus.hover(ref),
    onMouseLeave: () => bus.hover(null),
    onFocus: () => bus.hover(ref),
    onBlur: () => bus.hover(null),
    onKeyDown: (e: {
      key: string;
      currentTarget: unknown;
      preventDefault: () => void;
      stopPropagation: () => void;
    }) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        bus.select(ref);
        onSelect?.(ref);
        return;
      }
      if (e.key === "Escape") {
        bus.select(null);
        return;
      }
      // Roving focus across the canvas's parts. The playback hook stands down
      // while a part is focused, so these arrows move the cursor, not the clock.
      const moved = moveFocus(e.currentTarget as Element | null, e.key);
      if (moved) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
  };
}

const PART_SELECTOR = '[role="graphics-symbol"]';

/**
 * Move focus to the next, previous, first or last part of the same canvas.
 * Returns false for a key it does not handle, so the event keeps bubbling.
 */
export function moveFocus(from: Element | null, key: string): boolean {
  if (!from || typeof from.closest !== "function") return false;
  const root = from.closest(".kiwi-widget") ?? from.ownerDocument?.body;
  if (!root) return false;
  const parts = [...root.querySelectorAll<HTMLElement>(PART_SELECTOR)].filter(
    (el) => el.tabIndex >= 0,
  );
  const here = parts.indexOf(from as HTMLElement);
  if (here < 0 || parts.length === 0) return false;
  let next: number;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      next = Math.min(here + 1, parts.length - 1);
      break;
    case "ArrowLeft":
    case "ArrowUp":
      next = Math.max(here - 1, 0);
      break;
    case "Home":
      next = 0;
      break;
    case "End":
      next = parts.length - 1;
      break;
    default:
      return false;
  }
  if (next === here) return true;
  parts[next]!.focus();
  return true;
}

/** Normalise a controlled `selected` prop. */
export function toKeySet(value: Iterable<string> | string | null | undefined): Set<string> {
  if (value == null) return new Set();
  if (typeof value === "string") return new Set([value]);
  return new Set(value);
}
