/**
 * A tiny attribute schema, shaped after Markdoc's `SchemaAttribute`.
 *
 * Hand-rolled rather than zod on purpose. The same descriptions have to be
 * readable by the Go linter and by `kiwi_widget_reference` over MCP, so the
 * schema must serialise to plain JSON with no runtime behind it — and the UI
 * gains no dependency for 150 lines of checks.
 */

export type AttrType = "string" | "number" | "boolean" | "array" | "object" | "any";

export interface SchemaAttribute {
  type: AttrType | AttrType[];
  required?: boolean;
  /** Allowed literal values, or a regular-expression source for strings. */
  matches?: readonly (string | number | boolean)[] | { pattern: string };
  /** Element type for `array`. */
  items?: AttrType | AttrType[];
  description?: string;
  /** A step patch may not set this key (e.g. layout constants). Default true. */
  steppable?: boolean;
  /** Older spelling accepted on input and normalised away. */
  alias?: string;
}

export interface Schema {
  attributes: Record<string, SchemaAttribute>;
}

export interface ValidationIssue {
  /** Dotted path into the fence body, e.g. `steps[2].activeIndices`. */
  path: string;
  message: string;
  /** 1-based line within the fence body, when it could be located. */
  line?: number;
  severity: "error" | "warning";
}

/**
 * Keys every fence understands, whatever the widget. They are stripped from
 * the props before the view sees them.
 */
export const RESERVED_TOP_LEVEL = [
  "steps",
  "frames",
  "code",
  "lang",
  "props",
  "link",
  "caption",
  "title",
  "id",
  "clock",
  "width",
  "autoplay",
  "loop",
  "why",
] as const;

/** Keys a step may carry that are not widget props. */
export const RESERVED_STEP = [
  "note",
  "line",
  "next",
  "label",
  "breakpoint",
  "duration",
  "why",
  "expect",
] as const;

const RESERVED_TOP_SET = new Set<string>(RESERVED_TOP_LEVEL);
const RESERVED_STEP_SET = new Set<string>(RESERVED_STEP);

export function isReservedTopLevel(key: string): boolean {
  return RESERVED_TOP_SET.has(key);
}

export function isReservedStepKey(key: string): boolean {
  return RESERVED_STEP_SET.has(key);
}

// ── Type checking ───────────────────────────────────────────────────────────

function typeOf(value: unknown): AttrType {
  if (Array.isArray(value)) return "array";
  if (value === null) return "any";
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "object":
      return "object";
    default:
      return "any";
  }
}

function accepts(spec: AttrType | AttrType[], value: unknown): boolean {
  const want = Array.isArray(spec) ? spec : [spec];
  if (want.includes("any")) return true;
  if (value === null || value === undefined) return true;
  // Attributes that genuinely take a bare value in place of a list say so in
  // their own type union (see `many()`); coercing here instead would let
  // `columns: "a, b"` through on a key that only ever means a list.
  return want.includes(typeOf(value));
}

function matchFails(attr: SchemaAttribute, value: unknown): string | null {
  if (!attr.matches) return null;
  if (Array.isArray(attr.matches)) {
    if (attr.matches.includes(value as string)) return null;
    return `must be one of ${attr.matches.map((m) => JSON.stringify(m)).join(", ")}`;
  }
  const pattern = (attr.matches as { pattern: string }).pattern;
  if (typeof value !== "string") return null;
  try {
    if (new RegExp(pattern).test(value)) return null;
  } catch {
    return null;
  }
  return `must match /${pattern}/`;
}

// ── Did-you-mean ────────────────────────────────────────────────────────────

/** Damerau-free Levenshtein; good enough to catch `activeIndicies`. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0 || n === 0) return Math.max(m, n);
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const row = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + cost);
    }
    prev = row;
  }
  return prev[n]!;
}

export function didYouMean(key: string, candidates: Iterable<string>): string | undefined {
  const lower = key.toLowerCase();
  let best: string | undefined;
  let bestScore = Infinity;
  for (const c of candidates) {
    const d = editDistance(lower, c.toLowerCase());
    if (d < bestScore) {
      bestScore = d;
      best = c;
    }
  }
  // Two edits on a short key is already a different word.
  const budget = Math.max(1, Math.floor(key.length / 4));
  return best && bestScore <= budget ? best : undefined;
}

// ── Validation ──────────────────────────────────────────────────────────────

/** `values:` with nothing after it is YAML null, and draws nothing. */
export function isMissing(body: Record<string, unknown>, key: string): boolean {
  return body[key] == null;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((v, i) => deepEqual(v, bb[i]));
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  const rb = b as Record<string, unknown>;
  return ka.every((k) => k in rb && deepEqual((a as Record<string, unknown>)[k], rb[k]));
}

export interface ValidateOptions {
  /** `path` prefix for issues, e.g. `steps[1]`. */
  prefix?: string;
  /** Resolves a key to a line number in the fence body. */
  lineOf?: (key: string) => number | undefined;
  /** Step patches may not set keys marked `steppable: false`. */
  mode?: "base" | "step";
  /**
   * In step mode, the props the patch applies over. A fixed key restated
   * with the value it already has is not a change, and is not reported.
   */
  previous?: Record<string, unknown>;
  /**
   * Report missing required keys. Off when the caller checks them against the
   * first resolved step instead, which is where they actually have to hold.
   */
  requireAll?: boolean;
  /** Reserved keys to accept silently at this level. */
  reserved?: (key: string) => boolean;
}

export function validateAttributes(
  schema: Schema,
  body: Record<string, unknown>,
  opts: ValidateOptions = {},
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const prefix = opts.prefix ? `${opts.prefix}.` : "";
  const mode = opts.mode ?? "base";
  const reserved = opts.reserved ?? (() => false);
  const known = Object.keys(schema.attributes);

  const push = (key: string, message: string, severity: ValidationIssue["severity"] = "error") => {
    issues.push({ path: `${prefix}${key}`, message, line: opts.lineOf?.(key), severity });
  };

  for (const [key, value] of Object.entries(body)) {
    if (reserved(key)) continue;
    const attr = schema.attributes[key];
    if (!attr) {
      const hint = didYouMean(key, known);
      push(key, `unknown key "${key}"${hint ? ` — did you mean "${hint}"?` : ""}`, "warning");
      continue;
    }
    if (
      mode === "step" &&
      attr.steppable === false &&
      !(opts.previous && deepEqual(opts.previous[key], value))
    ) {
      push(key, `"${key}" cannot change between steps`);
      continue;
    }
    if (!accepts(attr.type, value)) {
      const want = Array.isArray(attr.type) ? attr.type.join(" or ") : attr.type;
      push(key, `"${key}" must be ${want}, got ${typeOf(value)}`);
      continue;
    }
    const mismatch = matchFails(attr, value);
    if (mismatch) {
      push(key, `"${key}" ${mismatch}`);
      continue;
    }
    if (attr.items && Array.isArray(value)) {
      const bad = value.findIndex((v) => !accepts(attr.items!, v));
      if (bad >= 0) {
        const want = Array.isArray(attr.items) ? attr.items.join(" or ") : attr.items;
        push(key, `"${key}[${bad}]" must be ${want}, got ${typeOf(value[bad])}`);
      }
    }
  }

  if (mode === "base" && opts.requireAll !== false) {
    for (const [key, attr] of Object.entries(schema.attributes)) {
      if (attr.required && isMissing(body, key)) {
        issues.push({ path: `${prefix}${key}`, message: `missing required key "${key}"`, severity: "error" });
      }
    }
  }

  return issues;
}

/** Apply `default` and `alias` so the view sees one spelling. */
export function applyDefaults(schema: Schema, body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  for (const [key, attr] of Object.entries(schema.attributes)) {
    if (attr.alias && out[attr.alias] !== undefined && out[key] === undefined) {
      out[key] = out[attr.alias];
      delete out[attr.alias];
    }
  }
  return out;
}

// ── Serialisation (the single source of truth for Go and MCP) ──────────────

export interface SerializedAttribute {
  type: string;
  required?: boolean;
  items?: string;
  matches?: (string | number | boolean)[];
  pattern?: string;
  description?: string;
  steppable?: boolean;
}

export function serializeSchema(schema: Schema): Record<string, SerializedAttribute> {
  const out: Record<string, SerializedAttribute> = {};
  for (const [key, attr] of Object.entries(schema.attributes)) {
    const entry: SerializedAttribute = {
      type: Array.isArray(attr.type) ? attr.type.join("|") : attr.type,
    };
    if (attr.required) entry.required = true;
    if (attr.items) entry.items = Array.isArray(attr.items) ? attr.items.join("|") : attr.items;
    if (Array.isArray(attr.matches)) entry.matches = [...attr.matches];
    else if (attr.matches) entry.pattern = (attr.matches as { pattern: string }).pattern;
    if (attr.description) entry.description = attr.description;
    if (attr.steppable === false) entry.steppable = false;
    out[key] = entry;
  }
  return out;
}
