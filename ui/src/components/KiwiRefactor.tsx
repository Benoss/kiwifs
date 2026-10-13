import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  FolderTree,
  Link2,
  Loader2,
  RotateCcw,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  ApiError,
  api,
  type RefactorApplied,
  type RefactorManifest,
  type RefactorPending,
  type RefactorPlan,
  type RefactorRawMove,
} from "@kw/lib/api";
import {
  beforeAfter,
  changeKey,
  formatManifest,
  parseManifest,
  pathTree,
  withoutRejected,
  type TreeNode,
} from "@kw/lib/refactorManifest";
import { Button } from "@kw/components/ui/button";
import { ScrollArea } from "@kw/components/ui/scroll-area";

type Props = {
  onClose: () => void;
  /** Called after a restructuring or an undo landed, to refresh the tree. */
  onApplied?: () => void;
  /** Opens the review with this manifest already planned. */
  initialManifest?: string;
};

const EXAMPLE = `# Moves, merges, edits — planned, reviewed, applied as one commit.
moves:
  - from: drafts/
    to: archive/drafts/
merges: []
delete_empty_dirs: true
`;

/** The plan a failed apply or approve sends back in its body, if any. */
function planFromError(e: unknown): { message: string; plan?: RefactorPlan } {
  if (e instanceof ApiError) {
    try {
      const body = JSON.parse(e.body) as { error?: string; message?: string; plan?: RefactorPlan };
      return { message: body.error ?? body.message ?? e.message, plan: body.plan };
    } catch {
      return { message: e.body || e.message };
    }
  }
  return { message: String(e) };
}

export function KiwiRefactor({ onClose, onApplied, initialManifest }: Props) {
  const [text, setText] = useState(initialManifest ?? EXAMPLE);
  // base is the plan of the manifest as written: its moves and merges are
  // the checklist. manifest/plan are what applying would do — base minus
  // whatever the reviewer unchecked, planned again for its own digest.
  const [base, setBase] = useState<{ manifest: RefactorManifest; plan: RefactorPlan } | null>(null);
  const [manifest, setManifest] = useState<RefactorManifest | null>(null);
  const [plan, setPlan] = useState<RefactorPlan | null>(null);
  const [rejected, setRejected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<"plan" | "apply" | "approve" | "undo" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<RefactorApplied | null>(null);
  const [reviewing, setReviewing] = useState<RefactorPending | null>(null);
  const [pending, setPending] = useState<RefactorPending[]>([]);
  const [rawMoves, setRawMoves] = useState<{ moves: RefactorRawMove[]; manifest: RefactorManifest | null }>({
    moves: [],
    manifest: null,
  });

  const loadInbox = useCallback(() => {
    api.refactorPending().then((r) => setPending(r.pending ?? [])).catch(() => setPending([]));
    api
      .refactorRawMoves()
      .then((r) => setRawMoves({ moves: r.moves ?? [], manifest: r.manifest }))
      .catch(() => setRawMoves({ moves: [], manifest: null }));
  }, []);

  useEffect(() => {
    loadInbox();
  }, [loadInbox]);

  const runPlan = useCallback(async (m: RefactorManifest, asBase: boolean) => {
    setBusy("plan");
    setError(null);
    setApplied(null);
    try {
      const p = await api.refactorPlan(m);
      if (asBase) setBase({ manifest: m, plan: p });
      setManifest(m);
      setPlan(p);
    } catch (e) {
      setPlan(null);
      setError(planFromError(e).message);
    } finally {
      setBusy(null);
    }
  }, []);

  const planText = useCallback(
    (source: string) => {
      let m: RefactorManifest;
      try {
        m = parseManifest(source);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPlan(null);
        return;
      }
      setRejected(new Set());
      void runPlan(m, true);
    },
    [runPlan],
  );

  useEffect(() => {
    if (initialManifest) planText(initialManifest);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const open = (m: RefactorManifest, from: RefactorPending | null) => {
    const source = formatManifest(m);
    setText(source);
    setReviewing(from);
    planText(source);
  };

  // Unchecking an item rewrites the manifest and plans it again, so the
  // digest that gets applied is always the digest of what is on screen.
  const toggle = (k: string) => {
    if (!base) return;
    const next = new Set(rejected);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setRejected(next);
    setReviewing(null);
    const m = next.size === 0 ? base.manifest : withoutRejected(base.manifest, base.plan, next);
    setText(formatManifest(m));
    void runPlan(m, false);
  };

  const apply = async () => {
    if (!plan || !manifest) return;
    setBusy("apply");
    setError(null);
    try {
      const m = plan.now && !manifest.now ? { ...manifest, now: plan.now } : manifest;
      const res = await api.refactorApply(m, plan.digest);
      setApplied(res.applied);
      setPlan(res.plan);
      onApplied?.();
      loadInbox();
    } catch (e) {
      const { message, plan: fresh } = planFromError(e);
      setError(message);
      if (fresh) setPlan(fresh);
    } finally {
      setBusy(null);
    }
  };

  const approve = async () => {
    if (!plan || !manifest || !reviewing) return;
    setBusy("approve");
    setError(null);
    try {
      await api.refactorApprove(manifest, plan.digest);
      setReviewing(null);
      loadInbox();
    } catch (e) {
      setError(planFromError(e).message);
    } finally {
      setBusy(null);
    }
  };

  const undo = async () => {
    if (!applied?.commit) return;
    setBusy("undo");
    setError(null);
    try {
      const preview = (await api.refactorRevert(applied.commit, { dryRun: true })) as RefactorPlan;
      if (preview.errors?.length) {
        setError(preview.errors.join("\n"));
        return;
      }
      await api.refactorRevert(applied.commit, { digest: preview.digest });
      setApplied(null);
      setPlan(null);
      onApplied?.();
    } catch (e) {
      setError(planFromError(e).message);
    } finally {
      setBusy(null);
    }
  };

  const blocked = !plan || (plan.errors?.length ?? 0) > 0 || busy !== null || applied !== null;
  const writes =
    (plan?.moves.length ?? 0) + (plan?.edits.length ?? 0) + (plan?.content_edits?.length ?? 0) + (plan?.merges.length ?? 0);

  return (
    <div className="flex flex-col h-full">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 sm:px-8 py-3 border-b border-border">
        <div className="flex items-center gap-2 min-w-0">
          <FolderTree className="h-4 w-4 text-muted-foreground shrink-0" />
          <div className="text-sm font-medium">Restructure</div>
          <span className="text-xs text-muted-foreground hidden sm:inline">
            Plan, review and apply moves, merges and edits as one commit. Links are kept.
          </span>
        </div>
        <Button variant="outline" size="sm" onClick={onClose}>
          <X className="h-3.5 w-3.5" /> Close
        </Button>
      </div>

      <div className="flex-1 min-h-0 flex flex-col sm:flex-row">
        <aside className="w-full sm:w-96 shrink-0 border-b sm:border-b-0 sm:border-r border-border flex flex-col">
          {pending.length > 0 && (
            <section className="border-b border-border p-3 space-y-2" aria-label="Waiting for approval">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Waiting for your approval</div>
              {pending.map((p) => (
                <button
                  key={p.digest}
                  type="button"
                  onClick={() => open(p.manifest, p)}
                  className="w-full text-left rounded-md px-3 py-2 text-xs hover:bg-accent/60 border border-border"
                >
                  <div className="font-medium text-foreground">{p.actor} wants to restructure</div>
                  <div className="text-muted-foreground">{p.reason}</div>
                </button>
              ))}
            </section>
          )}
          {rawMoves.manifest && rawMoves.moves.length > 0 && (
            <section className="border-b border-border p-3 space-y-2" aria-label="Moves outside KiwiFS">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Moved outside KiwiFS</div>
              <p className="text-xs text-muted-foreground">
                {rawMoves.moves.length} {rawMoves.moves.length === 1 ? "file was" : "files were"} moved without
                updating the links to {rawMoves.moves.length === 1 ? "it" : "them"} (WebDAV, NFS or on disk).
              </p>
              <Button size="sm" variant="outline" onClick={() => open(rawMoves.manifest!, null)}>
                <Link2 className="h-3.5 w-3.5" /> Review the fix
              </Button>
            </section>
          )}
          <div className="flex-1 min-h-0 flex flex-col p-3 gap-2">
            <label htmlFor="kiwi-refactor-manifest" className="text-xs uppercase tracking-wide text-muted-foreground">
              Manifest (YAML or JSON)
            </label>
            <textarea
              id="kiwi-refactor-manifest"
              className="flex-1 min-h-48 w-full rounded-md border border-border bg-background p-2 font-mono text-xs"
              spellCheck={false}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setReviewing(null);
              }}
            />
            <Button size="sm" onClick={() => planText(text)} disabled={busy !== null}>
              {busy === "plan" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} Plan
            </Button>
          </div>
        </aside>

        <ScrollArea className="flex-1 kiwi-scroll">
          <div className="p-4 sm:p-6 space-y-5 text-sm">
            {error && (
              <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs whitespace-pre-wrap">
                {error}
              </div>
            )}
            {!plan && !error && (
              <p className="text-muted-foreground text-sm">
                Write a manifest and plan it. Nothing changes until you apply.
              </p>
            )}
            {plan && (
              <PlanView
                plan={plan}
                checklist={applied ? plan : (base?.plan ?? plan)}
                rejected={rejected}
                onToggle={applied ? undefined : toggle}
              />
            )}
          </div>
        </ScrollArea>
      </div>

      {plan && (
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 sm:px-8 py-3 border-t border-border text-xs">
          <span className="text-muted-foreground font-mono">
            plan {plan.digest || "—"} · {writes} changes
          </span>
          <div className="flex items-center gap-2">
            {applied ? (
              <>
                <span className="text-foreground">
                  <Check className="inline h-3.5 w-3.5" /> Applied{applied.commit ? ` in ${applied.commit.slice(0, 8)}` : ""}
                </span>
                {applied.commit && (
                  <Button size="sm" variant="outline" onClick={undo} disabled={busy !== null}>
                    <RotateCcw className="h-3.5 w-3.5" /> Undo
                  </Button>
                )}
              </>
            ) : reviewing ? (
              <Button size="sm" onClick={approve} disabled={blocked}>
                <ShieldCheck className="h-3.5 w-3.5" /> Approve for {reviewing.actor}
              </Button>
            ) : (
              <Button size="sm" onClick={apply} disabled={blocked}>
                {busy === "apply" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} Apply
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function PlanView({
  plan,
  checklist,
  rejected,
  onToggle,
}: {
  plan: RefactorPlan;
  /** The plan of the manifest as written, whose moves can be unchecked. */
  checklist: RefactorPlan;
  rejected: ReadonlySet<string>;
  onToggle?: (key: string) => void;
}) {
  const { before, after } = useMemo(() => beforeAfter(plan), [plan]);
  return (
    <>
      {(plan.errors?.length ?? 0) > 0 && (
        <section aria-label="Errors" className="space-y-1">
          <h3 className="text-xs uppercase tracking-wide text-destructive">Cannot apply</h3>
          <ul className="list-disc pl-5 text-xs space-y-0.5">
            {plan.errors!.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </section>
      )}
      {(plan.warnings?.length ?? 0) > 0 && (
        <section aria-label="Warnings" className="space-y-1">
          <h3 className="text-xs uppercase tracking-wide text-amber-600 dark:text-amber-400">
            <AlertTriangle className="inline h-3.5 w-3.5" /> Check before applying
          </h3>
          <ul className="list-disc pl-5 text-xs space-y-0.5">
            {plan.warnings!.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </section>
      )}
      {plan.approval?.required && (
        <p className="text-xs rounded-md border border-border p-2">
          Agents need a person's approval for this plan: {plan.approval.reason}.
        </p>
      )}

      {(before.length > 0 || after.length > 0) && (
        <section aria-label="Before and after" className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <h3 className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Before</h3>
            <Tree nodes={pathTree(before)} />
          </div>
          <div>
            <h3 className="text-xs uppercase tracking-wide text-muted-foreground mb-1">After</h3>
            <Tree nodes={pathTree(after)} />
          </div>
        </section>
      )}

      {(checklist.moves.length > 0 || checklist.merges.length > 0) && (
        <section aria-label="Moves and merges" className="space-y-1">
          <h3 className="text-xs uppercase tracking-wide text-muted-foreground">
            {plan.moves.length} moves, {plan.merges.length} merges
            {rejected.size > 0 ? ` (${rejected.size} left out)` : ""}
          </h3>
          <ul className="space-y-0.5">
            {[
              ...checklist.moves.map((m) => ({ ...m, merge: false })),
              ...checklist.merges.map((m) => ({ ...m, merge: true })),
            ].map(
              (m) => {
                const k = changeKey(m);
                return (
                  <li key={k} className="flex items-center gap-2 text-xs font-mono">
                    {onToggle && (
                      <input
                        type="checkbox"
                        aria-label={`Include ${m.from}`}
                        checked={!rejected.has(k)}
                        onChange={() => onToggle(k)}
                      />
                    )}
                    <span className="truncate">{m.from}</span>
                    <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                    <span className="truncate">{m.to}</span>
                    {m.merge && <span className="text-muted-foreground font-sans">(merge)</span>}
                  </li>
                );
              },
            )}
          </ul>
        </section>
      )}

      {plan.edits.length > 0 && (
        <section aria-label="Relinked pages" className="space-y-1">
          <h3 className="text-xs uppercase tracking-wide text-muted-foreground">
            {plan.stats.rewritten} links rewritten in {plan.edits.length} pages
          </h3>
          {plan.edits.map((e) => (
            <details key={e.path} className="text-xs">
              <summary className="cursor-pointer font-mono">
                {e.path} <span className="text-muted-foreground font-sans">({e.links.length})</span>
              </summary>
              <ul className="pl-5 font-mono text-[11px] text-muted-foreground">
                {e.links.map((l, i) => (
                  <li key={i}>
                    {l.line}: {l.old} → {l.new}
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </section>
      )}

      {(plan.content_edits?.length ?? 0) > 0 && (
        <section aria-label="Content edits" className="space-y-1">
          <h3 className="text-xs uppercase tracking-wide text-muted-foreground">
            {plan.content_edits!.length} pages edited
          </h3>
          <ul className="space-y-0.5 text-xs">
            {plan.content_edits!.map((e) => (
              <li key={e.path}>
                <span className="font-mono">{e.path}</span>
                <span className="text-muted-foreground"> — {e.changes.join(", ")}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {plan.integrity && (
        <p className="text-xs text-muted-foreground">
          Checked {plan.stats.links} links in {plan.stats.pages} pages. Every working link keeps its target
          {plan.integrity.unresolved > 0 ? `; ${plan.integrity.unresolved} already pointed nowhere` : ""}.
          {(plan.integrity.orphaned?.length ?? 0) > 0 &&
            ` No page will link to ${plan.integrity.orphaned!.join(", ")} any more.`}
        </p>
      )}

      {(plan.diffs?.length ?? 0) > 0 && (
        <section aria-label="Diffs" className="space-y-1">
          <h3 className="text-xs uppercase tracking-wide text-muted-foreground">Changes, file by file</h3>
          {plan.diffs!.filter((d) => d.diff).map((d) => (
            <details key={d.path} className="text-xs">
              <summary className="cursor-pointer font-mono">
                {d.from ? `${d.from} → ${d.path}` : d.path}
              </summary>
              <pre className="mt-1 overflow-x-auto rounded-md bg-muted p-2 text-[11px] leading-snug">
                {d.diff!.split("\n").map((line, i) => (
                  <div
                    key={i}
                    className={
                      line.startsWith("+") && !line.startsWith("+++")
                        ? "text-emerald-700 dark:text-emerald-400"
                        : line.startsWith("-") && !line.startsWith("---")
                          ? "text-rose-700 dark:text-rose-400"
                          : "text-muted-foreground"
                    }
                  >
                    {line || " "}
                  </div>
                ))}
              </pre>
            </details>
          ))}
        </section>
      )}
    </>
  );
}

function Tree({ nodes }: { nodes: TreeNode[] }) {
  if (nodes.length === 0) return <p className="text-xs text-muted-foreground">—</p>;
  return (
    <ul className="pl-3 text-xs font-mono">
      {nodes.map((n) => (
        <li key={n.path}>
          <span className={n.file ? "" : "text-muted-foreground"}>{n.file ? n.name : `${n.name}/`}</span>
          {n.children.length > 0 && <Tree nodes={n.children} />}
        </li>
      ))}
    </ul>
  );
}
