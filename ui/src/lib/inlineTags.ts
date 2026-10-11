/**
 * Markdoc-shaped inline tags in prose:
 *
 *   The cache holds {% range name="n" min=1 max=64 step=1 /%} entries,
 *   which is {% value n /%} shards at 40k writes each.
 *
 * A hand parser rather than `@markdoc/markdoc`: the grammar used here is one
 * self-closing tag with scalar attributes, and the dependency is 100 KB for
 * a template language the rest of the renderer does not use.
 */

export interface InlineTag {
  name: string;
  /** The first bare word after the name — `{% value n /%}` → `"n"`. */
  positional?: string;
  attrs: Record<string, string | number | boolean>;
  /** Offsets in the source text, so a caller can splice around it. */
  start: number;
  end: number;
}

/** Quoted attribute values may contain `%`; only an unquoted one ends the tag. */
const TAG = /\{%\s*([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^%])*?)\/?\s*%\}/g;

/** `a=1 b="two" c` → `{a: 1, b: "two", c: true}`, plus any leading bare word. */
function parseAttrs(src: string): { positional?: string; attrs: Record<string, string | number | boolean> } {
  const attrs: Record<string, string | number | boolean> = {};
  let positional: string | undefined;
  // key="value" | key='value' | key=value | bareword
  const token = /([A-Za-z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+))|([A-Za-z_][\w-]*)/g;
  let match: RegExpExecArray | null;
  while ((match = token.exec(src)) !== null) {
    const [, key, dq, sq, bare, lone] = match;
    if (key !== undefined) {
      const raw = dq ?? sq ?? bare ?? "";
      attrs[key] = coerce(raw, dq !== undefined || sq !== undefined);
      continue;
    }
    if (lone !== undefined) {
      if (positional === undefined) positional = lone;
      else attrs[lone] = true;
    }
  }
  return { positional, attrs };
}

function coerce(raw: string, quoted: boolean): string | number | boolean {
  if (quoted) return raw;
  if (raw === "true") return true;
  if (raw === "false") return false;
  const n = Number(raw);
  return raw !== "" && Number.isFinite(n) ? n : raw;
}

export function parseInlineTags(text: string): InlineTag[] {
  if (!text.includes("{%")) return [];
  const out: InlineTag[] = [];
  TAG.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG.exec(text)) !== null) {
    const { positional, attrs } = parseAttrs(match[2] ?? "");
    out.push({
      name: match[1]!.toLowerCase(),
      positional,
      attrs,
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return out;
}

export function hasInlineTags(text: string): boolean {
  return text.includes("{%") && parseInlineTags(text).length > 0;
}

/** The tags this renderer knows. Anything else is left as literal text. */
export const KNOWN_INLINE_TAGS = new Set(["range", "value", "toggle", "select"]);
