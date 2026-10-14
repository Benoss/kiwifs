import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { RefactorPlan } from "@kw/lib/api";
import { KiwiRefactor, PlanView } from "./KiwiRefactor";

const plan: RefactorPlan = {
  digest: "abc123",
  moves: [{ from: "drafts/a.md", to: "archive/a.md" }],
  merges: [{ from: "faq/dup.md", to: "faq/keep.md" }],
  edits: [{ path: "index.md", links: [{ line: 3, old: "drafts/a", new: "archive/a" }] }],
  content_edits: [{ path: "archive/a.md", from: "drafts/a.md", changes: ["set status"] }],
  warnings: ["misc/ is not in the folder map"],
  stats: { pages: 4, links: 9, rewritten: 1, unresolved: 0 },
  approval: { required: true, reason: "60 files (limit 50)" },
  integrity: { unresolved: 0, orphaned: ["lonely.md"], complete: true },
  diffs: [{ path: "index.md", diff: "--- a/index.md\n+++ b/index.md\n-[[drafts/a]]\n+[[archive/a]]\n" }],
};

describe("restructure review", () => {
  it("starts with an example manifest and nothing planned", () => {
    const html = renderToStaticMarkup(<KiwiRefactor onClose={() => {}} />);
    expect(html).toContain("Restructure");
    expect(html).toContain("Nothing changes until you apply");
    expect(html).toContain("delete_empty_dirs: true");
  });

  it("shows every part of a plan, with a checkbox per move and merge", () => {
    const html = renderToStaticMarkup(<PlanView plan={plan} checklist={plan} rejected={new Set()} onToggle={() => {}} />);
    expect(html).toContain("1 moves, 1 merges");
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(html).toContain("1 links rewritten in 1 pages");
    expect(html).toContain("3: drafts/a → archive/a");
    expect(html).toContain("set status");
    expect(html).toContain("misc/ is not in the folder map");
    expect(html).toContain("60 files (limit 50)");
    expect(html).toContain("No page will link to lonely.md any more");
    expect(html).toContain("text-emerald-700");
  });

  it("lists errors and offers no checkboxes once applied", () => {
    const failed = { ...plan, errors: ["a.md cannot move to b.md: exists"] };
    const html = renderToStaticMarkup(<PlanView plan={failed} checklist={failed} rejected={new Set()} />);
    expect(html).toContain("Cannot apply");
    expect(html).not.toContain('type="checkbox"');
  });
});
