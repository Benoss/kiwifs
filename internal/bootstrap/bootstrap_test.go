package bootstrap

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kiwifs/kiwifs/internal/config"
	"github.com/kiwifs/kiwifs/internal/markdown"
	"github.com/kiwifs/kiwifs/internal/versioning"
)

func newCfg(strategy, engine string) *config.Config {
	return &config.Config{
		Versioning: config.VersioningConfig{Strategy: strategy},
		Search:     config.SearchConfig{Engine: engine},
	}
}

// Build must produce a server and wire every required component — the
// fields the HTTP handlers and alt-protocol servers reach for must not
// be nil when their corresponding feature is on.
func TestBuildWithGrepAndNoop(t *testing.T) {
	dir := t.TempDir()
	stack, err := Build("default", dir, newCfg("none", "grep"))
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	defer stack.Close()

	if stack.Server == nil {
		t.Fatal("Server is nil")
	}
	if stack.Pipeline == nil {
		t.Fatal("Pipeline is nil")
	}
	if stack.Searcher == nil {
		t.Fatal("Searcher is nil")
	}
	if _, ok := stack.Versioner.(*versioning.Noop); !ok {
		t.Fatalf("Versioner = %T, want *versioning.Noop", stack.Versioner)
	}
	if stack.Vectors != nil {
		t.Fatal("Vectors should be nil when [search.vector] is disabled")
	}
}

// Git versioning should succeed when the binary is available; if it
// isn't, skip (the missing-git fallback is tested separately).
func TestBuildWithGit(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not on PATH")
	}
	dir := t.TempDir()
	stack, err := Build("default", dir, newCfg("git", "grep"))
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	defer stack.Close()

	if _, ok := stack.Versioner.(*versioning.AsyncGit); !ok {
		t.Fatalf("Versioner = %T, want *versioning.AsyncGit (async is default for git)", stack.Versioner)
	}
	// NewGit runs `git init` when .git is missing — verify it did.
	if _, err := os.Stat(filepath.Join(dir, ".git")); err != nil {
		t.Fatalf(".git not created: %v", err)
	}
}

// CoW versioning must honour config.Versioning.MaxVersions. The pre-
// bootstrap copy of this wiring in spaces.AddSpace silently dropped this
// setting; the refactor's main behaviour fix depends on it being applied
// through the single Build path.
func TestBuildCowAppliesMaxVersions(t *testing.T) {
	dir := t.TempDir()
	cfg := newCfg("cow", "grep")
	cfg.Versioning.MaxVersions = 7

	stack, err := Build("default", dir, cfg)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	defer stack.Close()

	cow, ok := stack.Versioner.(*versioning.Cow)
	if !ok {
		t.Fatalf("Versioner = %T, want *versioning.Cow", stack.Versioner)
	}
	if cow.MaxVersions != 7 {
		t.Fatalf("MaxVersions = %d, want 7", cow.MaxVersions)
	}
}

// When strategy=git but git is missing, Build must not fail — the server
// still has to come up, just without versioning.
func TestBuildDegradesWhenGitMissing(t *testing.T) {
	t.Setenv("PATH", "")
	dir := t.TempDir()

	stack, err := Build("default", dir, newCfg("git", "grep"))
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	defer stack.Close()

	if _, ok := stack.Versioner.(*versioning.Noop); !ok {
		t.Fatalf("Versioner = %T, want *versioning.Noop after git-unavailable fallback", stack.Versioner)
	}
}

// SQLite FTS is the production default — it must wire through Build and
// plug into the Linker interface (the SQLite searcher implements both).
func TestBuildWithSQLiteSearchWiresLinker(t *testing.T) {
	dir := t.TempDir()
	stack, err := Build("default", dir, newCfg("none", "sqlite"))
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	defer stack.Close()

	if stack.Linker == nil {
		t.Fatal("Linker is nil — SQLite searcher should satisfy links.Linker")
	}
}

// Auto-sequence FormatWrite must wire through Build when sqlite search and
// [format_hooks.auto_sequence] are configured.
func TestBuildWiresAutoSequenceFormatHook(t *testing.T) {
	dir := t.TempDir()
	cfg := newCfg("none", "sqlite")
	cfg.FormatHooks.AutoSequence.Directory = "decisions/"
	cfg.FormatHooks.AutoSequence.Field = "adr_number"
	asyncOff := false
	cfg.Search.AsyncIndex = &asyncOff

	stack, err := Build("default", dir, cfg)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	defer stack.Close()

	if stack.Pipeline.FormatWrite == nil {
		t.Fatal("FormatWrite is nil with auto_sequence configured")
	}

	ctx := context.Background()
	if _, err := stack.Pipeline.Write(ctx, "decisions/seed.md", []byte("---\nadr_number: 2\n---\n# Seed\n"), "tester"); err != nil {
		t.Fatalf("seed write: %v", err)
	}
	if _, err := stack.Pipeline.Write(ctx, "decisions/next.md", []byte("---\ntitle: Next\n---\n# Next\n"), "tester"); err != nil {
		t.Fatalf("write: %v", err)
	}
	onDisk, err := stack.Store.Read(ctx, "decisions/next.md")
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	fm, err := markdown.Frontmatter(onDisk)
	if err != nil {
		t.Fatalf("frontmatter: %v", err)
	}
	if fm["adr_number"] != 3 {
		t.Fatalf("adr_number = %v, want 3", fm["adr_number"])
	}
}

// [sequences] directories must wire through Build so Append injects markers.
func TestBuildWiresSequenceDirsOnAppend(t *testing.T) {
	dir := t.TempDir()
	cfg := newCfg("none", "sqlite")
	cfg.Sequences.Directories = []string{"events/"}
	asyncOff := false
	cfg.Search.AsyncIndex = &asyncOff

	stack, err := Build("default", dir, cfg)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	defer stack.Close()

	ctx := context.Background()
	if _, err := stack.Pipeline.Append(ctx, "events/log.md", "first", "\n", "tester"); err != nil {
		t.Fatalf("append 1: %v", err)
	}
	if _, err := stack.Pipeline.Append(ctx, "events/log.md", "second", "\n", "tester"); err != nil {
		t.Fatalf("append 2: %v", err)
	}
	body, err := stack.Store.Read(ctx, "events/log.md")
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if !containsSeq(body, 1) || !containsSeq(body, 2) {
		t.Fatalf("missing seq markers: %q", string(body))
	}
}

func containsSeq(body []byte, n int64) bool {
	return strings.Contains(string(body), fmt.Sprintf("<!-- seq:%d -->", n))
}

// Close must be idempotent-safe for callers that defer it and then
// explicitly shut down. Double-close shouldn't panic or error loudly.
func TestStackCloseIsSafeToCallTwice(t *testing.T) {
	dir := t.TempDir()
	stack, err := Build("default", dir, newCfg("none", "sqlite"))
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	if err := stack.Close(); err != nil {
		t.Fatalf("first Close: %v", err)
	}
	// Second Close: searcher/vectors may error on already-closed handles,
	// which is fine — the point is that it doesn't panic.
	_ = stack.Close()
}

// Write rejection follows the space's [ui] typed_fences: a bare tag the UI
// renders as a code block must not fail a write, an explicit kiwi- spelling
// still does, and info-level suggestions never do.
func TestBuildRejectsWidgetErrorsPerTypedFenceSetting(t *testing.T) {
	bad := "```%s\nvalues: [1]\noffset: bad\n```\n"
	page := func(lang string) []byte {
		return []byte("---\ntitle: t\n---\n\n" + fmt.Sprintf(bad, lang))
	}
	ctx := context.Background()

	cfg := newCfg("none", "grep")
	on, err := Build("default", t.TempDir(), cfg)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	defer on.Close()
	if _, err := on.Pipeline.Write(ctx, "bare.md", page("array"), "tester"); err == nil {
		t.Fatal("a bare array with a type error should be rejected while typed fences are on")
	}
	live := []byte("---\ntitle: t\n---\n\n```widget:live\nrender(<ArrayView values={[1, 2]} />)\n```\n")
	if _, err := on.Pipeline.Write(ctx, "live.md", live, "tester"); err != nil {
		t.Fatalf("an info-level suggestion must not block a write: %v", err)
	}

	off := false
	cfg = newCfg("none", "grep")
	cfg.UI.TypedFences = &off
	stack, err := Build("default", t.TempDir(), cfg)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	defer stack.Close()
	if _, err := stack.Pipeline.Write(ctx, "bare.md", page("array"), "tester"); err != nil {
		t.Fatalf("typed_fences=false: a bare array is a code block, got %v", err)
	}
	if _, err := stack.Pipeline.Write(ctx, "strict.md", page("kiwi-array"), "tester"); err == nil {
		t.Fatal("an explicit kiwi-array is checked regardless of typed_fences")
	}
}
