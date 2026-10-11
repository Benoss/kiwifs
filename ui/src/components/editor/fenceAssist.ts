/**
 * Key completion and inline errors for a widget fence body.
 *
 * The same schema the Go linter embeds, offered while the author types. Having
 * the editor accept a key the linter rejects is the one failure mode a
 * generated schema is supposed to make impossible, so both sides read the
 * registry rather than a hand-kept list.
 */

import type { Completion, CompletionContext, CompletionResult, CompletionSource } from "@codemirror/autocomplete";
import { linter } from "@codemirror/lint";
import type { EditorState, Extension } from "@codemirror/state";
import { getFence, parseFence, type FenceSpec } from "@kw/fences";
import { RESERVED_STEP, RESERVED_TOP_LEVEL, type SchemaAttribute } from "@kw/fences/schema";

export interface FenceContext {
  spec: FenceSpec;
  lang: string;
  /** Document offsets of the fence body, excluding the delimiter lines. */
  from: number;
  to: number;
  /** The cursor is inside a `steps:` / `frames:` entry. */
  inStep: boolean;
}

const OPEN = /^(`{3,}|~{3,})\s*([A-Za-z0-9_:.-]*)/;

/**
 * How far from the caret to look for a fence's delimiters. This runs on every
 * keystroke and caret move, so a long page of prose with no fence above the
 * caret must not cost a scan to line 1; a widget body is never this long.
 */
export const MAX_FENCE_LINES = 1000;

/**
 * The widget fence the cursor is in, by scanning back for an unclosed opening
 * fence. Cheap, and immune to the markdown parser's view of a half-typed
 * document — which is exactly the state an author is in while typing.
 */
export function fenceAtCursor(state: EditorState, pos: number): FenceContext | null {
  const cursorLine = state.doc.lineAt(pos);
  let opening: { marker: string; lang: string; line: number } | null = null;

  const scanFloor = Math.max(1, cursorLine.number - MAX_FENCE_LINES);
  for (let n = cursorLine.number - 1; n >= scanFloor; n--) {
    const text = state.doc.line(n).text;
    const match = OPEN.exec(text.trim());
    if (!match) continue;
    const marker = match[1]!;
    const lang = match[2] ?? "";
    // A bare fence marker closes whatever was open; a tagged one opens.
    if (lang === "") {
      if (opening === null) return null;
      break;
    }
    opening = { marker, lang, line: n };
    break;
  }
  if (!opening) return null;

  const spec = getFence(opening.lang);
  if (!spec) return null;

  const bodyStart = state.doc.line(opening.line + 1 > state.doc.lines ? state.doc.lines : opening.line + 1).from;
  const scanCeiling = Math.min(state.doc.lines, opening.line + MAX_FENCE_LINES);
  let bodyEnd = scanCeiling === state.doc.lines ? state.doc.length : state.doc.line(scanCeiling).to;
  for (let n = opening.line + 1; n <= scanCeiling; n++) {
    const line = state.doc.line(n);
    if (line.text.trim().startsWith(opening.marker)) {
      bodyEnd = line.from > bodyStart ? line.from - 1 : line.from;
      break;
    }
  }
  if (pos < bodyStart || pos > bodyEnd) return null;

  return { spec, lang: opening.lang, from: bodyStart, to: bodyEnd, inStep: insideStep(state, pos, bodyStart) };
}

/**
 * Is the cursor inside a `steps:` or `frames:` list?
 *
 * Walks outward one indent level at a time. A `- ` line is part of its step
 * rather than the thing that introduces it, so the search continues past it:
 *
 *     steps:            ← what we are looking for
 *       - note: a       ← a list item, not an answer
 *         ▌             ← the cursor
 */
function insideStep(state: EditorState, pos: number, bodyStart: number): boolean {
  const cursorLine = state.doc.lineAt(pos);
  let indent = cursorLine.text.match(/^\s*/)![0].length;
  if (indent === 0) return false;
  const firstLine = state.doc.lineAt(bodyStart).number;

  for (let n = cursorLine.number - 1; n >= firstLine; n--) {
    const text = state.doc.line(n).text;
    if (text.trim() === "") continue;
    const own = text.match(/^\s*/)![0].length;
    if (own >= indent) continue;
    if (/^\s*(steps|frames)\s*:/.test(text)) return true;
    // A shallower list item means we are inside one of its entries; keep
    // looking for whatever that list belongs to.
    if (/^\s*-/.test(text)) {
      indent = own;
      continue;
    }
    return false;
  }
  return false;
}

function typeHint(attr: SchemaAttribute): string {
  const types = Array.isArray(attr.type) ? attr.type.join("|") : attr.type;
  if (attr.items) return `${types} of ${Array.isArray(attr.items) ? attr.items.join("|") : attr.items}`;
  if (Array.isArray(attr.matches)) return attr.matches.map(String).join(" | ");
  return types;
}

/**
 * Keys for the fence under the cursor, required ones first.
 *
 * `boost` rather than sort order, because CodeMirror re-ranks by match
 * quality and a required key an author has not typed yet would otherwise sink.
 */
export function fenceKeyCompletionSource(context: CompletionContext): CompletionResult | null {
  const fence = fenceAtCursor(context.state, context.pos);
  if (!fence) return null;

  const line = context.state.doc.lineAt(context.pos);
  const before = line.text.slice(0, context.pos - line.from);
  // Only at the start of a mapping entry: `  activeI` or `  - activeI`.
  const match = /(?:^|^\s*-\s+)\s*([A-Za-z_][\w-]*)?$/.exec(before);
  if (!match) return null;
  const typed = match[1] ?? "";
  const from = context.pos - typed.length;

  const reserved = fence.inStep ? RESERVED_STEP : RESERVED_TOP_LEVEL;
  const options: Completion[] = [];

  for (const [key, attr] of Object.entries(fence.spec.schema.attributes)) {
    if (fence.inStep && attr.steppable === false) continue;
    options.push({
      label: key,
      apply: `${key}: `,
      type: attr.required ? "keyword" : "property",
      detail: typeHint(attr),
      info: attr.description,
      boost: attr.required ? 2 : 0,
    });
  }
  for (const key of reserved) {
    if (key in fence.spec.schema.attributes) continue;
    options.push({
      label: key,
      apply: `${key}: `,
      type: "variable",
      detail: fence.inStep ? "step key" : "fence key",
      boost: -1,
    });
  }

  return { from, to: context.pos, options, validFor: /^[A-Za-z_][\w-]*$/ };
}

export interface FenceDiagnostic {
  from: number;
  to: number;
  severity: "error" | "warning";
  message: string;
  source: string;
}

type ParsedFence = ReturnType<typeof parseFence>;

/**
 * Parse results by fence text. The linter re-runs over the whole document
 * after each pause in typing, but only the fence being edited has changed.
 */
const parseCache = new Map<string, ParsedFence>();
const PARSE_CACHE_LIMIT = 256;

function parseCached(spec: FenceSpec, lang: string, body: string): ParsedFence {
  const key = `${lang}\n${body}`;
  const hit = parseCache.get(key);
  if (hit) return hit;
  const parsed = parseFence(spec, body);
  if (parseCache.size >= PARSE_CACHE_LIMIT) parseCache.clear();
  parseCache.set(key, parsed);
  return parsed;
}

/**
 * Validate every widget fence in the document, mapped to editor offsets.
 *
 * Finds fences by their delimiter lines rather than by parsing the markdown,
 * and only YAML-parses the widget fences. Shaped as `@codemirror/lint`'s
 * `Diagnostic`; `fenceLinter` wires it in.
 */
export function fenceDiagnostics(state: EditorState): FenceDiagnostic[] {
  const out: FenceDiagnostic[] = [];
  let line = 1;

  while (line <= state.doc.lines) {
    const text = state.doc.line(line).text;
    const match = OPEN.exec(text.trim());
    if (!match || !match[2]) {
      line += 1;
      continue;
    }
    const marker = match[1]!;
    const lang = match[2];
    let close = state.doc.lines + 1;
    for (let n = line + 1; n <= state.doc.lines; n++) {
      if (state.doc.line(n).text.trim().startsWith(marker)) {
        close = n;
        break;
      }
    }

    const spec = getFence(lang);
    if (spec) {
      const bodyLines: string[] = [];
      for (let n = line + 1; n < close && n <= state.doc.lines; n++) {
        bodyLines.push(state.doc.line(n).text);
      }
      const body = bodyLines.join("\n");
      const parsed = parseCached(spec, lang, body);
      const at = (bodyLine?: number) => {
        const target = bodyLine && bodyLine >= 1 ? line + bodyLine : line;
        const l = state.doc.line(Math.min(target, state.doc.lines));
        return { from: l.from, to: l.to };
      };
      if (parsed.error) {
        out.push({ ...at(), severity: "error", message: `${lang}: ${parsed.error}`, source: "kiwi-fence" });
      }
      for (const issue of parsed.issues) {
        out.push({
          ...at(issue.line),
          severity: issue.severity,
          message: `${lang}: ${issue.message}`,
          source: "kiwi-fence",
        });
      }
    }

    line = close + 1;
  }
  return out;
}

/** Inline fence errors for the source editor, once typing pauses. */
export const fenceLinter = (): Extension =>
  linter((view) => fenceDiagnostics(view.state), { delay: 500 });

export const fenceCompletion: CompletionSource = fenceKeyCompletionSource;

// ── Live preview ────────────────────────────────────────────────────────────

export interface FencePreviewTarget {
  lang: string;
  /** The fence's YAML body, without the delimiter lines. */
  body: string;
  /** The meta string after the language on the opening line. */
  meta: string;
}

/**
 * What a source-mode preview pane should render: the fence the caret is in.
 *
 * Returns the raw strings rather than a parsed fence, so the pane can mount
 * the same `TypedFence` the page uses — a preview that renders through a
 * second code path is a preview that lies.
 */
export function samePreviewTarget(a: FencePreviewTarget | null, b: FencePreviewTarget | null): boolean {
  if (a === null || b === null) return a === b;
  return a.lang === b.lang && a.meta === b.meta && a.body === b.body;
}

export function fencePreviewAt(state: EditorState, pos: number): FencePreviewTarget | null {
  const fence = fenceAtCursor(state, pos);
  if (!fence) return null;
  const openLine = state.doc.lineAt(fence.from).number - 1;
  const opening = openLine >= 1 ? state.doc.line(openLine).text.trim() : "";
  const meta = opening.replace(/^(`{3,}|~{3,})\s*\S*\s*/, "");
  return {
    lang: fence.lang,
    body: state.doc.sliceString(fence.from, fence.to),
    meta,
  };
}
