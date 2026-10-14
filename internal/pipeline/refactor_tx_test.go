package pipeline

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/kiwifs/kiwifs/internal/refactor"
	"github.com/kiwifs/kiwifs/internal/search"
	"github.com/kiwifs/kiwifs/internal/storage"
	"github.com/kiwifs/kiwifs/internal/versioning"
)

// snapshotTree returns every file under dir except .git and .kiwi/state,
// so two snapshots compare the workspace byte for byte.
func snapshotTree(t *testing.T, dir string) map[string]string {
	t.Helper()
	out := map[string]string{}
	err := filepath.WalkDir(dir, func(abs string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(dir, abs)
		rel = filepath.ToSlash(rel)
		if d.IsDir() {
			if rel == ".git" || rel == ".kiwi/state" {
				return filepath.SkipDir
			}
			return nil
		}
		b, err := os.ReadFile(abs)
		if err != nil {
			return err
		}
		out[rel] = string(b)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func diffTrees(a, b map[string]string) []string {
	var out []string
	for k, v := range a {
		if w, ok := b[k]; !ok || w != v {
			out = append(out, k)
		}
	}
	for k := range b {
		if _, ok := a[k]; !ok {
			out = append(out, k)
		}
	}
	sort.Strings(out)
	return out
}

func gitPipeline(t *testing.T, async bool) (*Pipeline, string) {
	t.Helper()
	dir := t.TempDir()
	writeFixture(t, dir, map[string]string{
		"guides/old.md":                  "# Old\n\n[[intro]] and [rel](../index.md)\n",
		"guides/intro.md":                "# Intro\n",
		"faq/dup.md":                     "# Dup\n",
		"faq/keep.md":                    "# Keep\n",
		"index.md":                       "[[guides/old]] [[faq/dup]] [x](guides/old.md)\n",
		".kiwi/comments/faq/dup.md.json": `[{"id":"1","body":"dup comment"}]`,
		".me/progress.json":              `{"guides/old.md":{"done":true}}`,
	})
	g, err := versioning.NewGit(dir)
	if err != nil {
		t.Skipf("git unavailable: %v", err)
	}
	if err := g.BulkCommit(context.Background(), []string{"guides/old.md", "guides/intro.md", "faq/dup.md", "faq/keep.md", "index.md"}, "seed", "seed"); err != nil {
		t.Fatal(err)
	}
	var v versioning.Versioner = g
	if async {
		a := versioning.NewAsyncGit(g)
		t.Cleanup(func() { a.Close() })
		v = a
	}
	store, err := storage.NewLocal(dir)
	if err != nil {
		t.Fatal(err)
	}
	return New(store, v, search.NewGrep(dir), nil, nil, nil, dir), dir
}

func TestApplyThenRevertRestoresTheTreeByteForByte(t *testing.T) {
	for _, async := range []bool{false, true} {
		t.Run(map[bool]string{false: "git", true: "async"}[async], func(t *testing.T) {
			p, dir := gitPipeline(t, async)
			ctx := context.Background()
			before := snapshotTree(t, dir)

			m := &refactor.Manifest{
				Moves:           []refactor.Move{{From: "guides", To: "handbook/guides"}},
				Merges:          []refactor.Merge{{From: "faq/dup.md", Into: "faq/keep.md"}},
				DeleteEmptyDirs: true,
			}
			plan, res, err := p.Refactor(ctx, m, refactor.Options{Client: "test"}, "", "alice")
			if err != nil {
				t.Fatal(err)
			}
			if res.Commit == "" {
				t.Fatal("a git-backed refactor must report its commit")
			}
			rec, _ := versioning.AsRecorder(p.Versioner)
			msg, err := rec.CommitMessage(ctx, res.Commit)
			if err != nil {
				t.Fatal(err)
			}
			for _, want := range []string{"Kiwi-Actor: alice", "Kiwi-Client: test", "Kiwi-Refactor-Digest: " + plan.Digest, "Kiwi-Manifest: " + plan.ManifestHash} {
				if !strings.Contains(msg, want) {
					t.Errorf("commit message lacks %q:\n%s", want, msg)
				}
			}
			if _, err := os.Stat(filepath.Join(dir, filepath.FromSlash(journalPath))); !os.IsNotExist(err) {
				t.Fatal("journal must be gone after a successful apply")
			}
			if after := snapshotTree(t, dir); len(diffTrees(before, after)) == 0 {
				t.Fatal("refactor changed nothing")
			}

			rplan, err := p.PlanRevert(ctx, res.Commit)
			if err != nil {
				t.Fatal(err)
			}
			if len(rplan.Errors) > 0 {
				t.Fatalf("revert plan errors: %v", rplan.Errors)
			}
			if _, _, err := p.Revert(ctx, res.Commit, rplan.Digest, "test", "alice"); err != nil {
				t.Fatal(err)
			}
			if d := diffTrees(before, snapshotTree(t, dir)); len(d) > 0 {
				t.Fatalf("revert left differences in %v", d)
			}
		})
	}
}

func TestRevertRefusesToDiscardLaterEdits(t *testing.T) {
	p, dir := gitPipeline(t, false)
	ctx := context.Background()
	m := &refactor.Manifest{Moves: []refactor.Move{{From: "guides/old.md", To: "guides/new.md"}}}
	_, res, err := p.Refactor(ctx, m, refactor.Options{}, "", "a")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.Write(ctx, "index.md", []byte("edited later\n"), "b"); err != nil {
		t.Fatal(err)
	}
	plan, err := p.PlanRevert(ctx, res.Commit)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Errors) == 0 || !strings.Contains(strings.Join(plan.Errors, "\n"), "index.md has changed since") {
		t.Fatalf("errors = %v", plan.Errors)
	}
	if got := readFile(t, dir, "index.md"); got != "edited later\n" {
		t.Fatalf("index.md = %q", got)
	}
	if _, err := p.PlanRevert(ctx, "--output=/tmp/x"); err == nil {
		t.Fatal("option-like commit ids must be refused")
	}
}

type failingCommit struct{ *versioning.Noop }

func (failingCommit) CommitRecorded(context.Context, []string, string, string) (string, error) {
	return "", errors.New("pre-commit hook rejected it")
}
func (failingCommit) Head(context.Context) (string, error)                   { return "", nil }
func (failingCommit) ChangedFiles(context.Context, string) ([]string, error) { return nil, nil }
func (failingCommit) FileAt(context.Context, string, string) ([]byte, bool, error) {
	return nil, false, nil
}
func (failingCommit) CommitMessage(context.Context, string) (string, error) { return "", nil }

func TestFailedCommitRollsEverythingBack(t *testing.T) {
	p, dir := refactorFixture(t)
	p.Versioner = failingCommit{versioning.NewNoop()}
	before := snapshotTree(t, dir)
	m := &refactor.Manifest{Moves: []refactor.Move{{From: "old", To: "new"}}, DeleteEmptyDirs: true}
	_, _, err := p.Refactor(context.Background(), m, refactor.Options{}, "", "t")
	if err == nil || !strings.Contains(err.Error(), "pre-commit hook") {
		t.Fatalf("err = %v", err)
	}
	if d := diffTrees(before, snapshotTree(t, dir)); len(d) > 0 {
		t.Fatalf("rollback left differences in %v", d)
	}
}

// failOn makes one storage write fail, to exercise rollback.
type failOn struct {
	storage.Storage
	path string
}

func (f failOn) Write(ctx context.Context, path string, content []byte) error {
	if path == f.path {
		return errors.New("disk full")
	}
	return f.Storage.Write(ctx, path, content)
}

func TestFailedWriteRollsBackPagesAndSideFiles(t *testing.T) {
	p, dir := refactorFixture(t)
	before := snapshotTree(t, dir)
	p.Store = failOn{Storage: p.Store, path: "old/page.md"}
	// index.md is relinked (written) before the failing write of old/page.md
	// would happen, so rollback has real work to do.
	writeFixture(t, dir, map[string]string{})
	m := &refactor.Manifest{Moves: []refactor.Move{{From: "old/_index.md", To: "old/page.md"}, {From: "old/page.md", To: "zz/page.md"}}}
	_, _, err := p.Refactor(context.Background(), m, refactor.Options{}, "", "t")
	if err == nil || !strings.Contains(err.Error(), "disk full") {
		t.Fatalf("err = %v", err)
	}
	if d := diffTrees(before, snapshotTree(t, dir)); len(d) > 0 {
		t.Fatalf("rollback left differences in %v", d)
	}
}

func TestFailedSideFileRollsBackPages(t *testing.T) {
	p, dir := refactorFixture(t)
	before := snapshotTree(t, dir)
	// A directory where the state file should be makes the side write fail.
	if err := os.Remove(filepath.Join(dir, ".me/progress.json")); err != nil {
		t.Fatal(err)
	}
	plan, err := p.PlanRefactor(context.Background(), &refactor.Manifest{Moves: []refactor.Move{{From: "old/page.md", To: "new/page.md"}}}, refactor.Options{})
	if err != nil {
		t.Fatal(err)
	}
	// Re-create the original state file, then block its path for the write.
	plan.Ops.Side = append(plan.Ops.Side, refactor.SideWrite{Path: ".me/progress.json/x", Content: []byte("{}")})
	writeFixture(t, dir, map[string]string{".me/progress.json": before[".me/progress.json"]})
	if _, err := p.ApplyRefactor(context.Background(), plan, "t"); err == nil {
		t.Fatal("expected the side write to fail")
	}
	if d := diffTrees(before, snapshotTree(t, dir)); len(d) > 0 {
		t.Fatalf("rollback left differences in %v", d)
	}
}

func TestRecoverRefactorRollsBackAnInterruptedApply(t *testing.T) {
	p, dir := refactorFixture(t)
	before := snapshotTree(t, dir)
	ctx := context.Background()
	plan, err := p.PlanRefactor(ctx, &refactor.Manifest{Moves: []refactor.Move{{From: "old/page.md", To: "new/page.md"}}}, refactor.Options{})
	if err != nil {
		t.Fatal(err)
	}
	// Do what ApplyRefactor does up to the crash: journal, then writes.
	tx := &refactorTx{p: p, ctx: ctx}
	for _, w := range plan.Ops.Writes {
		tx.capturePage(w.Path)
	}
	for _, d := range plan.Ops.Deletes {
		tx.capturePage(d.Path)
	}
	for _, s := range plan.Ops.Side {
		tx.captureSide(s.Path)
	}
	if err := tx.writeJournal(plan.Digest, "t", "", journalApplying); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.applyPages(plan.Ops); err != nil {
		t.Fatal(err)
	}
	for _, s := range plan.Ops.Side {
		if err := applySideWrite(dir, s); err != nil {
			t.Fatal(err)
		}
	}
	if len(diffTrees(before, snapshotTree(t, dir))) == 0 {
		t.Fatal("the simulated crash changed nothing")
	}

	if err := p.RecoverRefactor(ctx); err != nil {
		t.Fatal(err)
	}
	if d := diffTrees(before, snapshotTree(t, dir)); len(d) > 0 {
		t.Fatalf("recovery left differences in %v", d)
	}
	if _, err := os.Stat(filepath.Join(dir, filepath.FromSlash(journalPath))); !os.IsNotExist(err) {
		t.Fatal("journal must be removed after recovery")
	}
}

func TestRevertWithoutUndoRecordFallsBackToGit(t *testing.T) {
	p, dir := gitPipeline(t, false)
	ctx := context.Background()
	before := snapshotTree(t, dir)
	m := &refactor.Manifest{Moves: []refactor.Move{{From: "guides/old.md", To: "guides/new.md"}}}
	_, res, err := p.Refactor(ctx, m, refactor.Options{}, "", "a")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(filepath.Join(dir, filepath.FromSlash(undoDir))); err != nil {
		t.Fatal(err)
	}
	plan, _, err := p.Revert(ctx, res.Commit, "", "test", "a")
	if err != nil {
		t.Fatalf("revert: %v (errors %v)", err, plan.Errors)
	}
	// Side files are not in git: without the undo record the progress
	// entry keeps the new path; every page is restored.
	after := snapshotTree(t, dir)
	for _, d := range diffTrees(before, after) {
		if d != ".me/progress.json" {
			t.Errorf("page %s differs after a git-only revert", d)
		}
	}
}

func TestRefactorGuards(t *testing.T) {
	p, dir := refactorFixture(t)
	writeFixture(t, dir, map[string]string{
		"log.md": "---\nappend_only: true\n---\n- saw [[old/page]]\n",
	})
	plan, err := p.PlanRefactor(context.Background(), &refactor.Manifest{Moves: []refactor.Move{{From: "old/page.md", To: "new/page.md"}}}, refactor.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Errors) == 0 || !strings.Contains(plan.Errors[0], "log.md is append-only") {
		t.Fatalf("errors = %v", plan.Errors)
	}
	// Moving the append-only page itself is fine: its bytes do not change.
	plan, err = p.PlanRefactor(context.Background(), &refactor.Manifest{Moves: []refactor.Move{{From: "log.md", To: "logs/log.md"}}}, refactor.Options{})
	if err != nil || len(plan.Errors) > 0 {
		t.Fatalf("err = %v, errors = %v", err, plan.Errors)
	}

	p.ValidateWrite = func(_ context.Context, path string, _ []byte, _ WriteKind) error {
		if strings.HasPrefix(path, "strict/") {
			return errors.New("strict/ pages need a status")
		}
		return nil
	}
	plan, err = p.PlanRefactor(context.Background(), &refactor.Manifest{Moves: []refactor.Move{{From: "old/page.md", To: "strict/page.md"}}}, refactor.Options{})
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, e := range plan.Errors {
		found = found || strings.Contains(e, "strict/ pages need a status")
	}
	if !found || plan.Digest != "" {
		t.Fatalf("errors = %v", plan.Errors)
	}
}

func TestRawRenameIsLoggedAndRepairedByRelinks(t *testing.T) {
	p, dir := refactorFixture(t)
	ctx := context.Background()
	// A WebDAV client renames a page: no relinking.
	if _, err := p.Rename(ctx, "old/page.md", "pages/page.md", "webdav"); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, dir, "index.md"); got != "[[old/page|Page]] [[old/_index|Old]]\n" {
		t.Fatalf("a raw rename must not relink: %q", got)
	}
	m, moves, err := p.RawMoveFix(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(moves) != 1 || m == nil || len(m.Relinks) != 1 || m.Relinks[0].To != "pages/page.md" {
		t.Fatalf("moves = %+v manifest = %+v", moves, m)
	}
	if _, _, err := p.Refactor(ctx, m, refactor.Options{}, "", "t"); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, dir, "index.md"); got != "[[pages/page|Page]] [[old/_index|Old]]\n" {
		t.Fatalf("index.md = %q", got)
	}
	if left, _ := p.RawMoves(); len(left) != 0 {
		t.Fatalf("the repaired move should leave the log: %+v", left)
	}
}

func TestWatcherPairsAMoveMadeOnDisk(t *testing.T) {
	p, dir := gitPipeline(t, false)
	ctx := context.Background()
	if err := os.MkdirAll(filepath.Join(dir, "elsewhere"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Join(dir, "guides/old.md"), filepath.Join(dir, "elsewhere/old.md")); err != nil {
		t.Fatal(err)
	}
	content, _ := os.ReadFile(filepath.Join(dir, "elsewhere/old.md"))
	// fsnotify reports the removal and the creation; order varies.
	p.Observe(ctx, "elsewhere/old.md", content, "fswatch")
	p.ObserveDelete(ctx, "guides/old.md", "fswatch")
	moves, err := p.RawMoves()
	if err != nil {
		t.Fatal(err)
	}
	if len(moves) != 1 || moves[0].From != "guides/old.md" || moves[0].To != "elsewhere/old.md" || moves[0].Via != "watcher" {
		t.Fatalf("moves = %+v", moves)
	}
	m, _, err := p.RawMoveFix(ctx)
	if err != nil || m == nil {
		t.Fatalf("fix = %+v, %v", m, err)
	}
	plan, err := p.PlanRefactor(ctx, m, refactor.Options{})
	if err != nil || len(plan.Errors) > 0 {
		t.Fatalf("plan: %v %v", err, plan.Errors)
	}
	found := false
	for _, w := range plan.Ops.Writes {
		found = found || w.Path == "index.md" && strings.Contains(string(w.Content), "elsewhere/old")
	}
	if !found {
		t.Fatalf("the fix should relink index.md: %v", plan.Edits)
	}
}

func TestSplitIsPlanOnlyUntilConfirmedAndReverts(t *testing.T) {
	p, dir := gitPipeline(t, false)
	ctx := context.Background()
	writeFixture(t, dir, map[string]string{"guides/intro.md": "# Intro\n\n## One\n\nfirst\n\n## Two\n\nsecond\n"})
	if err := p.Versioner.BulkCommit(ctx, []string{"guides/intro.md"}, "seed", "seed"); err != nil {
		t.Fatal(err)
	}
	before := snapshotTree(t, dir)
	m := &refactor.Manifest{Split: []refactor.Split{{From: "guides/intro.md"}}}
	if _, _, err := p.Refactor(ctx, m, refactor.Options{}, "", "t"); !errors.Is(err, ErrPlanInvalid) || !strings.Contains(err.Error(), "confirm: true") {
		t.Fatalf("an unconfirmed split must not apply: %v", err)
	}
	m.Split[0].Confirm = true
	_, res, err := p.Refactor(ctx, m, refactor.Options{}, "", "t")
	if err != nil {
		t.Fatal(err)
	}
	if readFile(t, dir, "guides/intro/two.md") != "# Two\n\nsecond\n" {
		t.Fatalf("two.md = %q", readFile(t, dir, "guides/intro/two.md"))
	}
	if _, _, err := p.Revert(ctx, res.Commit, "", "t", "t"); err != nil {
		t.Fatal(err)
	}
	if d := diffTrees(before, snapshotTree(t, dir)); len(d) > 0 {
		t.Fatalf("revert left differences in %v", d)
	}
}

func TestFrontmatterFieldOwnership(t *testing.T) {
	p, dir := refactorFixture(t)
	ctx := context.Background()
	writeFixture(t, dir, map[string]string{"task.md": "---\ntitle: T\n---\nbody\n"})

	if _, err := p.PatchFrontmatterAs(ctx, "task.md", map[string]any{"status": "doing"}, "", "a", "agent-a", false); err != nil {
		t.Fatal(err)
	}
	// Another agent may set its own keys, and may restate A's value...
	if _, err := p.PatchFrontmatterAs(ctx, "task.md", map[string]any{"reviewer": "bob", "status": "doing"}, "", "b", "agent-b", false); err != nil {
		t.Fatal(err)
	}
	// ...but not change it.
	_, err := p.PatchFrontmatterAs(ctx, "task.md", map[string]any{"status": "done"}, "", "b", "agent-b", false)
	var fc *FieldConflictError
	if !errors.As(err, &fc) || len(fc.Conflicts) != 1 || fc.Conflicts[0] != (FieldConflict{Key: "status", Manager: "agent-a"}) {
		t.Fatalf("err = %v", err)
	}
	if got := readFile(t, dir, "task.md"); !strings.Contains(got, "status: doing") {
		t.Fatalf("a refused patch wrote: %q", got)
	}
	// A manifest edit is held to the same rule unless it forces.
	m := &refactor.Manifest{Edits: []refactor.Edit{{Select: refactor.Selector{Paths: []string{"task.md"}}, Set: map[string]any{"status": "blocked"}}}}
	plan, _, err := p.Refactor(ctx, m, refactor.Options{Actor: "agent-b"}, "", "agent-b")
	if !errors.Is(err, ErrPlanInvalid) || len(plan.Rejected) != 1 || !strings.Contains(plan.Rejected[0].Error, "managed by agent-a") {
		t.Fatalf("err = %v rejected = %+v", err, plan.Rejected)
	}
	m.Edits[0].Force = true
	if _, _, err := p.Refactor(ctx, m, refactor.Options{Actor: "agent-b"}, "", "agent-b"); err != nil {
		t.Fatal(err)
	}
	owners, _ := p.FieldOwners(ctx, "task.md")
	if owners["status"].Manager != "agent-b" || owners["reviewer"].Manager != "agent-b" {
		t.Fatalf("owners = %+v", owners)
	}
	// A person rewrites the page: B's ownership of status is stale.
	if _, err := p.Write(ctx, "task.md", []byte("---\ntitle: T\nstatus: review\nreviewer: bob\n---\nbody\n"), "human"); err != nil {
		t.Fatal(err)
	}
	if _, err := p.PatchFrontmatterAs(ctx, "task.md", map[string]any{"status": "done"}, "", "a", "agent-a", false); err != nil {
		t.Fatalf("stale ownership must not block: %v", err)
	}
	// Ownership follows the page when it moves.
	if _, _, err := p.RenameWithLinks(ctx, "task.md", "tasks/task.md", "t", true); err != nil {
		t.Fatal(err)
	}
	if owners, _ := p.FieldOwners(ctx, "tasks/task.md"); owners["status"].Manager != "agent-a" || owners["reviewer"].Manager != "agent-b" {
		t.Fatalf("owners after move = %+v", owners)
	}
}
