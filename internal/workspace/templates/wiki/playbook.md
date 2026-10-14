# Agent Playbook — Team Wiki

This wiki is organized by workflow area, with each folder containing
an `index.md` landing page. When connected via MCP, use these
operations to maintain it.

## Quick Start

1. Call `kiwi_context` to get this playbook + schema + index in one call
2. Call `kiwi_tree` to see the current folder structure
3. Use the operations below to create, organize, and maintain

## Create Page

When adding new content:

1. **Find the right section.** `kiwi_tree` to see the area structure.
   - `processes/` — SOPs, runbooks, step-by-step guides
   - `decisions/` — ADRs (use the MADR decision template)
   - `reference/` — glossary entries, FAQ, vendor info
   - `onboarding/` — new-member resources
   - Top-level — only for major cross-cutting pages
2. **Check for duplicates.** `kiwi_search` for key terms first.
3. **Write the page.** `kiwi_write` with frontmatter:
   ```yaml
   ---
   title: "Page Title"
   owner: team-or-person
   status: draft
   tags: [section, topic]
   last-reviewed: YYYY-MM-DD
   ---
   ```
4. **Cross-link.** Add `[[wikilinks]]` to related pages.
   Use `kiwi_search` to find them.
5. **Update the section index.** `kiwi_read` the section's `index.md`,
   add a link to the new page, `kiwi_write` it back.

### Create ADR (MADR Format)

Architecture Decision Records are immutable once accepted. Follow the
[MADR](https://adr.github.io/madr/) format:

1. Determine the next ADR number from `decisions/index.md`.
2. Create `decisions/adr-NNN-slug.md` with `status: proposed`.
3. Fill in required sections:
   - **Decision Drivers** — what motivated this decision
   - **Context** — forces at play
   - **Decision** — stated as a directive ("We will...")
   - **Alternatives Considered** — with pros/cons for each
   - **Consequences** — split into Positive / Negative / Neutral
   - **Reversal Conditions** — when to revisit
4. Set `review-by` for high-stakes decisions (recommended: 12 months).
5. Add a row to the decision log in `decisions/index.md`.
6. Once reviewed and agreed: change `status` to `accepted`.

**Superseding a decision:** Never edit an accepted ADR. Create a new one
with `supersedes: decisions/adr-NNN-old.md` and update the old ADR's
frontmatter: `status: superseded`, `superseded-by: decisions/adr-NNN-new.md`.

### Create SOP (Process Page)

For standard operating procedures in `processes/`:

1. `kiwi_search` to check for existing coverage.
2. `kiwi_write` to `processes/<slug>.md` with:
   ```yaml
   ---
   title: "Process Name"
   type: sop
   owner: team-or-person
   status: draft
   scope: engineering
   frequency: on-demand
   estimated-time: "15 minutes"
   tags: [processes, area]
   last-reviewed: YYYY-MM-DD
   last-tested: YYYY-MM-DD
   ---
   ```
3. Structure the body with: When to Use, Prerequisites, Steps
   (numbered, single discrete actions), Verification, Rollback,
   Success Criteria.
4. Cross-link to related processes.
5. Update `processes/index.md`.

## Organize

When restructuring or cleaning up:

1. `kiwi_tree` to understand current layout.
2. One page: `kiwi_rename` — every link to it is rewritten.
   Several pages, a folder, a glob or a merge: write a manifest and run
   `kiwi_refactor_plan`, show the user the moves and link counts, then
   `kiwi_refactor_apply` with the plan's digest. One plan, one commit;
   never move files by rewriting and deleting them.
3. Ensure every folder has an `index.md` landing page.
4. Keep folder depth ≤ 3 levels for discoverability.

## Maintain

Run periodically or when asked:

1. `kiwi_lint` with `path` — check individual files for structural issues.
2. `kiwi_analytics` — find stale pages, orphans, broken links.
3. For stale pages: update content, bump `last-reviewed`, notify owner.
4. For orphans: add links from related pages or the section index.
5. For broken links: `kiwi_search` for the intended target, fix.
6. `kiwi_search` for "TODO" or "TBD" to find incomplete pages.
7. Check for `status: draft` pages that should be promoted to `active`.

**Best practice:** After every `kiwi_write`, call `kiwi_lint` on the same path.

### Quarterly Review

Run every 90 days (integrate into sprint retro or team sync):

1. Find stale pages:
   ```
   kiwi_query("TABLE _path, title, owner, last-reviewed WHERE last-reviewed < date_sub(now(), 90) SORT last-reviewed ASC")
   ```
2. Find ADRs past their review date:
   ```
   kiwi_query("TABLE _path, title, review-by WHERE type = 'decision' AND review-by < now()")
   ```
3. Find deprecated pages with no inbound links (archive candidates):
   ```
   kiwi_query("TABLE _path, title WHERE status = 'deprecated'")
   ```
   Check each with `kiwi_backlinks` — if none, archive.
4. Review `status: draft` pages older than 30 days — promote or delete.
5. Notify page owners of stale content via `log.md` or team channel.
6. Record the review in `log.md`:
   `- YYYY-MM-DD: Quarterly review — N stale pages flagged, M archived`

## Quality Rules

- **Workflow-first structure.** Sections map to how work gets done.
- **Every folder has `index.md`.** The landing page for that area.
- **Keep pages short.** Split when a page exceeds ~300 lines.
- **Frontmatter required.** At least `title`, `owner`, `status`, and `tags`.
- **No orphans.** Every page reachable from its section's `index.md`.
- **Owner accountability.** Stale pages get flagged to their owner.
- **Descriptive titles.** Plain language, no jargon or clever names.
- **ADRs are immutable.** Supersede, never edit accepted decisions.
- **SOPs must be testable.** Include verification steps and rollback.
- **Quarterly reviews happen.** No page goes > 90 days without a check.
