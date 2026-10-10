/**
 * Page-scoped variables, set by a scrubbable number in prose.
 *
 * The Tangle / Idyll idea: a sentence with a number the reader can drag, and
 * everything downstream — another sentence, a chart, a fence — follows. Same
 * shape as `widgets/playbackClock.ts`: a tiny external store rather than a
 * context, so a number in a paragraph and a widget three sections down can
 * share a value without a common React ancestor.
 */

type Listener = () => void;

const values = new Map<string, number | string | boolean>();
const listeners = new Set<Listener>();
/** Cached so `useSyncExternalStore` sees a stable snapshot between changes. */
let snapshot: Readonly<Record<string, number | string | boolean>> = {};

function refresh() {
  snapshot = Object.fromEntries(values);
  for (const fn of listeners) fn();
}

export function subscribePageVars(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function pageVars(): Readonly<Record<string, number | string | boolean>> {
  return snapshot;
}

export function getPageVar(name: string): number | string | boolean | undefined {
  return values.get(name);
}

export function setPageVar(name: string, value: number | string | boolean) {
  if (values.get(name) === value) return;
  values.set(name, value);
  refresh();
}

/**
 * Declare a default without overwriting what the reader has already set.
 * A control re-rendering must not snap its own value back.
 */
export function initPageVar(name: string, value: number | string | boolean) {
  if (values.has(name)) return;
  values.set(name, value);
  refresh();
}

/** Only the numeric variables, which is what an expression can use. */
export function numericPageVars(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of values) {
    if (typeof value === "number") out[key] = value;
    else if (typeof value === "boolean") out[key] = value ? 1 : 0;
  }
  return out;
}

/** Test seam, and what a page navigation calls. */
export function resetPageVars() {
  values.clear();
  refresh();
}

// ── Substitution into fence bodies ──────────────────────────────────────────

const PLACEHOLDER = /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g;

/**
 * Replace `$name` in a fence body with the current value.
 *
 * Done on the YAML text rather than on the parsed tree so a placeholder can
 * stand where a number does — `values: [1, $n, 3]` — which is where authors
 * will reach for it. A name with no value is left alone, so the YAML still
 * parses and the error names the right thing.
 */
export function substitutePageVars(
  source: string,
  vars: Readonly<Record<string, number | string | boolean>> = snapshot,
): string {
  if (!source.includes("$")) return source;
  return source.replace(PLACEHOLDER, (match, name: string) => {
    const value = Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : undefined;
    if (value === undefined) return match;
    return typeof value === "string" ? JSON.stringify(value) : String(value);
  });
}

/** Names a fence body refers to, so a caller can tell whether to re-parse. */
export function referencedVars(source: string): string[] {
  const out = new Set<string>();
  for (const match of source.matchAll(PLACEHOLDER)) out.add(match[1]!);
  return [...out];
}
