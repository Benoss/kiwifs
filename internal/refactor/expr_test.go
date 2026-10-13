package refactor

import (
	"strings"
	"testing"
	"time"
)

func TestSlug(t *testing.T) {
	for in, want := range map[string]string{
		"Café Déjà Vu!":            "cafe-deja-vu",
		"  Hello,   World  ":       "hello-world",
		"Ünïcödé — and  more":      "unicode-and-more",
		"日本語のページ":                  "日本語のページ",
		"CON":                      "con-page",
		"":                         "untitled",
		"***":                      "untitled",
		"ﬁle ﬂow":                  "file-flow",
		strings.Repeat("ab ", 100): strings.TrimRight(strings.Repeat("ab-", 40), "-"),
	} {
		if got := Slug(in); got != want {
			t.Errorf("Slug(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestComputedMovesAreDeterministicAndSnapshotIsolated(t *testing.T) {
	dir := writeTree(t, map[string]string{
		"inbox/a.md":                  "---\ntitle: Weekly Sync\ndate: 2025-03-04\nstatus: draft\n---\n",
		"inbox/b.md":                  "---\ntitle: Weekly Sync\ndate: 2025-03-11\nstatus: draft\n---\n",
		"inbox/c.md":                  "---\ntitle: Old Notes\ndate: 2019-01-01\nstatus: done\n---\n",
		"archive/2025/weekly-sync.md": "# taken\n",
		"index.md":                    "[[inbox/a]] [[inbox/b]]\n",
	})
	manifest := `edits:
  - select: {glob: "inbox/*.md"}
    when: 'fm.status == "draft"'
    set: {status: archived}
    compute: {was: 'fm.status', slugged: 'slug(title)'}
    move_to: "archive/{{year}}/{{slug}}.md"
    on_conflict: suffix("-%d")
  - select: {glob: "inbox/*.md"}
    when: 'fm.status == "archived"'   # sees the snapshot: matches nothing
    set: {touched: true}
`
	now := time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC)
	p1 := planWith(t, dir, manifest, Options{Now: now})
	requireNoErrors(t, p1)
	p2 := planWith(t, dir, manifest, Options{Now: now})
	if p1.Digest != p2.Digest {
		t.Fatalf("same input, different digests: %s vs %s", p1.Digest, p2.Digest)
	}
	got := map[string]string{}
	for _, mv := range p1.Moves {
		got[mv.From] = mv.To
	}
	if got["inbox/a.md"] != "archive/2025/weekly-sync-2.md" || got["inbox/b.md"] != "archive/2025/weekly-sync-3.md" || len(got) != 2 {
		t.Fatalf("moves = %v", got)
	}
	a := written(t, p1, "archive/2025/weekly-sync-2.md")
	if !strings.Contains(a, "status: archived") || !strings.Contains(a, "was: draft") || !strings.Contains(a, "slugged: weekly-sync") || strings.Contains(a, "touched") {
		t.Fatalf("a = %q", a)
	}
	if got := written(t, p1, "index.md"); got != "[[archive/2025/weekly-sync-2]] [[archive/2025/weekly-sync-3]]\n" {
		t.Fatalf("index.md = %q", got)
	}
	if len(p1.Warnings) != 1 || !strings.Contains(p1.Warnings[0], "edits[1] selects no pages") {
		t.Fatalf("warnings = %v", p1.Warnings)
	}
	if p1.Now == nil || !p1.Now.Equal(now) {
		t.Fatalf("plan must record its clock, got %v", p1.Now)
	}
}

func TestComputedMoveConflictWithoutSuffixIsAnError(t *testing.T) {
	dir := writeTree(t, map[string]string{
		"a.md": "---\ntitle: Same\n---\n",
		"b.md": "---\ntitle: Same\n---\n",
	})
	p := plan(t, dir, `edits: [{select: {glob: "*.md"}, move_to: "{{slug}}.md"}]`)
	if len(p.Errors) == 0 || len(p.Conflicts) == 0 || p.Conflicts[0].Code != ConflictManyToOne {
		t.Fatalf("errors = %v conflicts = %+v", p.Errors, p.Conflicts)
	}
}

func TestExpressionErrorsRejectThePage(t *testing.T) {
	dir := writeTree(t, map[string]string{
		"a.md": "---\ndate: not a date\n---\n",
		"b.md": "---\ndate: 2024-05-01\n---\n",
	})
	p := plan(t, dir, `edits: [{select: {glob: "*.md"}, move_to: "{{year(fm.date)}}/"}]`)
	if len(p.Rejected) != 1 || p.Rejected[0].Path != "a.md" || len(p.Errors) != 1 {
		t.Fatalf("rejected = %+v errors = %v", p.Rejected, p.Errors)
	}
	bad := plan(t, dir, `edits: [{select: {glob: "*.md"}, when: "fm.status ==", set: {x: 1}}]`)
	if len(bad.Errors) == 0 || !strings.Contains(bad.Errors[0], "when:") {
		t.Fatalf("a syntax error must be reported: %v", bad.Errors)
	}
	escape := plan(t, dir, `edits: [{select: {paths: [b.md]}, move_to: "../{{stem}}.md"}]`)
	if len(escape.Errors) == 0 {
		t.Fatal("a computed path leaving the workspace must be rejected")
	}
}
