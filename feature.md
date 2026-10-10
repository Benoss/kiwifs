# Feature Plan — Rendering Beautiful Long-Form Technical Content

Status: 1–7 implemented. Scope: **rendering quality and content mechanics only**.

## Why this document

KiwiFS renders markdown well. The open question is whether a workspace can carry *explanatory* content — the kind where a wide architecture diagram carries the argument, the prose builds a system up one component at a time, and the numbers in the capacity estimate are actually correct.

Today the substrate is mostly there but the author pays too much for it, and the output does not look as good as the content deserves.

Every feature is judged against one test: **would an engineering handbook, an architecture decision record, a runbook library, or an onboarding guide want this too?** If not, it is content, and it belongs in the workspace's markdown rather than in this repo.

Non-goals: user accounts, community submissions, AI tutoring, video hosting, quizzes and spaced repetition, an LMS. Those are services or learning-science features. This document is about making pages look and read well.

## What already exists

| Capability | Where |
|---|---|
| Step-through engine — keyboard, scrubber, speed, URL deep-link | `ui/src/widgets/usePlayback.ts`, `PlaybackControls.tsx` |
| 15 visualization components (array, tree, graph, matrix, plot, timeline, …) | `ui/src/widgets/` |
| Arbitrary inline React | `widget:live` → `ui/src/components/KiwiWidget.tsx` |
| Mermaid with zoom/pan and click bindings | `ui/src/components/MermaidDiagram.tsx` (mermaid ^11) |
| Excalidraw whiteboards, JSON Canvas | `@excalidraw/excalidraw`, `@xyflow/react` |
| Shiki with line highlighting and diff styling | `ui/src/components/ShikiCode.tsx` |
| KaTeX, GFM, footnotes, admonitions, tabs, columns | `ui/src/lib/kiwiMarkdown.ts`, `remarkDirectives.ts` |
| Query language, saved views, inline query fences | `internal/dataview/`, `internal/views/` |
| Image lightbox, ToC sidebar, reading time | `KiwiPage.tsx`, `KiwiToC.tsx`, `lib/readingTime.ts` |
| Multi-chapter PDF/HTML/slides export with a `_book.yaml` manifest | `internal/docexport/` |

Numbering below is an identifier, not an order. See [Sequencing](#sequencing).

---

## 1 — Stepped diagrams *(approved)*

**The problem.** `usePlayback` can step anything and `MermaidDiagram` can draw anything, but they have never been introduced. A diagram is a single static frame. Explaining a system means showing it accrete: here is the write path; now add the cache; now add the queue and watch where the write actually lands. Getting that today means a couple hundred lines of `React.createElement` inside `widget:live`, which is how LeetLlama's algorithm visualizations are built and does not scale past a motivated author.

**The proposal.** A declarative fence driving the existing playback engine:

````markdown
```kiwi-steps
diagram: |
  graph LR
    C[Client] --> A[API]
    A --> DB[(Postgres)]
    A --> Q[[Queue]]
    Q --> W[Worker]
steps:
  - focus: [C, A]
    note: The client writes through the API. Nothing is durable yet.
  - focus: [A, DB]
    dim: [Q, W]
    note: The API commits synchronously. This is the latency floor.
  - focus: [Q, W]
    note: Everything past this point is someone else's failure mode.
```
````

Two implementation details matter, and they differ by diagram type:

**Flowcharts and graphs** — render the diagram *once*, then toggle Mermaid `classDef`/`class` styles per step. Never re-render the source, because Mermaid re-lays-out on every parse and nodes will visibly jump between steps. This is the same layout-stability problem `ui/src/widgets/graphLayout.ts` already solves for `GraphView`.

**Sequence diagrams** — class-based styling does not apply to messages, so step by *truncating the message list*: step N renders the first N messages. Re-parsing is acceptable here because Mermaid lays sequence diagrams out top-down and earlier messages keep their positions. This case matters — request-flow sequences are half of what system-design content needs to show.

The same fence should optionally drive `CodeHighlight` (`line:`) and `AnnotationBar` (`note:`), so one block can step a diagram and a code listing together.

**Generic?** Yes. Incident runbooks, ADRs, onboarding walkthroughs, and request-lifecycle docs all want a diagram that builds.

**Libraries.** None new. `mermaid`, `usePlayback`, `PlaybackControls`, `CodeHighlight`, `AnnotationBar`, and `js-yaml` are all present. Depends on **#4**.

**Success measure.** A stepped architecture diagram costs ten lines of YAML instead of two hundred lines of React.

## 2 — Inline whiteboards and canvases *(approved)*

**The problem.** `.excalidraw.md` and `.canvas.json` render only as full-screen views. `![[diagram.excalidraw.md]]` produces a *link*, so the moment a diagram needs to be hand-drawn rather than auto-laid-out, it leaves the page.

This matters more than it sounds. Auto-layout is worst at exactly the diagrams that teach — the ones where spatial arrangement carries meaning. Hello Interview draws every architecture diagram in Excalidraw for precisely this reason; they use no Mermaid at all.

**The proposal.** Render `![[foo.excalidraw.md]]` and `![[foo.canvas.json]]` inline as a static, zoomable figure with an "open to edit" affordance. `ExcalidrawMarkdownPreview` already produces a static SVG preview, so this is largely a routing change in `ui/src/lib/wikiLinks.ts` plus size and caption syntax (`![[foo.excalidraw.md|wide]]`).

Two things to get right. Excalidraw SVG exports carry a white background, which will look like a bright slab in dark mode — pass `exportWithDarkMode` or strip the background rect. And pair this with `@excalidraw/mermaid-to-excalidraw`, which is **already in the dependency tree** transitively: sketch in Mermaid, convert once, hand-tune. That authoring path costs almost nothing to expose and is how most good diagrams actually get made.

**Generic?** Yes — any page that wants a hand-drawn figure.

**Libraries.** All present.

## 3 — Sequential reading order *(approved)*

**The problem.** A course, handbook, or chaptered guide is an ordered path; the UI offers a file tree. There is no prev/next, no sense of position. An ordering manifest **already exists** — `_book.yaml` with a `parts:` list, parsed by `internal/docexport/book.go` — but only the export path reads it.

**The proposal.** Promote `_book.yaml` to a first-class reading order:

```
← Hash Maps                                    Trees →
                  Chapter 3 of 9
```

Three surfaces, one manifest: a prev/next footer, an outline sidebar reflecting book order rather than filesystem order, and a chapter index that renders as cards rather than a bare list. Fall back to frontmatter `order`, then filename, when no manifest exists.

**Generic?** Yes — handbooks, onboarding paths, and runbook sequences are all ordered.

**Libraries.** None. Reuse `book.go`.

---

## 4 — Diagrams that look like they belong *(proposed)*

**The problem.** This is the one I under-weighted, and it gates both approved diagram features.

`MermaidDiagram` initializes with `theme: "default"` hardcoded, once, at module load. It never reads the app theme. **Every diagram renders light-on-dark in dark mode** — black text on a white box in the middle of a dark page. Beyond that, Mermaid's default look is Graphviz-adjacent: a system font that matches nothing else on the page, hard drop shadows, primary-color fills, cramped node padding.

You can author the best-structured architecture diagram in the world and it will still look like a compiler artifact dropped into an otherwise well-designed page. No amount of work on #1 fixes this.

**The proposal.** A Mermaid theme derived from KiwiFS design tokens — `themeVariables` bound to the same CSS custom properties the rest of the UI uses for surface, border, text, muted, and accent, with the app's font stack, restrained node radii, no drop shadows, and generous padding. Re-initialize on theme change so diagrams flip with the page.

Then define the semantic classes that #1 depends on, so `focus` and `dim` mean something consistent everywhere: a focused node reads as accented and slightly raised, a dimmed one drops to muted at reduced opacity, and transitions are eased so stepping feels deliberate rather than jumpy.

Add an SVG/PNG download while in there — once diagrams carry the explanation, people want to paste them into a doc or a slide.

**Generic?** Yes. This is straightforwardly a rendering bug plus visual design, and it improves every existing Mermaid diagram in every workspace on upgrade.

**Libraries.** None. `mermaid.initialize({ themeVariables })` is the whole API surface.

## 5 — Figures that get room to breathe *(proposed)*

**The problem.** Prose wants a ~70-character measure; architecture diagrams want 1200 pixels. Right now they share one column, so every wide diagram is either squeezed into the text width or forced into the lightbox to be legible. There is also no caption primitive — an image followed by an italic line is not a figure, it is an image followed by an italic line, and it wraps and aligns accordingly.

And the specific failure mode of deep-dive content: you present a diagram, then spend 800 words discussing it, by which point the diagram is three screens up. The reader scrolls back and forth, or gives up and reads the prose without the picture.

**The proposal.** A figure treatment with three widths — inline (prose column), wide (breaks the measure symmetrically), and full-bleed — plus proper captions with the source page attribution when the figure is transcluded from a whiteboard.

Figures stay in document flow: diagram, then the prose that talks about it. A sticky side-by-side was tried and dropped — it fought the ToC and split a one-line caption into a void.

**Generic?** Yes. Any long-form technical writing has figures its prose talks about at length.

**Libraries.** None — CSS, plus a directive or wiki-link modifier for the width and pin flags.

## 6 — Diagrams as navigation *(proposed)*

**The problem.** In a long system-design page the architecture diagram *is* the table of contents — every box corresponds to a section further down. But the diagram is inert, so the reader translates "the queue box" into "find the Queue heading" by hand, every time.

**The proposal.** Bind diagram node clicks to page anchors and wiki links. Mermaid already supports `click NodeId "..."` and `MermaidDiagram` already calls `bindFunctions(svgEl)` after injection — the wiring exists and nothing uses it. Route those clicks through the in-app navigator so they resolve like any other wiki link, with hover affordances that make clickable nodes discoverable.

The natural pairing: in a `kiwi-steps` block, clicking a node jumps to the step that introduces it. The diagram becomes the index of its own explanation.

**Generic?** Yes — clickable architecture diagrams, org charts, and process maps are a standard wiki want.

**Libraries.** None. This is roughly a day of work against an API that is already called.

## 7 — Numbers that cannot drift *(proposed)*

**The problem.** System-design content is dense with back-of-envelope math: 10M daily actives × 100 writes each is 1B writes/day is ~12k writes/second, and at 1KB per write that is 1TB/day, which sizes the cluster three paragraphs later. Written as prose, these numbers are copy-paste artifacts. Change the DAU assumption and every downstream figure silently becomes a lie. This is the single most common way otherwise-good technical writing goes stale, and it is invisible in review.

**The proposal.** A calculation block that renders as a clean derivation table and actually evaluates, with unit awareness:

````markdown
```kiwi-calc
dau:        10 million
writes:     100 / user / day
write_size: 1 KB
---
qps:     dau * writes / day        # 11.6 k/s
daily:   dau * writes * write_size # 1 TB/day
yearly:  daily * 1 year            # 365 TB
```
````

One engine, two renderings. **Static** is the table above — assumptions at the top, derivations below, units carried through and reduced automatically. **Interactive** binds any assumption to a slider and recomputes live, which is where the existing `InputPanel`, `PlotView`, and `kiwi-playground` components earn their keep: drag DAU from 1M to 100M and watch the storage line cross the threshold where the design has to change.

Unit-awareness is what makes this worth a dependency rather than a regex. `mathjs` handles `10 million * 100 / day → 11.57 k/s` natively, including dimensional analysis that catches the classic bit/byte and per-day/per-second slips.

**Generic?** Yes, though it is the most domain-shaped item here. Cost models, capacity plans, SLO error budgets, and infrastructure sizing all have the same "numbers derived from assumptions that change" problem. It is essentially spreadsheet cells in markdown, which is well-trodden wiki territory.

**Libraries.** `mathjs` (Apache-2.0, mature, tree-shakeable — import only the evaluator and unit system).

---

## Sequencing

| Order | # | Feature | Impact | Effort |
|---|---|---|---|---|
| 1 | 4 | Diagram styling and dark mode | High | Low |
| 2 | 2 | Inline whiteboards | High | Low |
| 3 | 3 | Reading order | Medium | Low |
| 4 | 1 | Stepped diagrams | High | Medium |
| 5 | 5 | Figure widths and sticky figures | High | Low–Medium |
| 6 | 6 | Diagrams as navigation | Medium | Low |
| 7 | 7 | Calculation blocks | Medium | Medium |

**#4 ships first** even though #1 is the flagship. Both approved diagram features render through Mermaid, and both look broken in dark mode until the theme is fixed — there is no point building a beautiful stepping interaction on top of a diagram that is unreadable half the time.

The first three items are roughly a week of small work that visibly changes how every page reads, and they land before the flagship rather than after it.

## Smaller things worth folding in

- **Export from the UI.** `internal/docexport` already builds multi-chapter PDFs via `_book.yaml`, and nothing in the app exposes it. A "download chapter" button is a wiring job, and it pairs naturally with #3.
- **Shiki language fallback.** The preload list is fixed; anything outside it renders as unhighlighted plain text with no warning. Load languages on demand.
- **Tradeoff table styling.** System-design writing is mostly comparisons. Plain GFM tables handle the structure; a light visual treatment for pro/con and recommendation rows would carry most of the remaining value without new syntax.

## Principles

**Declarative fences over hand-written React.** `widget:live` is the right escape hatch and the wrong default. Any pattern appearing three times should become a fence with YAML behind it.

**Reuse what is installed.** Mermaid, Excalidraw, React Flow, Shiki, KaTeX, Radix, recharts, and remark-directive already cover most of this surface. `mathjs` is the only new dependency in the plan, and only for #7.

**Fix the rendering before adding to it.** A hardcoded light theme and a squeezed figure column undercut every diagram feature built on top of them. Visual defects compound; features do not.

**Everything stays plain markdown.** A page with a stepped diagram, an inline whiteboard, and a calculation block must still be legible in `cat`, diffable in git, and parseable by an agent over MCP. Any feature that needs a database to make sense of a file has failed the format's core promise.
