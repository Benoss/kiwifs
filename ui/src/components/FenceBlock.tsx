/**
 * One dispatcher for every fenced code block.
 *
 * Both markdown renderers on a page (the page body and the local-notes footer)
 * mount this, so a fence cannot render in one place and degrade to a grey code
 * block in the other.
 *
 * Order matters in two places and is load-bearing:
 *   - `kiwi-data` is dispatched *before* the single-line guard, because a
 *     one-record block is still data, not inline code.
 *   - `kiwi-app` / `kiwi-diff` come *after* it, because they need the meta
 *     string that is only read past that point.
 */

import type { ReactNode } from "react";
import { ShikiCode } from "./ShikiCode";
import { MermaidDiagram } from "./MermaidDiagram";
import { parseMermaidMeta } from "@kw/lib/mermaidTheme";
import { KiwiSteps } from "./KiwiSteps";
import { KiwiCalc } from "./KiwiCalc";
import { KiwiChart } from "./KiwiChart";
import { KiwiApp } from "./KiwiApp";
import { KiwiDiff } from "./KiwiDiff";
import { KiwiKanbanBlock } from "./KiwiKanbanBlock";
import { KiwiDataBlock } from "./KiwiDataBlock";
import { KiwiColor } from "./KiwiColor";
import { KiwiProgress } from "./KiwiProgress";
import { KiwiPlayground } from "./KiwiPlayground";
import { KiwiQuery } from "./KiwiQuery";
import { KiwiWidget } from "./KiwiWidget";
import { CodeRunner } from "@kw/widgets/CodeRunner";
import { PageTracker } from "@kw/widgets/PageTracker";
import { getFence } from "@kw/fences/registry";
import { TypedFence } from "@kw/fences/TypedFence";
import { sniffFence } from "@kw/fences/parseFence";
import "@kw/fences/index";

export interface FenceBlockProps {
  /** `language-xxx` class react-markdown puts on the <code> element. */
  className?: string;
  children?: ReactNode;
  /** The hast node, carrying `data.meta` / `properties.metastring`. */
  node?: any;
  onNavigate?: (path: string) => void;
  /** `kiwi-view: true` in frontmatter — `kiwi-query` renders differently. */
  isComputedView?: boolean;
  /** Typed fences (```array, ```tree, …) are off when false. */
  typedFences?: boolean;
}

/** Parse "{1,3-5,8}" into a Set of line numbers (1-indexed). */
export function parseLineRanges(spec: string): Set<number> {
  const lines = new Set<number>();
  for (const part of spec.split(",")) {
    const trimmed = part.trim();
    const range = trimmed.match(/^(\d+)-(\d+)$/);
    if (range) {
      const start = parseInt(range[1]!, 10);
      const end = parseInt(range[2]!, 10);
      for (let i = start; i <= end; i++) lines.add(i);
    } else {
      const n = parseInt(trimmed, 10);
      if (!Number.isNaN(n)) lines.add(n);
    }
  }
  return lines;
}

export function fenceLang(className?: string): string | undefined {
  const match = /language-([A-Za-z0-9_:.-]+)/.exec(className || "");
  return match ? match[1] : undefined;
}

export function fenceMeta(node?: any): string {
  return node?.data?.meta || node?.properties?.metastring || "";
}

export function FenceBlock({
  className,
  children,
  node,
  onNavigate,
  isComputedView,
  typedFences = true,
  ...rest
}: FenceBlockProps) {
  const lang = fenceLang(className);
  const raw = String(children).replace(/\n$/, "");

  if (lang === "widget:code") {
    const codeLangMatch = fenceMeta(node).match(/lang=(\w+)/);
    return <CodeRunner source={raw} lang={codeLangMatch ? codeLangMatch[1]! : "python"} />;
  }
  if (lang === "widget:tracker") {
    return <PageTracker onNavigate={onNavigate} source={raw} />;
  }
  if (lang?.startsWith("widget:")) {
    return <KiwiWidget name={lang.slice("widget:".length)} source={raw} meta={fenceMeta(node)} />;
  }
  if (lang === "kiwi-query") {
    return <KiwiQuery source={raw} onNavigate={onNavigate} isComputedView={isComputedView} />;
  }
  if (lang === "mermaid") {
    const { focus, dim } = parseMermaidMeta(fenceMeta(node));
    return <MermaidDiagram chart={raw} onNavigate={onNavigate} focus={focus} dim={dim} />;
  }
  if (lang === "kiwi-calc") {
    return <KiwiCalc source={raw} />;
  }
  if (lang === "kiwi-chart") {
    return <KiwiChart source={raw} />;
  }
  if (lang === "kiwi-color") {
    return <KiwiColor source={raw} />;
  }
  if (lang === "kiwi-progress") {
    return <KiwiProgress source={raw} />;
  }
  if (lang === "kiwi-playground") {
    return <KiwiPlayground source={raw} />;
  }
  if (lang === "kiwi-kanban") {
    return <KiwiKanbanBlock source={raw} />;
  }
  if (lang === "kiwi-data") {
    // Before the single-line guard: a one-record block is still data.
    return <KiwiDataBlock source={raw} meta={fenceMeta(node)} />;
  }

  // Typed fences own their own "is this really mine?" test, so a ```tree
  // directory listing or a ```table of pipes still reaches Shiki below.
  if (lang && typedFences) {
    const spec = getFence(lang);
    if (spec && sniffFence(spec, lang, raw)) {
      return <TypedFence spec={spec} source={raw} meta={fenceMeta(node)} onNavigate={onNavigate} />;
    }
  }

  if (lang === "kiwi-steps") {
    return <KiwiSteps source={raw} onNavigate={onNavigate} />;
  }

  if (!lang || !raw.includes("\n")) {
    return (
      <code className={className} {...(rest as any)}>
        {children}
      </code>
    );
  }

  const meta = fenceMeta(node);
  if (lang === "kiwi-app") {
    return <KiwiApp source={raw} meta={meta} />;
  }
  if (lang === "kiwi-diff") {
    return <KiwiDiff source={raw} meta={meta} />;
  }
  const titleMatch = meta.match(/title="([^"]+)"/);
  const title = titleMatch ? titleMatch[1] : undefined;
  const hlMatch = meta.match(/\{([\d,\s-]+)\}/);
  const highlightLines = hlMatch ? parseLineRanges(hlMatch[1]!) : undefined;
  return <ShikiCode code={raw} lang={lang} title={title} highlightLines={highlightLines} />;
}
