import yaml from "js-yaml";
import type { RefactorManifest, RefactorPathChange, RefactorPlan } from "./api";

/** Parses a manifest written as YAML or JSON (JSON is YAML). */
export function parseManifest(text: string): RefactorManifest {
  const value = yaml.load(text);
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("A manifest is a mapping: moves, merges, edits, rename_tags, relinks…");
  }
  return value as RefactorManifest;
}

export function formatManifest(manifest: RefactorManifest): string {
  return yaml.dump(manifest, { lineWidth: 120, noRefs: true });
}

const key = (c: RefactorPathChange) => `${c.from}\u0000${c.to}`;

export function changeKey(c: RefactorPathChange): string {
  return key(c);
}

/**
 * Rewrites a manifest after the reviewer rejected some of the plan's moves
 * or merges. Rejecting one file of a folder or glob move means the move can
 * no longer be stated as a pattern, so the accepted moves are spelled out
 * one by one; everything else in the manifest is kept as written.
 */
export function withoutRejected(
  manifest: RefactorManifest,
  plan: RefactorPlan,
  rejected: ReadonlySet<string>,
): RefactorManifest {
  const out: RefactorManifest = { ...manifest };
  const movesRejected = plan.moves.some((m) => rejected.has(key(m)));
  if (movesRejected) {
    const kept = plan.moves.filter((m) => !rejected.has(key(m)));
    if (kept.length > 0) out.moves = kept.map((m) => ({ from: m.from, to: m.to }));
    else delete out.moves;
    // Computed moves (move_to) were part of the plan's moves: drop the
    // templates whose results are now listed or rejected explicitly.
    if (Array.isArray(out.edits)) {
      out.edits = (out.edits as Record<string, unknown>[])
        .map((e) => {
          const { move_to: _moveTo, on_conflict: _onConflict, ...rest } = e;
          return rest;
        })
        .filter((e) => Object.keys(e).some((k) => k !== "select" && k !== "when"));
      if ((out.edits as unknown[]).length === 0) delete out.edits;
    }
  }
  const mergesRejected = plan.merges.some((m) => rejected.has(key(m)));
  if (mergesRejected) {
    const kept = plan.merges.filter((m) => !rejected.has(key(m)));
    if (kept.length > 0) out.merges = kept.map((m) => ({ from: m.from, into: m.to }));
    else delete out.merges;
  }
  return out;
}

export type TreeNode = { name: string; path: string; children: TreeNode[]; file: boolean };

/** Builds a folder tree from paths, for the before/after view. */
export function pathTree(paths: string[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", children: [], file: false };
  for (const p of [...paths].sort()) {
    let node = root;
    const parts = p.split("/");
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join("/");
      let child = node.children.find((c) => c.name === part);
      if (!child) {
        child = { name: part, path, children: [], file: i === parts.length - 1 };
        node.children.push(child);
      }
      node = child;
    });
  }
  return root.children;
}

/** The paths the plan takes away and the ones it creates. */
export function beforeAfter(plan: RefactorPlan): { before: string[]; after: string[] } {
  return {
    before: [...plan.moves.map((m) => m.from), ...plan.merges.map((m) => m.from)],
    after: [...plan.moves.map((m) => m.to)],
  };
}
