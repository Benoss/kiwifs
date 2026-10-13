package refactor

import (
	"sort"
	"strings"
	"testing"
	"unicode/utf16"
)

// applyLSP applies text edits addressed in LSP positions (UTF-16 columns).
func applyLSP(t *testing.T, src string, edits []TextEdit) string {
	t.Helper()
	lines := strings.SplitAfter(src, "\n")
	offset := func(p Position) int {
		off := 0
		for i := 0; i < p.Line; i++ {
			off += len(lines[i])
		}
		units := 0
		for i, r := range lines[p.Line] {
			if units >= p.Character {
				return off + i
			}
			units += len(utf16.Encode([]rune{r}))
		}
		return off + len(lines[p.Line])
	}
	sort.Slice(edits, func(i, j int) bool { return offset(edits[i].Range.Start) > offset(edits[j].Range.Start) })
	for _, e := range edits {
		s, en := offset(e.Range.Start), offset(e.Range.End)
		src = src[:s] + e.NewText + src[en:]
	}
	return src
}

func TestWorkspaceEditRoundTrips(t *testing.T) {
	dir := writeTree(t, map[string]string{
		"a.md":      "# A — 日本 🙂 [b](b.md)\n",
		"b.md":      "# B\n",
		"index.md":  "Ünïcode 🙂 [[a]] and [b](b.md) twice [b](b.md)\n",
		"dup.md":    "# Dup\n",
		"keeper.md": "# Keeper\n",
	})
	p := plan(t, dir, "moves: [{from: b.md, to: docs/b.md}]\nmerges: [{from: dup.md, into: keeper.md}]")
	requireNoErrors(t, p)
	we := p.WorkspaceEdit(dir)
	if we.KiwiDigest != p.Digest || !we.ChangeAnnotations[annotationID].NeedsConfirmation {
		t.Fatalf("annotation = %+v", we.ChangeAnnotations)
	}
	var kinds []string
	for _, c := range we.DocumentChanges {
		k := c.Kind
		if k == "" {
			k = "edit:" + RelPath(dir, c.TextDocument.URI)
			src := map[string]string{"edit:index.md": "Ünïcode 🙂 [[a]] and [b](b.md) twice [b](b.md)\n", "edit:a.md": "# A — 日本 🙂 [b](b.md)\n"}[k]
			want := map[string]string{"edit:index.md": written(t, p, "index.md"), "edit:a.md": written(t, p, "a.md")}[k]
			if got := applyLSP(t, src, c.Edits); got != want {
				t.Fatalf("%s: applying the LSP edits gives %q, want %q", k, got, want)
			}
		} else if k == "rename" {
			k += ":" + RelPath(dir, c.OldURI) + ">" + RelPath(dir, c.NewURI)
		} else {
			k += ":" + RelPath(dir, c.URI)
		}
		kinds = append(kinds, k)
	}
	if strings.Join(kinds, " ") != "rename:b.md>docs/b.md edit:a.md edit:index.md delete:dup.md" {
		t.Fatalf("document changes = %v", kinds)
	}

	pre := p.PreRenameEdits(dir)
	if len(pre.Changes) != 2 || len(pre.Changes[FileURI(dir, "index.md")]) == 0 {
		t.Fatalf("pre-rename edits = %+v", pre.Changes)
	}

	m, ignored, err := ManifestFromWorkspaceEdit(dir, we)
	if err != nil || len(m.Moves) != 1 || m.Moves[0] != (Move{From: "b.md", To: "docs/b.md"}) || len(ignored) == 0 {
		t.Fatalf("import = %+v, %v, %v", m, ignored, err)
	}
}
