/**
 * The client-side counterpart of `internal/docexport/widgets.go`.
 *
 * Typst compiles in the browser, so the server's Go pre-pass never sees that
 * markdown. Both paths therefore have to agree: a widget fence becomes its
 * caption, its step notes, and the YAML kept as a code block, so a PDF printed
 * from the UI reads the same as one exported from the CLI.
 */

import yaml from "js-yaml";
import { getFence, sniffFence } from "@kw/fences";

const FENCE_RE = /^(`{3,}|~{3,})[ \t]*([A-Za-z0-9_:.-]*)[^\n]*\n([\s\S]*?)^\1[ \t]*$/gm;

/** Caption, title and step notes — everything that is prose, nothing that is coordinates. */
export function summarizeFenceBody(source: string): string {
  let body: unknown;
  try {
    body = yaml.load(source);
  } catch {
    return "";
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return "";
  const rec = body as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ["title", "caption"]) {
    const value = rec[key];
    if (typeof value === "string" && value.trim()) parts.push(value.trim());
  }
  if (Array.isArray(rec.steps)) {
    for (const step of rec.steps) {
      if (typeof step === "string") parts.push(step);
      else if (step && typeof step === "object") {
        const note = (step as Record<string, unknown>).note;
        if (typeof note === "string" && note.trim()) parts.push(note.trim());
      }
    }
  }
  if (typeof rec.code === "string" && rec.code.trim()) parts.push(rec.code.trim());
  return parts.join("\n");
}

export function rewriteWidgetFences(markdown: string): string {
  return markdown.replace(FENCE_RE, (match, _marker, lang: string, body: string) => {
    const spec = getFence(lang);
    if (!spec || !sniffFence(spec, lang, body)) return match;

    const summary = summarizeFenceBody(body);
    const quoted = summary
      ? `${summary
          .split("\n")
          .map((line) => (line.trim() ? `> ${line}` : ">"))
          .join("\n")}\n>\n`
      : "";
    const note = `> *Interactive ${spec.lang} widget — open this page in KiwiFS to step through it.*\n`;
    return `${quoted}${note}\n\`\`\`yaml\n${body.replace(/\n$/, "")}\n\`\`\`\n`;
  });
}
