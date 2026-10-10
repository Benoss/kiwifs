/**
 * The fence meta string — everything after the language on the opening line:
 *
 *   ```array id=two-sum clock=a width=wide caption="Two-pointer sweep" loop
 *
 * Deliberately not YAML: it has to survive being written by hand on one line,
 * and `rehypeCodeMeta` already hands it to us verbatim.
 */

import type { FigureWidth } from "@kw/lib/figureLayout";

export interface FenceMeta {
  /** Stable name for the widget: the clock id, the anchor, the link target. */
  id?: string;
  /** Clock to join. Defaults to `id` when set. */
  clock?: string;
  title?: string;
  caption?: string;
  width: FigureWidth;
  autoplay: boolean;
  loop: boolean;
  /** Unrecognised `key=value` pairs, so a spec can read its own. */
  rest: Record<string, string>;
}

const WIDTHS = new Set<FigureWidth>(["inline", "wide", "full"]);

/** Split on whitespace, keeping `"quoted values"` together. */
export function tokenizeMeta(meta: string): string[] {
  const out: string[] = [];
  let buf = "";
  let quote: '"' | "'" | null = null;
  for (const ch of meta) {
    if (quote) {
      if (ch === quote) quote = null;
      else buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (buf) out.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf) out.push(buf);
  return out;
}

export function parseFenceMeta(meta: string | undefined): FenceMeta {
  const out: FenceMeta = { width: "inline", autoplay: false, loop: false, rest: {} };
  if (!meta) return out;

  // `caption="…"` has to survive the tokenizer losing its quotes, so pull the
  // quoted forms out first and tokenize what is left.
  let remaining = meta;
  const quoted = /(\w+)=(?:"([^"]*)"|'([^']*)')/g;
  remaining = remaining.replace(quoted, (_, key: string, dq?: string, sq?: string) => {
    assign(out, key, dq ?? sq ?? "");
    return " ";
  });

  for (const token of tokenizeMeta(remaining)) {
    const eq = token.indexOf("=");
    if (eq < 0) {
      if (token === "autoplay") out.autoplay = true;
      else if (token === "loop") out.loop = true;
      else if (WIDTHS.has(token as FigureWidth)) out.width = token as FigureWidth;
      continue;
    }
    assign(out, token.slice(0, eq), token.slice(eq + 1));
  }

  if (!out.clock && out.id) out.clock = out.id;
  return out;
}

function assign(out: FenceMeta, key: string, value: string) {
  switch (key) {
    case "id":
      out.id = value;
      break;
    case "clock":
      out.clock = value;
      break;
    case "title":
      out.title = value;
      break;
    case "caption":
      out.caption = value;
      break;
    case "width":
      if (WIDTHS.has(value as FigureWidth)) out.width = value as FigureWidth;
      break;
    case "autoplay":
      out.autoplay = value !== "false";
      break;
    case "loop":
      out.loop = value !== "false";
      break;
    default:
      out.rest[key] = value;
  }
}
