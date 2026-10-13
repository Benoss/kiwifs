package pipeline

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"

	"github.com/kiwifs/kiwifs/internal/claims"
	"github.com/kiwifs/kiwifs/internal/events"
	"github.com/kiwifs/kiwifs/internal/refactor"
	"github.com/kiwifs/kiwifs/internal/storage"
	"github.com/kiwifs/kiwifs/internal/versioning"
)

// ErrPlanStale is returned by ApplyRefactor when a file the plan read has
// changed since. Nothing has been written; build the plan again.
var ErrPlanStale = errors.New("plan is stale: a file changed since it was planned")

// ErrPlanInvalid is returned by Refactor when the plan has errors (a
// collision, a missing source, a link that cannot be kept). Nothing has been
// written; the plan returned alongside says why.
var ErrPlanInvalid = errors.New("refactor plan has errors")

// ErrDigestMismatch is returned by Refactor when the caller reviewed a plan
// whose digest no longer matches the workspace. Nothing has been written;
// the plan returned alongside is the fresh one to review instead.
var ErrDigestMismatch = errors.New("the workspace changed since the plan was reviewed")

// staleRetries bounds how often Refactor replans after losing a race with
// another writer when the caller did not pin a reviewed digest.
const staleRetries = 3

// RefactorWorkspace is what refactor.BuildPlan reads for this pipeline.
func (p *Pipeline) RefactorWorkspace() refactor.Workspace {
	return refactor.Workspace{Root: p.Root, Store: p.Store, TypedFields: p.TypedLinkFields}
}

// ClaimTracker is the part of the claims store restructuring needs: who
// holds which page, and moving those leases along with the pages.
type ClaimTracker interface {
	ListActive(ctx context.Context) ([]claims.Claim, error)
	Rename(ctx context.Context, renames map[string]string) error
}

// PlanRefactor builds the plan for m without writing anything. Active
// claims are loaded unless opts already carries them.
func (p *Pipeline) PlanRefactor(ctx context.Context, m *refactor.Manifest, opts refactor.Options) (*refactor.Plan, error) {
	if opts.Claims == nil && p.Claims != nil {
		active, err := p.Claims.ListActive(ctx)
		if err != nil {
			return nil, fmt.Errorf("list claims: %w", err)
		}
		opts.Claims = make(map[string]string, len(active))
		for _, c := range active {
			opts.Claims[c.Path] = c.ClaimedBy
		}
	}
	if opts.Select == nil && p.SelectPages != nil {
		opts.Select = func(ctx context.Context, query string) ([]string, error) {
			// Pages written through the pipeline a moment ago may still
			// be queued for indexing; let them land before selecting.
			if p.AsyncIdx != nil {
				p.AsyncIdx.Flush()
			}
			return p.SelectPages(ctx, query)
		}
	}
	plan, err := refactor.BuildPlanWith(ctx, p.RefactorWorkspace(), m, opts)
	if err != nil {
		return nil, err
	}
	p.checkRefactorGuards(ctx, plan)
	if rec, ok := versioning.AsRecorder(p.Versioner); ok {
		plan.Base, _ = rec.Head(ctx)
	}
	return plan, nil
}

// checkRefactorGuards applies the write rules a restructuring must not
// slip past. Content is never reformatted (FormatWrite): a move is the same
// bytes plus link splices. But a page that lands at a new path is validated
// there (ValidateWrite: a folder's schema rules apply to what moves in),
// and an append-only page may move but its text may not be rewritten.
func (p *Pipeline) checkRefactorGuards(ctx context.Context, plan *refactor.Plan) {
	if len(plan.Errors) > 0 {
		return
	}
	for _, w := range plan.Ops.Writes {
		if w.Source == "" {
			continue
		}
		prior, err := p.Store.Read(ctx, w.Source)
		if err != nil {
			continue
		}
		if isAppendOnly(prior) && !bytes.Equal(prior, w.Content) {
			plan.Reject(w.Source, fmt.Sprintf("%s is append-only, so its content cannot be rewritten; move or merge the pages it links to separately, or lift append_only first", w.Source))
		}
		if (w.Edited || w.Source != w.Path) && p.ValidateWrite != nil && storage.IsKnowledgeFile(w.Path) {
			if err := p.ValidateWrite(ctx, w.Path, w.Content, WriteKindPut); err != nil {
				what := "editing " + w.Source
				if w.Source != w.Path {
					what = fmt.Sprintf("moving %s to %s", w.Source, w.Path)
				}
				plan.Reject(w.Source, fmt.Sprintf("%s: %v", what, err))
			}
		}
		if w.Edited && p.ValidateTransition != nil {
			from, to := extractStatus(prior), extractStatus(w.Content)
			if from != "" && to != "" && from != to {
				if err := p.ValidateTransition(w.Path, from, to); err != nil {
					plan.Reject(w.Source, fmt.Sprintf("%s: status %s → %s: %v", w.Source, from, to, err))
				}
			}
		}
	}
	if len(plan.Errors) > 0 {
		plan.Ops = refactor.Ops{}
		plan.Digest = ""
	}
}

// Refactor plans m and applies it as one commit. With a digest, the plan
// must be exactly the one the caller reviewed: if the workspace moved on,
// nothing is applied and ErrDigestMismatch comes back with the fresh plan.
// Without one (a single rename, say), a plan that goes stale while waiting
// for the write lock is rebuilt and retried a few times.
func (p *Pipeline) Refactor(ctx context.Context, m *refactor.Manifest, opts refactor.Options, digest, actor string) (*refactor.Plan, RefactorResult, error) {
	if opts.Actor == "" {
		opts.Actor = actor
	}
	for attempt := 0; ; attempt++ {
		plan, err := p.PlanRefactor(ctx, m, opts)
		if err != nil {
			return nil, RefactorResult{}, err
		}
		if len(plan.Errors) > 0 {
			return plan, RefactorResult{}, fmt.Errorf("%w: %s", ErrPlanInvalid, strings.Join(plan.Errors, "; "))
		}
		if digest != "" && digest != plan.Digest {
			return plan, RefactorResult{}, ErrDigestMismatch
		}
		res, err := p.ApplyRefactor(ctx, plan, actor)
		if errors.Is(err, ErrPlanStale) && digest == "" && attempt < staleRetries {
			continue
		}
		return plan, res, err
	}
}

// RefactorResult reports what ApplyRefactor changed.
type RefactorResult struct {
	Written int `json:"written"`
	Deleted int `json:"deleted"`
	Side    int `json:"side_files"`
	Dirs    int `json:"removed_dirs"`
	// Commit is the commit the restructuring landed in, when the
	// versioner keeps history; pass it to the revert endpoints to undo.
	Commit string `json:"commit,omitempty"`
}

// ApplyRefactor carries out a plan as one change. Every precondition is
// checked inside the write lock before anything is touched; a journal of
// pre-images is written first so a crash mid-apply is rolled back on the
// next start (RecoverRefactor); pages and comment/personal-state files are
// then written, and everything lands in a single commit. If any write, side
// file or the commit itself fails, every touched file is restored and the
// error is returned: the workspace is either fully restructured and
// committed, or unchanged.
func (p *Pipeline) ApplyRefactor(ctx context.Context, plan *refactor.Plan, actor string) (RefactorResult, error) {
	if plan == nil || len(plan.Errors) > 0 {
		return RefactorResult{}, fmt.Errorf("plan has errors; nothing applied")
	}
	ops := plan.Ops
	actor = coalesce(actor)

	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	if err := ctx.Err(); err != nil {
		return RefactorResult{}, err
	}

	for _, w := range ops.Writes {
		if w.Source == "" {
			// A file the plan creates (a revert restoring a deleted page)
			// must still be absent.
			if p.Store.Exists(ctx, w.Path) {
				return RefactorResult{}, fmt.Errorf("%w (%s exists)", ErrPlanStale, w.Path)
			}
			continue
		}
		cur, err := p.Store.Read(ctx, w.Source)
		if err != nil || ETag(cur) != w.SourceETag {
			return RefactorResult{}, fmt.Errorf("%w (%s)", ErrPlanStale, w.Source)
		}
	}
	for _, d := range ops.Deletes {
		cur, err := p.Store.Read(ctx, d.Path)
		if err != nil || ETag(cur) != d.ETag {
			return RefactorResult{}, fmt.Errorf("%w (%s)", ErrPlanStale, d.Path)
		}
	}
	for _, sw := range ops.Side {
		if sw.Precondition == nil {
			continue
		}
		cur, existed := readSide(p.Root, sw.Path)
		if existed != sw.Precondition.Existed || existed && ETag(cur) != ETag(sw.Precondition.Content) {
			return RefactorResult{}, fmt.Errorf("%w (%s)", ErrPlanStale, sw.Path)
		}
	}

	tx := &refactorTx{p: p, ctx: ctx}
	for _, w := range ops.Writes {
		tx.capturePage(w.Path)
	}
	for _, d := range ops.Deletes {
		tx.capturePage(d.Path)
	}
	for _, sw := range ops.Side {
		tx.captureSide(sw.Path)
	}
	head := ""
	rec, recording := versioning.AsRecorder(p.Versioner)
	if recording {
		head, _ = rec.Head(ctx)
	}
	if err := tx.writeJournal(plan.Digest, actor, head, journalApplying); err != nil {
		return RefactorResult{}, fmt.Errorf("refactor journal: %w", err)
	}

	paths, err := tx.applyPages(ops)
	if err != nil {
		tx.rollback()
		return RefactorResult{}, err
	}
	for _, sw := range ops.Side {
		tx.touchedSide = append(tx.touchedSide, sw.Path)
		if err := applySideWrite(p.Root, sw); err != nil {
			tx.rollback()
			return RefactorResult{}, fmt.Errorf("%s: %w", sw.Path, err)
		}
	}

	msg := refactorMessage(plan, actor) + "\n\n" + refactorTrailers(plan, actor)
	var sha string
	if recording {
		sha, err = rec.CommitRecorded(ctx, paths, actor, msg)
	} else {
		err = p.Versioner.BulkCommit(ctx, paths, actor, msg)
	}
	if err != nil {
		tx.rollback()
		return RefactorResult{}, fmt.Errorf("commit: %w", err)
	}
	if err := tx.writeJournal(plan.Digest, actor, head, journalCommitted); err != nil {
		log.Printf("pipeline: ApplyRefactor journal: %v", err)
	}
	if sha != "" {
		if err := tx.writeUndo(sha, plan); err != nil {
			log.Printf("pipeline: ApplyRefactor undo record: %v", err)
		}
	}

	dirs := 0
	for _, d := range ops.Dirs {
		abs := p.Store.AbsPath(d)
		_ = os.Remove(filepath.Join(abs, ".DS_Store"))
		if err := os.Remove(abs); err == nil {
			dirs++
		}
	}
	tx.removeJournal()

	if p.Claims != nil {
		renames := map[string]string{}
		for _, mv := range plan.Moves {
			renames[mv.From] = mv.To
		}
		for _, mg := range plan.Merges {
			renames[mg.From] = ""
		}
		if err := p.Claims.Rename(ctx, renames); err != nil {
			log.Printf("pipeline: ApplyRefactor move claims: %v", err)
		}
	}

	for _, d := range ops.Deletes {
		p.deindexFile(ctx, d.Path)
	}
	for _, w := range ops.Writes {
		p.indexFile(ctx, w.Path, w.Content)
	}
	for _, d := range ops.Deletes {
		p.broadcast(events.Event{Op: "delete", Path: d.Path, Actor: actor})
		if p.OnDelete != nil {
			p.OnDelete(d.Path, actor)
		}
	}
	for _, w := range ops.Writes {
		p.broadcast(events.Event{Op: "write", Path: w.Path, Actor: actor, ETag: ETag(w.Content)})
	}
	if p.OnTransition != nil {
		for _, w := range ops.Writes {
			if !w.Edited {
				continue
			}
			if from, to := extractStatus(w.Prior), extractStatus(w.Content); from != "" && to != "" && from != to {
				p.OnTransition(w.Path, "status", from, to, actor)
			}
		}
	}

	return RefactorResult{Written: len(ops.Writes), Deleted: len(ops.Deletes), Side: len(ops.Side), Dirs: dirs, Commit: sha}, nil
}

// refactorTrailers are git trailers (git interpret-trailers) that make a
// restructuring commit findable and undoable: who ran it, through which
// client, the reviewed digest, what was asked for, and the HEAD it was
// planned against.
func refactorTrailers(plan *refactor.Plan, actor string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Kiwi-Actor: %s\n", NormalizeActor(actor))
	if client := NormalizeActor(plan.Client); client != "" {
		fmt.Fprintf(&b, "Kiwi-Client: %s\n", client)
	}
	fmt.Fprintf(&b, "%s: %s\n", trailerDigest, plan.Digest)
	if plan.ManifestHash != "" {
		fmt.Fprintf(&b, "Kiwi-Manifest: %s\n", plan.ManifestHash)
	}
	if plan.Base != "" {
		fmt.Fprintf(&b, "Kiwi-Base: %s\n", plan.Base)
	}
	if plan.Reverts != "" {
		fmt.Fprintf(&b, "Kiwi-Reverts: %s\n", plan.Reverts)
	}
	return strings.TrimRight(b.String(), "\n")
}

const trailerDigest = "Kiwi-Refactor-Digest"

func refactorMessage(plan *refactor.Plan, actor string) string {
	if plan.Reverts != "" {
		short := plan.Reverts
		if len(short) > 12 {
			short = short[:12]
		}
		return fmt.Sprintf("%s: revert %s (%d pages restored, %d removed)", actor, short, len(plan.Ops.Writes), len(plan.Ops.Deletes))
	}
	if len(plan.Moves) == 1 && len(plan.Merges) == 0 {
		mv := plan.Moves[0]
		msg := fmt.Sprintf("%s: rename %s → %s", actor, mv.From, mv.To)
		if relinked := len(plan.Edits); relinked > 0 {
			msg += fmt.Sprintf(" (updated links in %d pages)", relinked)
		}
		return msg
	}
	return fmt.Sprintf("%s: refactor %d moves, %d merges, %d pages relinked",
		actor, len(plan.Moves), len(plan.Merges), len(plan.Edits))
}

// applySideWrite writes or removes a comment or personal-state file. The
// write goes to a temp file and is renamed into place, so a reader never
// sees half a JSON document.
func applySideWrite(root string, s refactor.SideWrite) error {
	if root == "" {
		return fmt.Errorf("no workspace root")
	}
	clean := filepath.ToSlash(filepath.Clean(filepath.FromSlash(s.Path)))
	if !strings.HasPrefix(clean, ".kiwi/") && !strings.HasPrefix(clean, ".me/") || strings.Contains(clean, "..") {
		return fmt.Errorf("%w: %s is not a comment or personal-state file", storage.ErrPathDenied, s.Path)
	}
	abs := filepath.Join(root, filepath.FromSlash(clean))
	if s.Delete {
		if err := os.Remove(abs); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return err
	}
	tmp := abs + ".kiwi-tmp"
	if err := os.WriteFile(tmp, s.Content, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, abs)
}

// RefactorDropping is Refactor for bulk edits that should skip the pages
// that fail rather than fail the batch: while every error in the plan is
// about a single page (plan.Rejected), those pages are taken out of each
// edit's select.paths and the manifest is planned again. The pages left
// out come back with the reason; everything else lands in one commit.
// Only edits that select by paths can drop pages; any other error fails.
func (p *Pipeline) RefactorDropping(ctx context.Context, m *refactor.Manifest, opts refactor.Options, actor string) (*refactor.Plan, RefactorResult, map[string]string, error) {
	dropped := map[string]string{}
	for {
		plan, err := p.PlanRefactor(ctx, m, opts)
		if err != nil {
			return nil, RefactorResult{}, dropped, err
		}
		if len(plan.Errors) == 0 {
			break
		}
		if len(plan.Rejected) != len(plan.Errors) {
			return plan, RefactorResult{}, dropped, fmt.Errorf("%w: %s", ErrPlanInvalid, strings.Join(plan.Errors, "; "))
		}
		for _, r := range plan.Rejected {
			dropped[r.Path] = r.Error
		}
		if !dropPaths(m, dropped) {
			return plan, RefactorResult{}, dropped, fmt.Errorf("%w: %s", ErrPlanInvalid, strings.Join(plan.Errors, "; "))
		}
		if m.Empty() {
			return plan, RefactorResult{}, dropped, nil
		}
	}
	plan, res, err := p.Refactor(ctx, m, opts, "", actor)
	return plan, res, dropped, err
}

// dropPaths removes dropped pages from every edit's select.paths, and
// edits left selecting nothing. It reports whether anything was removed.
func dropPaths(m *refactor.Manifest, dropped map[string]string) bool {
	removed := false
	kept := m.Edits[:0]
	for _, e := range m.Edits {
		if len(e.Select.Paths) == 0 {
			kept = append(kept, e)
			continue
		}
		var paths []string
		for _, path := range e.Select.Paths {
			if _, ok := dropped[path]; ok {
				removed = true
				continue
			}
			paths = append(paths, path)
		}
		if len(paths) == 0 {
			continue
		}
		e.Select.Paths = paths
		kept = append(kept, e)
	}
	m.Edits = kept
	return removed
}
