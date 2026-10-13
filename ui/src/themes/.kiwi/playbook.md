# Agent Playbook — Knowledge Base

This knowledge base follows the LLM Wiki pattern. When connected
via MCP, use these operations to maintain it.

## Quick Start

1. Call `kiwi_context` to get this playbook + schema + index in one call
2. Call `kiwi_tree` to see the current file structure
3. Use the operations below to ingest, query, and maintain

## Ingest (new source → wiki pages)

When given new information to add:

1. **Deduplicate first.** `kiwi_search` for key terms from the source.
   If a page already covers this topic, update it instead of creating
   a duplicate.
2. **Create or update page.**
   `kiwi_write` to `pages/<slug>.md` with frontmatter:
   ```yaml
   ---
   title: "Human-readable title"
   description: "One-line summary"
   tags: [topic-1, topic-2]
   status: active
   ---
   ```
   Set provenance via the `provenance` parameter:
   `ingest:<source-slug>`.
3. **Cross-link.** Use `[[wikilinks]]` in the body to connect to
   related pages. Use `kiwi_search` to discover what exists.
4. **Update the log.** `kiwi_append` to `log.md`:
   `- YYYY-MM-DD: Ingested <title> → [[pages/<slug>]]`
5. **Update the index.** `kiwi_read` `index.md`, add the new
   `[[pages/<slug>]]` link, `kiwi_write` it back.

## Query (answer a question from the wiki)

1. `kiwi_search` for relevant terms (try 2-3 queries).
2. `kiwi_read` top results. Use `if_not_etag` if you've read them
   before to save tokens.
3. `kiwi_backlinks` on key pages to find related context.
4. Synthesize an answer citing `[[page]]` links.
5. If the answer reveals a gap, run Ingest to fill it.

## Deep Retrieval (Graph Navigation)

When answering complex questions that span multiple topics:

1. **Find entry points** — `kiwi_search` with keywords from the question (fast, lexical)
2. **Peek at candidates** — `kiwi_peek` on top 2-3 results. Read title + snippet + headings.
   Decide which page is most relevant.
3. **Walk the graph** — `kiwi_graph_walk` on the best candidate. See what it links to.
   If a link's name matches your query, peek at it.
4. **Read targeted sections** — `kiwi_section` to read only the relevant heading.
   Never read entire files unless they're short (< 500 words per kiwi_peek word_count).
5. **Check the map** — if stuck or need overview, `kiwi_graph_analytics` shows hub pages,
   topic clusters, and bridge pages. Hub pages are good starting points.

### Cost efficiency

| Tool | Typical tokens | When to use |
|------|---------------|-------------|
| `kiwi_search` | ~50 per result | Always first — find entry points |
| `kiwi_peek` | ~200 | Before reading — check if page is relevant |
| `kiwi_section` | ~500 | After peek confirms the right heading |
| `kiwi_read` | ~2000+ | Only when you need the complete file |
| `kiwi_graph_walk` | ~300 | When exploring connections |
| `kiwi_graph_analytics` | ~500 | When lost or need the big picture |

### Example: Multi-hop retrieval

Question: "How does payment retry interact with the circuit breaker?"

```
kiwi_search("payment retry")        → pages/payments.md (rank 1)
kiwi_search("circuit breaker")      → pages/resilience.md (rank 1)
kiwi_graph_walk("pages/payments.md")
  → links_out: ["resilience", "billing", "error-handling"]
  → AHA: payments links to resilience directly!
kiwi_section("pages/payments.md", "Retry Logic")    → 400 tokens
kiwi_section("pages/resilience.md", "Circuit Breaker") → 350 tokens

Total: ~1500 tokens. Full reads would have cost ~8000 tokens.
```

## Remember (save observations during a session)

1. `kiwi_write` to `episodes/<session-id>-<slug>.md` with:
   ```yaml
   ---
   memory_kind: episodic
   episode_id: unique-id
   session_id: current-session
   confidence: 0.8
   tags: [topic]
   ---
   ```
2. `kiwi_append` to `log.md`:
   `- YYYY-MM-DD: Remembered <summary> → [[episodes/<file>]]`

## Consolidate (episodes → durable pages)

Run when asked, or when `kiwi_memory_report` shows unconsolidated episodes.

1. `kiwi_memory_report` — list unconsolidated episodes.
2. `kiwi_read` each unconsolidated episode.
3. Extract durable facts. `kiwi_search` for existing pages on
   those topics.
4. Merge into existing `pages/` entries or create new ones.
   Set `merged-from` in the page frontmatter listing episode paths.
5. Mark episodes: `kiwi_write` each with `consolidated: true` and
   `merged-into: [pages/<slug>.md]` added to frontmatter.
6. Update `log.md` and `index.md`.

## Lint (maintenance pass)

Run periodically or when asked to clean up:

1. `kiwi_analytics` — reports orphans, broken
   links, stale content, missing frontmatter.
2. `kiwi_changes` with `since=<last_checkpoint>` — review recent
   edits for quality.
3. For each issue:
   - Orphan page → add `[[wikilinks]]` from related pages or index
   - Broken link → `kiwi_search` for intended target, fix the link
   - Stale page → update content, bump `last-reviewed`
   - Duplicate → write the combined page, then `kiwi_refactor_plan` with
     `merges: [{from: dup.md, into: keeper.md}]` and `kiwi_refactor_apply`
     (links, comments and state move to the keeper; never rename + delete)
4. `kiwi_append` to `log.md` with what was fixed.

## Page Format

```markdown
---
title: "Page Title"
description: "Brief one-line summary"
tags: [tag1, tag2]
status: active
last-reviewed: YYYY-MM-DD
---

# Page Title

Introduction paragraph.

## Section

Content with [[wikilinks]] to related pages.

## Related
- [[related-page]] — why it's related
```

## Quality Rules

- **One concept per page.** Split pages over 300 lines.
- **Every page needs frontmatter** with at least `title` and `tags`.
- **No orphans.** Every page reachable from `index.md` within 2 hops.
- **No broken links.** Every `[[wikilink]]` should resolve.
- **Provenance.** Agent-created pages must set provenance on write.
- **Prefer pages over episodes.** When querying, use consolidated
  pages as primary source. Fall back to episodes only if no page exists.
