import { useEffect, useState } from "react";
import { getHighlighter, hasLang } from "@kw/lib/shiki";
import { alpha } from "./colors";
import { toSet, type Many } from "./sets";

export interface CodeHighlightProps {
  /** The source code to display (plain text, one line per array entry or newline-separated string). */
  code: string | string[];
  /**
   * Line numbering for every line reference below. `0` (the default) keeps the
   * 0-based indexing `widget:live` blocks were written against; typed fences
   * pass `1`, because an author counting lines in a listing starts at one.
   */
  indexBase?: 0 | 1;
  /** The line just executed. -1 or undefined means no highlight. */
  activeLine?: number | number[];
  /**
   * The line about to execute. Python Tutor's two-arrow convention: the
   * just-executed line is green, the next one red, and seeing both is what
   * makes a conditional or a loop boundary legible.
   */
  nextLine?: number | number[];
  /** Lines given a softer secondary highlight — the branch not taken, the lines a value came from. */
  highlightLines?: Many<number>;
  /** Values shown at the end of a line: `{ 2: "take = 12" }`. */
  annotations?: Record<number, string | number | null | undefined> | (string | number | null | undefined)[];
  /** Optional label above the code block. */
  title?: string;
  /** Language for syntax highlighting (default: "python"). */
  lang?: string;
  /** Hide the gutter numbers. */
  showLineNumbers?: boolean;
}

interface TokenSpan {
  content: string;
  color?: string;
}

/**
 * Python Tutor's palette, mapped onto theme tokens so it survives a dark page:
 * just-executed is a calm green, next-to-execute an alert red.
 */
const JUST_RAN = "var(--kw-widget-code-ran, #c9e6ca)";
const NEXT_UP = "var(--kw-widget-code-next, #e93f34)";

function useIsDark(): boolean {
  const read = () => typeof document !== "undefined" && document.documentElement.classList.contains("dark");
  const [dark, setDark] = useState(read);
  useEffect(() => {
    if (typeof MutationObserver === "undefined") return;
    const mo = new MutationObserver(() => setDark(read()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => mo.disconnect();
  }, []);
  return dark;
}

export function CodeHighlight({
  code,
  indexBase = 0,
  activeLine,
  nextLine,
  highlightLines,
  annotations,
  title,
  lang = "python",
  showLineNumbers = true,
}: CodeHighlightProps) {
  const lines = Array.isArray(code) ? code : code.split("\n");
  const source = lines.join("\n");
  // Normalise every reference to a 0-based row once, here, rather than making
  // each caller remember which convention it is in.
  const shift = (set: Set<number>) =>
    indexBase === 0 ? set : new Set([...set].map((n) => n - 1));
  const activeSet = shift(toSet(activeLine));
  const nextSet = shift(toSet(nextLine));
  const softSet = shift(toSet(highlightLines));
  const arrows = nextLine != null;
  const annotationAt = (row: number) => {
    const key = (row + indexBase) as keyof typeof annotations;
    return annotations?.[key] as string | number | null | undefined;
  };

  const isDark = useIsDark();

  const [tokenLines, setTokenLines] = useState<TokenSpan[][] | null>(null);

  useEffect(() => {
    if (!hasLang(lang)) return;
    let cancelled = false;
    getHighlighter().then((hl) => {
      if (cancelled) return;
      try {
        const result = hl.codeToTokens(source, {
          lang: lang as Parameters<typeof hl.codeToTokens>[1]["lang"],
          theme: isDark ? "github-dark" : "github-light",
        });
        setTokenLines(
          result.tokens.map((line) =>
            line.map((token) => ({
              content: token.content,
              color: token.color,
            }))
          )
        );
      } catch {
        /* fall back to plain text */
      }
    });
    return () => { cancelled = true; };
  }, [source, lang, isDark]);

  return (
    <div style={{
      borderRadius: 8,
      border: "1px solid var(--kw-widget-border, #3f3f46)",
      overflow: "hidden",
      fontSize: "0.8rem",
      fontFamily: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace",
    }}>
      {title && (
        <div style={{
          padding: "4px 12px",
          fontSize: "0.7rem",
          fontWeight: 600,
          color: "var(--kw-widget-dim, #94a3b8)",
          borderBottom: "1px solid var(--kw-widget-border, #3f3f46)",
          background: alpha("var(--kw-widget-border, #3f3f46)", 20),
        }}>
          {title}
        </div>
      )}
      <div style={{ padding: "8px 0" }}>
        {lines.map((line, i) => {
          const active = activeSet.has(i);
          const next = !active && nextSet.has(i);
          const soft = !active && !next && softSet.has(i);
          const note = annotationAt(i);
          const tokens = tokenLines?.[i];
          const accent = active
            ? "var(--kw-widget-active, #a78bfa)"
            : next
              ? NEXT_UP
              : soft
                ? alpha("var(--kw-widget-highlight, #22c55e)", 60)
                : "transparent";
          return (
            <div
              key={i}
              style={{
                display: "flex",
                padding: "1px 12px",
                background: active
                  ? alpha("var(--kw-widget-active, #a78bfa)", 13)
                  : next
                    ? alpha(NEXT_UP, 12)
                    : soft
                      ? alpha("var(--kw-widget-highlight, #22c55e)", 8)
                      : "transparent",
                borderLeft: `3px solid ${accent}`,
                transition: "all 0.15s ease",
              }}
            >
              {showLineNumbers && (
                <span style={{
                  width: 28,
                  textAlign: "right",
                  marginRight: 12,
                  color: active
                    ? "var(--kw-widget-active, #a78bfa)"
                    : next
                      ? NEXT_UP
                      : "var(--kw-widget-dim, #64748b)",
                  userSelect: "none",
                  flexShrink: 0,
                }}>
                  {i + 1}
                </span>
              )}
              {/* Two arrows in the gutter: what just ran, and what runs next.
                  Only when `nextLine` is in use, so a block without it keeps
                  the layout it had before the gutter existed. */}
              {arrows && (
                <span
                  aria-hidden
                  style={{
                    width: 12,
                    marginRight: 4,
                    flexShrink: 0,
                    color: active ? JUST_RAN : next ? NEXT_UP : "transparent",
                    fontWeight: 700,
                    userSelect: "none",
                  }}
                >
                  {active ? "▸" : next ? "▸" : ""}
                </span>
              )}
              <span style={{ whiteSpace: "pre" }}>
                {tokens ? (
                  tokens.map((tok, j) => (
                    <span key={j} style={{ color: active ? undefined : tok.color }}>
                      {tok.content}
                    </span>
                  ))
                ) : (
                  <span style={{
                    color: active
                      ? "var(--kw-widget-text, #e5e7eb)"
                      : "var(--kw-widget-dim, #94a3b8)",
                  }}>
                    {line}
                  </span>
                )}
              </span>
              {note != null && note !== "" && (
                <span style={{
                  marginLeft: "auto",
                  paddingLeft: 16,
                  color: active ? "var(--kw-widget-active, #a78bfa)" : "var(--kw-widget-dim, #94a3b8)",
                  fontSize: "0.72rem",
                  fontStyle: "italic",
                  whiteSpace: "nowrap",
                }}>
                  {"← " + String(note)}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
