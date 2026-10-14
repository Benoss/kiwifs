import { describe, expect, it } from "vitest";
import type { RefactorPlan } from "./api";
import { beforeAfter, changeKey, formatManifest, parseManifest, pathTree, withoutRejected } from "./refactorManifest";

const plan = (over: Partial<RefactorPlan> = {}): RefactorPlan => ({
  digest: "d1",
  moves: [],
  merges: [],
  edits: [],
  stats: { pages: 0, links: 0, rewritten: 0, unresolved: 0 },
  ...over,
});

describe("refactor manifests", () => {
  it("reads YAML and JSON, and refuses anything but a mapping", () => {
    expect(parseManifest("moves:\n  - {from: a.md, to: b.md}\n")).toEqual({ moves: [{ from: "a.md", to: "b.md" }] });
    expect(parseManifest('{"merges":[{"from":"x.md","into":"y.md"}]}')).toEqual({ merges: [{ from: "x.md", into: "y.md" }] });
    expect(() => parseManifest("- just a list")).toThrow(/mapping/);
    expect(parseManifest(formatManifest({ moves: [{ from: "a", to: "b/" }] }))).toEqual({ moves: [{ from: "a", to: "b/" }] });
  });

  it("spells out the accepted moves when one file of a folder move is rejected", () => {
    const manifest = { moves: [{ from: "drafts/", to: "archive/" }], delete_empty_dirs: true };
    const p = plan({
      moves: [
        { from: "drafts/a.md", to: "archive/a.md" },
        { from: "drafts/b.md", to: "archive/b.md" },
      ],
    });
    const out = withoutRejected(manifest, p, new Set([changeKey(p.moves[1])]));
    expect(out).toEqual({ moves: [{ from: "drafts/a.md", to: "archive/a.md" }], delete_empty_dirs: true });
  });

  it("drops rejected merges and the move_to templates whose moves are now explicit", () => {
    const manifest = {
      merges: [{ from: "x.md", into: "y.md" }, { from: "z.md", into: "y.md" }],
      edits: [
        { select: { glob: "inbox/*" }, move_to: "archive/{{slug}}.md", set: { status: "archived" } },
        { select: { glob: "tmp/*" }, move_to: "{{slug}}.md" },
      ],
    };
    const p = plan({
      moves: [
        { from: "inbox/a.md", to: "archive/a.md" },
        { from: "tmp/t.md", to: "t.md" },
      ],
      merges: [
        { from: "x.md", to: "y.md" },
        { from: "z.md", to: "y.md" },
      ],
    });
    const out = withoutRejected(manifest, p, new Set([changeKey(p.merges[0]), changeKey(p.moves[1])]));
    expect(out.merges).toEqual([{ from: "z.md", into: "y.md" }]);
    expect(out.moves).toEqual([{ from: "inbox/a.md", to: "archive/a.md" }]);
    expect(out.edits).toEqual([{ select: { glob: "inbox/*" }, set: { status: "archived" } }]);
  });

  it("builds the before and after trees", () => {
    const p = plan({ moves: [{ from: "a/x.md", to: "b/c/x.md" }], merges: [{ from: "a/y.md", to: "b/z.md" }] });
    expect(beforeAfter(p)).toEqual({ before: ["a/x.md", "a/y.md"], after: ["b/c/x.md"] });
    const tree = pathTree(["b/c/x.md", "b/y.md"]);
    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe("b");
    expect(tree[0].children.map((c) => c.name)).toEqual(["c", "y.md"]);
    expect(tree[0].children[1].file).toBe(true);
  });
});
