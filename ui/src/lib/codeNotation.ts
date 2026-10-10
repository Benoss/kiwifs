/**
 * Shiki-style notation comments, as a pre-pass over the source.
 *
 * An author marks a line from inside the code, where the line is:
 *
 *   const x = compute();  // [!code highlight]
 *   -  old()              // [!code --]
 *   +  new()              // [!code ++]
 *   focus(me)             // [!code focus]
 *   warn()                // [!code warning]
 *   // [!code highlight:3]            ← the next three lines
 *
 * Implemented here rather than by adding `@shikijs/transformers`: the whole
 * feature is "strip a comment, remember a class", the repo already has Shiki,
 * and doing it in the source means `CodeHighlight` — which tokenizes rather
 * than rendering HTML — gets it too.
 */

export type NotationKind = "highlight" | "focus" | "add" | "remove" | "error" | "warning";

export interface NotatedCode {
  /** The source with the marker comments removed. */
  code: string;
  /** 1-based line numbers per kind. */
  lines: Record<NotationKind, Set<number>>;
  /** True when any `focus` marker was present, so everything else dims. */
  hasFocus: boolean;
  /** Words to underline, from `[!code word:foo]`. */
  words: string[];
}

const KIND_ALIASES: Record<string, NotationKind> = {
  highlight: "highlight",
  hl: "highlight",
  focus: "focus",
  "++": "add",
  add: "add",
  "--": "remove",
  remove: "remove",
  error: "error",
  warning: "warning",
  warn: "warning",
};

/**
 * `[!code <kind>]`, `[!code <kind>:<n>]`, or `[!code word:<text>]`, inside any
 * of the comment syntaxes a fence is likely to use.
 */
const MARKER =
  /(?:\/\/|#|--|;|%|<!--|\/\*)\s*\[!code\s+(word:(?:[^\]]+)|\+\+|--|[a-z]+)(?::(\d+))?\]\s*(?:-->|\*\/)?\s*$/i;

function emptyLines(): Record<NotationKind, Set<number>> {
  return {
    highlight: new Set(),
    focus: new Set(),
    add: new Set(),
    remove: new Set(),
    error: new Set(),
    warning: new Set(),
  };
}

export function hasNotation(code: string): boolean {
  return /\[!code\s/i.test(code);
}

export function parseNotation(code: string): NotatedCode {
  const lines = emptyLines();
  const words: string[] = [];
  const input = code.split("\n");
  const out: string[] = [];
  /** Markers on their own line apply to the following `count` lines. */
  const pending: { kind: NotationKind; remaining: number }[] = [];

  for (const raw of input) {
    const match = MARKER.exec(raw);
    if (!match) {
      out.push(raw);
      const row = out.length;
      for (const p of pending) {
        if (p.remaining > 0) {
          lines[p.kind].add(row);
          p.remaining -= 1;
        }
      }
      continue;
    }

    const token = match[1]!;
    if (/^word:/i.test(token)) {
      words.push(token.slice(5).trim());
      const stripped = raw.slice(0, match.index).replace(/\s+$/, "");
      if (stripped !== "") out.push(stripped);
      continue;
    }

    const kind = KIND_ALIASES[token.toLowerCase()];
    if (!kind) {
      out.push(raw);
      continue;
    }

    const span = match[2] ? Math.max(1, parseInt(match[2], 10)) : 1;
    const stripped = raw.slice(0, match.index).replace(/\s+$/, "");

    if (stripped === "") {
      // A marker alone on its line decorates what comes next, and the marker
      // line itself is dropped.
      pending.push({ kind, remaining: span });
      continue;
    }

    out.push(stripped);
    const row = out.length;
    lines[kind].add(row);
    if (span > 1) pending.push({ kind, remaining: span - 1 });
    for (const p of pending) {
      if (p.kind !== kind && p.remaining > 0) {
        lines[p.kind].add(row);
        p.remaining -= 1;
      }
    }
  }

  return { code: out.join("\n"), lines, hasFocus: lines.focus.size > 0, words };
}

/** CSS class for a line, given everything the notation said about it. */
export function notationClass(row: number, notated: NotatedCode): string {
  const classes: string[] = [];
  if (notated.lines.add.has(row)) classes.push("kiwi-diff-add");
  if (notated.lines.remove.has(row)) classes.push("kiwi-diff-del");
  if (notated.lines.highlight.has(row)) classes.push("kiwi-line-highlight");
  if (notated.lines.error.has(row)) classes.push("kiwi-line-error");
  if (notated.lines.warning.has(row)) classes.push("kiwi-line-warning");
  if (notated.hasFocus && !notated.lines.focus.has(row)) classes.push("kiwi-line-blur");
  if (classes.length === 0) classes.push("kiwi-line");
  return classes.join(" ");
}
