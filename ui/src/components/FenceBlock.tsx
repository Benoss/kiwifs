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

import { Suspense, lazy, type ReactNode } from "react";
import { ShikiCode } from "./ShikiCode";
import { parseMermaidMeta } from "@kw/lib/mermaidTheme";
import { KiwiCalc } from "./KiwiCalc";
import { KiwiDiff } from "./KiwiDiff";
import { KiwiKanbanBlock } from "./KiwiKanbanBlock";
import { KiwiDataBlock } from "./KiwiDataBlock";
import { KiwiColor } from "./KiwiColor";
import { KiwiProgress } from "./KiwiProgress";
import { KiwiQuery } from "./KiwiQuery";
import { getFence, sniffFence, TypedFence } from "@kw/fences";

/**
 * The blocks that drag a large library in — react-live, pyodide, mermaid,
 * recharts — load only on a page that uses one.
 *
 * This is the half of the lazy-loading story that the specs alone could not
 * deliver: `KiwiWidget`'s `liveScope` names every view component, so as long
 * as it was statically imported, every page paid for GraphView and dagre
 * whether or not it drew anything.
 */
const KiwiWidget = lazy(() => import("./KiwiWidget").then((m) => ({ default: m.KiwiWidget })));
const CodeRunner = lazy(() => import("@kw/widgets/CodeRunner").then((m) => ({ default: m.CodeRunner })));
const PageTracker = lazy(() => import("@kw/widgets/PageTracker").then((m) => ({ default: m.PageTracker })));
const MermaidDiagram = lazy(() => import("./MermaidDiagram").then((m) => ({ default: m.MermaidDiagram })));
const KiwiSteps = lazy(() => import("./KiwiSteps").then((m) => ({ default: m.KiwiSteps })));
const KiwiChart = lazy(() => import("./KiwiChart").then((m) => ({ default: m.KiwiChart })));
const KiwiApp = lazy(() => import("./KiwiApp").then((m) => ({ default: m.KiwiApp })));
const KiwiPlayground = lazy(() => import("./KiwiPlayground").then((m) => ({ default: m.KiwiPlayground })));

/** A block-shaped placeholder, so the page does not jump as a chunk arrives. */
function Loading() {
  return <div className="my-4 h-24 animate-pulse rounded-lg bg-muted" />;
}

function Deferred({ children }: { children: ReactNode }) {
  return <Suspense fallback={<Loading />}>{children}</Suspense>;
}

export interface FenceBlockProps {
  /** `language-xxx` class react-markdown puts on the <code> element. */
  className?: string;
  children?: ReactNode;
  /** The hast node, carrying `data.meta` / `properties.metastring`. */
  node?: any;
  onNavigate?: (path: string) => void;
  /** `kiwi-view: true` in frontmatter — `kiwi-query` renders differently. */
  isComputedView?: boolean;
  /** Bare typed fences (```array, ```tree, …) are off when false. */
  typedFences?: boolean;
  /** When set, only these bare tags render as widgets. */
  typedFenceTags?: string[] | null;
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
  typedFenceTags,
  ...rest
}: FenceBlockProps) {
  const lang = fenceLang(className);
  const raw = String(children).replace(/\n$/, "");

  if (lang === "widget:code") {
    const codeLangMatch = fenceMeta(node).match(/lang=(\w+)/);
    return <Deferred><CodeRunner source={raw} lang={codeLangMatch ? codeLangMatch[1]! : "python"} /></Deferred>;
  }
  if (lang === "widget:tracker") {
    return <Deferred><PageTracker onNavigate={onNavigate} source={raw} /></Deferred>;
  }
  if (lang?.startsWith("widget:")) {
    return (
      <Deferred>
        <KiwiWidget name={lang.slice("widget:".length)} source={raw} meta={fenceMeta(node)} onNavigate={onNavigate} />
      </Deferred>
    );
  }
  if (lang === "kiwi-query") {
    return <KiwiQuery source={raw} onNavigate={onNavigate} isComputedView={isComputedView} />;
  }
  if (lang === "mermaid") {
    const { focus, dim } = parseMermaidMeta(fenceMeta(node));
    return <Deferred><MermaidDiagram chart={raw} onNavigate={onNavigate} focus={focus} dim={dim} /></Deferred>;
  }
  if (lang === "kiwi-calc") {
    return <KiwiCalc source={raw} />;
  }
  if (lang === "kiwi-chart") {
    return <Deferred><KiwiChart source={raw} /></Deferred>;
  }
  if (lang === "kiwi-color") {
    return <KiwiColor source={raw} />;
  }
  if (lang === "kiwi-progress") {
    return <KiwiProgress source={raw} />;
  }
  if (lang === "kiwi-playground") {
    return <Deferred><KiwiPlayground source={raw} /></Deferred>;
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
  // The workspace switches apply to bare tags only: an author who wrote
  // `kiwi-array` asked for a widget and gets one either way.
  if (lang) {
    const spec = getFence(lang);
    const bare = Boolean(spec) && lang === spec!.lang;
    const allowed =
      !bare || (typedFences && (!typedFenceTags || typedFenceTags.includes(lang)));
    if (spec && allowed && sniffFence(spec, lang, raw)) {
      return <TypedFence spec={spec} source={raw} meta={fenceMeta(node)} onNavigate={onNavigate} />;
    }
  }

  if (lang === "kiwi-steps") {
    return <Deferred><KiwiSteps source={raw} onNavigate={onNavigate} /></Deferred>;
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
    return <Deferred><KiwiApp source={raw} meta={meta} /></Deferred>;
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
