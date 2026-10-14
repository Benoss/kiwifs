package pipeline

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kiwifs/kiwifs/internal/claims"
	"github.com/kiwifs/kiwifs/internal/refactor"
	"github.com/kiwifs/kiwifs/internal/search"
	"github.com/kiwifs/kiwifs/internal/storage"
	"github.com/kiwifs/kiwifs/internal/versioning"
)

func refactorFixture(t *testing.T) (*Pipeline, string) {
	t.Helper()
	dir := t.TempDir()
	files := map[string]string{
		"old/_index.md":     "[[old/page|Page]]\n",
		"old/page.md":       "# Page\n",
		"index.md":          "[[old/page|Page]] [[old/_index|Old]]\n",
		".me/progress.json": `{"old/page.md":{"done":true}}`,
	}
	for p, c := range files {
		abs := filepath.Join(dir, filepath.FromSlash(p))
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(abs, []byte(c), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	store, err := storage.NewLocal(dir)
	if err != nil {
		t.Fatal(err)
	}
	return New(store, versioning.NewNoop(), search.NewGrep(dir), nil, nil, nil, dir), dir
}

func buildRefactor(t *testing.T, p *Pipeline, dir, manifest string) *refactor.Plan {
	t.Helper()
	m, err := refactor.ParseManifest([]byte(manifest))
	if err != nil {
		t.Fatal(err)
	}
	plan, err := refactor.BuildPlan(context.Background(), refactor.Workspace{Root: dir, Store: p.Store}, m)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Errors) > 0 {
		t.Fatalf("plan errors: %v", plan.Errors)
	}
	return plan
}

func readFile(t *testing.T, dir, p string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(p)))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestApplyRefactorMovesRelinksAndMigratesState(t *testing.T) {
	p, dir := refactorFixture(t)
	plan := buildRefactor(t, p, dir, "moves:\n  - from: old\n    to: new/\ndelete_empty_dirs: true\n")
	if refactor.ETag([]byte("x")) != ETag([]byte("x")) {
		t.Fatal("refactor.ETag and pipeline.ETag disagree")
	}

	res, err := p.ApplyRefactor(context.Background(), plan, "test")
	if err != nil {
		t.Fatal(err)
	}
	if res.Written != 3 || res.Deleted != 2 || res.Dirs != 1 {
		t.Fatalf("result = %+v", res)
	}
	if got := readFile(t, dir, "index.md"); got != "[[new/page|Page]] [[new/_index|Old]]\n" {
		t.Fatalf("index.md = %q", got)
	}
	if got := readFile(t, dir, "new/_index.md"); got != "[[new/page|Page]]\n" {
		t.Fatalf("new/_index.md = %q", got)
	}
	if got := readFile(t, dir, ".me/progress.json"); got != `{"new/page.md":{"done":true}}` {
		t.Fatalf("progress = %q", got)
	}
	if _, err := os.Stat(filepath.Join(dir, "old")); !os.IsNotExist(err) {
		t.Fatalf("old folder still there: %v", err)
	}
}

func TestApplyRefactorRefusesAStalePlan(t *testing.T) {
	p, dir := refactorFixture(t)
	plan := buildRefactor(t, p, dir, "moves:\n  - from: old/page.md\n    to: new/page.md\n")
	if err := os.WriteFile(filepath.Join(dir, "index.md"), []byte("edited meanwhile\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := p.ApplyRefactor(context.Background(), plan, "test")
	if !errors.Is(err, ErrPlanStale) {
		t.Fatalf("err = %v, want ErrPlanStale", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "old/page.md")); err != nil {
		t.Fatal("a stale plan must not move anything")
	}
}

type failingStore struct {
	storage.Storage
	failOn string
}

func (s failingStore) Write(ctx context.Context, path string, content []byte) error {
	if path == s.failOn {
		return errors.New("disk full")
	}
	return s.Storage.Write(ctx, path, content)
}

func TestApplyRefactorRestoresPagesWhenAWriteFails(t *testing.T) {
	p, dir := refactorFixture(t)
	plan := buildRefactor(t, p, dir, "moves:\n  - from: old/page.md\n    to: new/page.md\n")
	before := readFile(t, dir, "index.md")
	p.Store = failingStore{Storage: p.Store, failOn: "old/_index.md"}

	if _, err := p.ApplyRefactor(context.Background(), plan, "test"); err == nil {
		t.Fatal("expected the failing write to abort the refactor")
	}
	if got := readFile(t, dir, "index.md"); got != before {
		t.Fatalf("index.md not restored: %q", got)
	}
	if _, err := os.Stat(filepath.Join(dir, "new/page.md")); !os.IsNotExist(err) {
		t.Fatal("new/page.md should have been rolled back")
	}
	if _, err := os.Stat(filepath.Join(dir, "old/page.md")); err != nil {
		t.Fatal("old/page.md must still exist")
	}
}

func writeFixture(t *testing.T, dir string, files map[string]string) {
	t.Helper()
	for p, c := range files {
		abs := filepath.Join(dir, filepath.FromSlash(p))
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(abs, []byte(c), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func TestRenameWithLinksUsesTheRefactorEngine(t *testing.T) {
	p, dir := refactorFixture(t)
	writeFixture(t, dir, map[string]string{
		"guide.md": "[md](old/page.md) [[page]] `[[page]]`\n~~~\n[[page]]\n~~~\n",
	})
	res, updated, err := p.RenameWithLinks(context.Background(), "old/page.md", "new/renamed.md", "test", true)
	if err != nil {
		t.Fatal(err)
	}
	if res.Path != "new/renamed.md" || res.ETag == "" {
		t.Fatalf("result = %+v", res)
	}
	if got := readFile(t, dir, "guide.md"); got != "[md](new/renamed.md) [[renamed]] `[[page]]`\n~~~\n[[page]]\n~~~\n" {
		t.Fatalf("guide.md = %q", got)
	}
	if got := readFile(t, dir, ".me/progress.json"); got != `{"new/renamed.md":{"done":true}}` {
		t.Fatalf("personal state did not follow the page: %s", got)
	}
	want := map[string]bool{"guide.md": true, "index.md": true, "old/_index.md": true}
	if len(updated) != len(want) {
		t.Fatalf("updated = %v", updated)
	}
	for _, u := range updated {
		if !want[u] {
			t.Fatalf("unexpected relinked page %s", u)
		}
	}
}

func TestRenameWithLinksRefusesToOverwrite(t *testing.T) {
	p, dir := refactorFixture(t)
	_, _, err := p.RenameWithLinks(context.Background(), "old/page.md", "index.md", "test", true)
	if !errors.Is(err, ErrPlanInvalid) {
		t.Fatalf("err = %v, want ErrPlanInvalid", err)
	}
	if got := readFile(t, dir, "index.md"); got != "[[old/page|Page]] [[old/_index|Old]]\n" {
		t.Fatalf("destination changed: %q", got)
	}
}

func TestRenameWithoutLinksLeavesReferences(t *testing.T) {
	p, dir := refactorFixture(t)
	if _, _, err := p.RenameWithLinks(context.Background(), "old/page.md", "elsewhere.md", "test", false); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, dir, "index.md"); got != "[[old/page|Page]] [[old/_index|Old]]\n" {
		t.Fatalf("update_links=false must not touch references: %q", got)
	}
	if got := readFile(t, dir, "elsewhere.md"); got != "# Page\n" {
		t.Fatalf("moved content = %q", got)
	}
}

func TestRenameDirWithLinksFixesRelativeLinksInsideTheFolder(t *testing.T) {
	p, dir := refactorFixture(t)
	writeFixture(t, dir, map[string]string{
		"old/sub/deep.md": "[up](../page.md) [root](../../index.md)\n",
	})
	res, err := p.RenameDirWithLinks(context.Background(), "old", "archive/2026/old", "test", true)
	if err != nil {
		t.Fatal(err)
	}
	if res.Renamed != 3 {
		t.Fatalf("renamed = %d", res.Renamed)
	}
	if got := readFile(t, dir, "archive/2026/old/sub/deep.md"); got != "[up](../page.md) [root](../../../../index.md)\n" {
		t.Fatalf("deep.md = %q", got)
	}
	if got := readFile(t, dir, "index.md"); got != "[[archive/2026/old/page|Page]] [[archive/2026/old/_index|Old]]\n" {
		t.Fatalf("index.md = %q", got)
	}
	if _, err := os.Stat(filepath.Join(dir, "old")); !os.IsNotExist(err) {
		t.Fatalf("source folder should be gone: %v", err)
	}
	if len(res.UpdatedLinks) != 1 || res.UpdatedLinks[0] != "index.md" {
		t.Fatalf("updated = %v", res.UpdatedLinks)
	}
}

func TestRenameDirRejectsMovingIntoItself(t *testing.T) {
	p, _ := refactorFixture(t)
	if _, err := p.RenameDir(context.Background(), "old", "old/inner", "test"); err == nil {
		t.Fatal("moving a folder into itself must fail")
	}
}

func TestRefactorDigestMismatchReturnsFreshPlan(t *testing.T) {
	p, _ := refactorFixture(t)
	m := &refactor.Manifest{Moves: []refactor.Move{{From: "old/page.md", To: "new.md"}}}
	plan, _, err := p.Refactor(context.Background(), m, refactor.Options{}, "deadbeef", "test")
	if !errors.Is(err, ErrDigestMismatch) || plan == nil || plan.Digest == "" {
		t.Fatalf("err = %v, plan = %+v", err, plan)
	}
	if _, _, err := p.Refactor(context.Background(), m, refactor.Options{}, plan.Digest, "test"); err != nil {
		t.Fatal(err)
	}
}

func TestPatchFrontmatterIsPinnedToWhatItRead(t *testing.T) {
	p, dir := refactorFixture(t)
	writeFixture(t, dir, map[string]string{"fm.md": "---\ntitle: T\n---\nbody\n"})
	if _, err := p.PatchFrontmatter(context.Background(), "fm.md", map[string]any{"status": "done"}, "", "t"); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, dir, "fm.md"); got != "---\ntitle: T\nstatus: done\n---\nbody\n" {
		t.Fatalf("fm.md = %q", got)
	}
	if _, err := p.PatchFrontmatter(context.Background(), "fm.md", map[string]any{"status": "x"}, "stale", "t"); !errors.Is(err, ErrConflict) {
		t.Fatalf("err = %v, want ErrConflict", err)
	}
}

func TestBulkWriteIfMatch(t *testing.T) {
	p, dir := refactorFixture(t)
	files := []struct {
		Path    string
		Content []byte
	}{{Path: "a.md", Content: []byte("a\n")}, {Path: "index.md", Content: []byte("x\n")}}
	if _, err := p.BulkWriteIfMatch(context.Background(), files, map[string]string{"index.md": "stale"}, "t", ""); !errors.Is(err, ErrConflict) {
		t.Fatalf("err = %v, want ErrConflict", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "a.md")); !os.IsNotExist(err) {
		t.Fatal("nothing may be written when a precondition fails")
	}
	cur := ETag([]byte(readFile(t, dir, "index.md")))
	if _, err := p.BulkWriteIfMatch(context.Background(), files, map[string]string{"index.md": cur}, "t", ""); err != nil {
		t.Fatal(err)
	}
}

func TestRefactorMovesClaimsAndRespectsOtherHolders(t *testing.T) {
	p, dir := refactorFixture(t)
	store, err := claims.NewStoreFromRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	p.Claims = store
	ctx := context.Background()
	if _, err := store.Claim(ctx, "old/page.md", "alice", time.Hour); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Claim(ctx, "index.md", "bob", time.Hour); err != nil {
		t.Fatal(err)
	}
	m := &refactor.Manifest{Moves: []refactor.Move{{From: "old/page.md", To: "new/page.md"}}}

	plan, _, err := p.Refactor(ctx, m, refactor.Options{}, "", "carol")
	if !errors.Is(err, ErrPlanInvalid) || !strings.Contains(plan.Errors[0], "claimed by alice") {
		t.Fatalf("err = %v, errors = %v", err, plan.Errors)
	}

	plan, _, err = p.Refactor(ctx, m, refactor.Options{}, "", "alice")
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Warnings) != 1 || !strings.Contains(plan.Warnings[0], "index.md is claimed by bob") {
		t.Fatalf("warnings = %v", plan.Warnings)
	}
	c, err := store.ActiveClaim(ctx, "new/page.md")
	if err != nil || c == nil || c.ClaimedBy != "alice" {
		t.Fatalf("claim did not follow the page: %+v %v", c, err)
	}
	if c, _ := store.ActiveClaim(ctx, "old/page.md"); c != nil {
		t.Fatalf("old claim left behind: %+v", c)
	}
}

func TestCaseOnlyRenameKeepsThePage(t *testing.T) {
	p, dir := refactorFixture(t)
	writeFixture(t, dir, map[string]string{"Notes.md": "# Notes\n", "ref.md": "[[Notes]]\n"})
	if _, _, err := p.RenameWithLinks(context.Background(), "Notes.md", "notes.md", "t", true); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	if got := readFile(t, dir, "notes.md"); got != "# Notes\n" {
		t.Fatalf("notes.md = %q (dir: %v)", got, names)
	}
	for _, n := range names {
		if n == "Notes.md" {
			t.Fatalf("old spelling still listed: %v", names)
		}
	}
	// Wiki links match case-insensitively, so this one still lands firmly.
	if got := readFile(t, dir, "ref.md"); got != "[[Notes]]\n" {
		t.Fatalf("ref.md = %q", got)
	}
}

func TestSwapAndChainApply(t *testing.T) {
	p, dir := refactorFixture(t)
	writeFixture(t, dir, map[string]string{"a.md": "A\n", "b.md": "B\n", "c.md": "C\n", "i.md": "[[a]] [[b]] [[c]]\n"})
	m := &refactor.Manifest{Moves: []refactor.Move{{From: "a.md", To: "b.md"}, {From: "b.md", To: "a.md"}}}
	if _, _, err := p.Refactor(context.Background(), m, refactor.Options{}, "", "t"); err != nil {
		t.Fatal(err)
	}
	if readFile(t, dir, "a.md") != "B\n" || readFile(t, dir, "b.md") != "A\n" || readFile(t, dir, "i.md") != "[[b]] [[a]] [[c]]\n" {
		t.Fatalf("swap: a=%q b=%q i=%q", readFile(t, dir, "a.md"), readFile(t, dir, "b.md"), readFile(t, dir, "i.md"))
	}
	m = &refactor.Manifest{Moves: []refactor.Move{{From: "a.md", To: "b.md"}, {From: "b.md", To: "c.md"}, {From: "c.md", To: "d.md"}}}
	if _, _, err := p.Refactor(context.Background(), m, refactor.Options{}, "", "t"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "a.md")); !os.IsNotExist(err) {
		t.Fatal("a.md should be gone after the chain")
	}
	if readFile(t, dir, "b.md") != "B\n" || readFile(t, dir, "c.md") != "A\n" || readFile(t, dir, "d.md") != "C\n" {
		t.Fatalf("chain: b=%q c=%q d=%q", readFile(t, dir, "b.md"), readFile(t, dir, "c.md"), readFile(t, dir, "d.md"))
	}
}

func TestSwapMovesCommentsWithTheirPages(t *testing.T) {
	p, dir := refactorFixture(t)
	writeFixture(t, dir, map[string]string{
		"a.md": "A\n", "b.md": "B\n",
		".kiwi/comments/a.md.json": `[{"id":"ca","body":"on a"}]`,
		".kiwi/comments/b.md.json": `[{"id":"cb","body":"on b"}]`,
	})
	m := &refactor.Manifest{Moves: []refactor.Move{{From: "a.md", To: "b.md"}, {From: "b.md", To: "a.md"}}}
	if _, _, err := p.Refactor(context.Background(), m, refactor.Options{}, "", "t"); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, dir, ".kiwi/comments/b.md.json"); !strings.Contains(got, "on a") || strings.Contains(got, "on b") {
		t.Fatalf("b.md comments = %s", got)
	}
	if got := readFile(t, dir, ".kiwi/comments/a.md.json"); !strings.Contains(got, "on b") || strings.Contains(got, "on a") {
		t.Fatalf("a.md comments = %s", got)
	}
}

func TestApplyReportsProgress(t *testing.T) {
	p, dir := refactorFixture(t)
	var calls [][2]int
	ctx := WithProgress(context.Background(), func(done, total int) { calls = append(calls, [2]int{done, total}) })
	if _, _, err := p.Refactor(ctx, &refactor.Manifest{Moves: []refactor.Move{{From: "old", To: "new"}}}, refactor.Options{}, "", "t"); err != nil {
		t.Fatal(err)
	}
	_ = dir
	if len(calls) == 0 || calls[len(calls)-1][0] != calls[len(calls)-1][1] {
		t.Fatalf("progress = %v", calls)
	}
}
