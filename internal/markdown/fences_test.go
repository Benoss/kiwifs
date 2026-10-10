package markdown

import (
	"strings"
	"testing"
)

func lintFenceSource(t *testing.T, body string) []LintIssue {
	t.Helper()
	var out []LintIssue
	for _, issue := range LintMarkdown([]byte(body)) {
		if issue.Rule == "fence-widget-invalid" {
			out = append(out, issue)
		}
	}
	return out
}

func TestWidgetFenceCatalogueLoads(t *testing.T) {
	fences, err := WidgetFences()
	if err != nil {
		t.Fatalf("catalogue: %v", err)
	}
	if len(fences) < 10 {
		t.Fatalf("expected the generated catalogue to hold every fence, got %d", len(fences))
	}
	for _, spec := range fences {
		if spec.Description == "" {
			t.Errorf("%s has no description", spec.Lang)
		}
		if spec.Example == "" {
			t.Errorf("%s has no example", spec.Lang)
		}
		if len(spec.Attributes) == 0 {
			t.Errorf("%s has no attributes", spec.Lang)
		}
	}
	top, step := WidgetFenceReserved()
	if len(top) == 0 || len(step) == 0 {
		t.Fatal("expected both reserved key sets to be present")
	}
}

func TestWidgetFenceLookupByAlias(t *testing.T) {
	bare, ok := WidgetFence("array")
	if !ok {
		t.Fatal("array not found")
	}
	for _, alias := range []string{"kiwi-array", "widget:array"} {
		got, ok := WidgetFence(alias)
		if !ok || got != bare {
			t.Errorf("%s did not resolve to the array spec", alias)
		}
	}
	if _, ok := WidgetFence("nope"); ok {
		t.Error("expected an unknown tag to miss")
	}
}

func TestEveryCatalogueExampleLintsClean(t *testing.T) {
	fences, err := WidgetFences()
	if err != nil {
		t.Fatal(err)
	}
	for _, spec := range fences {
		page := "---\ntitle: t\n---\n\n" + spec.Example + "\n"
		if issues := lintFenceSource(t, page); len(issues) != 0 {
			t.Errorf("%s example is not clean: %+v", spec.Lang, issues)
		}
	}
}

func TestLintWidgetFenceUnknownKey(t *testing.T) {
	page := "---\ntitle: t\n---\n\n```array\nvalues: [1, 2]\nactiveIndicies: [0]\n```\n"
	issues := lintFenceSource(t, page)
	if len(issues) != 1 {
		t.Fatalf("expected one issue, got %+v", issues)
	}
	if !strings.Contains(issues[0].Message, `did you mean "activeIndices"`) {
		t.Errorf("expected a suggestion, got %q", issues[0].Message)
	}
	if issues[0].Severity != "warning" {
		t.Errorf("a typo is a warning, not an error: %q", issues[0].Severity)
	}
	// Line 7 is where `activeIndicies:` is written.
	if issues[0].Line != 7 {
		t.Errorf("expected line 7, got %d", issues[0].Line)
	}
}

func TestLintWidgetFenceMissingRequired(t *testing.T) {
	page := "---\ntitle: t\n---\n\n```kiwi-table\nrows: []\n```\n"
	issues := lintFenceSource(t, page)
	if len(issues) != 1 || issues[0].Severity != "error" {
		t.Fatalf("expected one error, got %+v", issues)
	}
	if !strings.Contains(issues[0].Message, `missing required key "columns"`) {
		t.Errorf("unexpected message %q", issues[0].Message)
	}
}

func TestLintWidgetFenceRequiredMayArriveInAStep(t *testing.T) {
	// `bits` needs a `value`, and a walkthrough naturally introduces it in
	// step one rather than repeating it at the top.
	page := "---\ntitle: t\n---\n\n```bits\nbits: 4\nsteps:\n  - value: 1\n  - value: 5\n```\n"
	if issues := lintFenceSource(t, page); len(issues) != 0 {
		t.Fatalf("expected no issues, got %+v", issues)
	}
}

func TestLintWidgetFenceWrongType(t *testing.T) {
	page := "---\ntitle: t\n---\n\n```table\ncolumns: \"a, b\"\nrows: []\n```\n"
	issues := lintFenceSource(t, page)
	if len(issues) == 0 {
		t.Fatal("expected a type error")
	}
	if !strings.Contains(issues[0].Message, "must be array, got string") {
		t.Errorf("unexpected message %q", issues[0].Message)
	}
}

func TestLintWidgetFenceBadEnum(t *testing.T) {
	page := "---\ntitle: t\n---\n\n```graph\nnodes: [{id: A}]\nlayout: spiral\n```\n"
	issues := lintFenceSource(t, page)
	if len(issues) == 0 || !strings.Contains(issues[0].Message, "must be one of") {
		t.Fatalf("expected an enum error, got %+v", issues)
	}
}

func TestLintWidgetFenceStepCannotChangeFixedKey(t *testing.T) {
	page := "---\ntitle: t\n---\n\n```array\nvalues: [1]\nsteps:\n  - cellSize: 80\n```\n"
	issues := lintFenceSource(t, page)
	if len(issues) == 0 || !strings.Contains(issues[0].Message, "cannot change between steps") {
		t.Fatalf("expected a steppability error, got %+v", issues)
	}
}

func TestLintWidgetFenceAcceptsABareStepNote(t *testing.T) {
	page := "---\ntitle: t\n---\n\n```array\nvalues: [1]\nsteps:\n  - \"first\"\n  - \"second\"\n```\n"
	if issues := lintFenceSource(t, page); len(issues) != 0 {
		t.Fatalf("expected no issues, got %+v", issues)
	}
}

func TestLintWidgetFenceLeavesADirectoryListingAlone(t *testing.T) {
	// A bare ```tree holding a directory listing is a code block, not a widget.
	page := "---\ntitle: t\n---\n\n```tree\nsrc/\n  widgets/\n    ArrayView.tsx\n```\n"
	if issues := lintFenceSource(t, page); len(issues) != 0 {
		t.Fatalf("a directory listing must not be linted as a tree: %+v", issues)
	}
}

func TestLintWidgetFenceLeavesAPipeTableAlone(t *testing.T) {
	page := "---\ntitle: t\n---\n\n```table\n| a | b |\n|---|---|\n| 1 | 2 |\n```\n"
	if issues := lintFenceSource(t, page); len(issues) != 0 {
		t.Fatalf("a pipe table must not be linted as a table widget: %+v", issues)
	}
}

func TestLintWidgetFenceExplicitSpellingReportsSyntaxErrors(t *testing.T) {
	page := "---\ntitle: t\n---\n\n```kiwi-array\nvalues: [1,\n  bad: :\n```\n"
	issues := lintFenceSource(t, page)
	if len(issues) == 0 || issues[0].Severity != "error" {
		t.Fatalf("an explicit kiwi- fence asked to be checked: %+v", issues)
	}
	if !strings.Contains(issues[0].Message, "YAML parse error") {
		t.Errorf("unexpected message %q", issues[0].Message)
	}
}

func TestLintWidgetFenceBareSpellingDowngradesSyntaxErrors(t *testing.T) {
	page := "---\ntitle: t\n---\n\n```array\nvalues: [1,\n  bad: :\n```\n"
	issues := lintFenceSource(t, page)
	if len(issues) != 1 || issues[0].Severity != "warning" {
		t.Fatalf("a bare tag may be something else entirely: %+v", issues)
	}
}

func TestLintWidgetFenceSequenceKeepsItsOwnFrames(t *testing.T) {
	// `frames` is reserved for "one prop set per step" everywhere else, but
	// SequenceView has always called its alt/loop boxes frames.
	page := "---\ntitle: t\n---\n\n```sequence\nparticipants: [{id: A}, {id: B}]\nitems: [{from: A, to: B}]\nframes:\n  - {kind: alt, from: 0, to: 0}\n```\n"
	if issues := lintFenceSource(t, page); len(issues) != 0 {
		t.Fatalf("expected no issues, got %+v", issues)
	}
}

func TestLintWidgetFenceReservedKeysAreNotProps(t *testing.T) {
	page := "---\ntitle: t\n---\n\n```array id=a\nvalues: [1]\ncaption: hello\ncode: \"x = 1\"\nlang: python\nlink: other\n```\n"
	if issues := lintFenceSource(t, page); len(issues) != 0 {
		t.Fatalf("reserved keys must not be reported as unknown: %+v", issues)
	}
}

func TestLintWidgetFencePropsEscape(t *testing.T) {
	page := "---\ntitle: t\n---\n\n```table\ncolumns: [{key: a}]\nrows: []\nprops:\n  title: widget title\n```\n"
	if issues := lintFenceSource(t, page); len(issues) != 0 {
		t.Fatalf("expected no issues, got %+v", issues)
	}
}

func TestLintWidgetFenceIgnoresOtherFences(t *testing.T) {
	page := "---\ntitle: t\n---\n\n```python\nvalues = [1, 2]\n```\n\n```mermaid\nflowchart LR\n  A --> B\n```\n"
	if issues := lintFenceSource(t, page); len(issues) != 0 {
		t.Fatalf("expected no issues, got %+v", issues)
	}
}

func TestSummarizeWidgetFence(t *testing.T) {
	source := "values: [1, 2, 3]\ncaption: Two pointers meet\nactiveIndices: [0]\nsteps:\n  - note: lo moves right\n  - note: they cross\n"
	got := SummarizeWidgetFence("array", source)
	want := "Two pointers meet\nlo moves right\nthey cross"
	if got != want {
		t.Errorf("summary:\n got %q\nwant %q", got, want)
	}
	if strings.Contains(got, "activeIndices") {
		t.Error("coordinates must not reach the summary")
	}
}

func TestSummarizeWidgetFenceKeepsCode(t *testing.T) {
	source := "values: [1]\ncode: |\n  lo, hi = 0, 1\n"
	if got := SummarizeWidgetFence("array", source); !strings.Contains(got, "lo, hi = 0, 1") {
		t.Errorf("a code listing is prose a reader can act on: %q", got)
	}
}

func TestSummarizeWidgetFenceSkipsAnUnclaimedBody(t *testing.T) {
	if got := SummarizeWidgetFence("tree", "src/\n  widgets/\n"); got != "" {
		t.Errorf("expected nothing for a directory listing, got %q", got)
	}
	if got := SummarizeWidgetFence("python", "values: [1]"); got != "" {
		t.Errorf("expected nothing for a non-widget fence, got %q", got)
	}
}

func TestIndexableContentReplacesFenceBodies(t *testing.T) {
	page := strings.Join([]string{
		"# Two Sum",
		"",
		"Prose about the problem.",
		"",
		"```array id=two-sum",
		"values: [2, 7, 11]",
		"caption: Two pointers",
		"activeIndices: [0]",
		"steps:",
		"  - note: lo moves right",
		"```",
		"",
		"Closing prose.",
	}, "\n")

	got := IndexableContent(page)
	for _, want := range []string{"Two Sum", "Prose about the problem.", "Two pointers", "lo moves right", "Closing prose."} {
		if !strings.Contains(got, want) {
			t.Errorf("expected %q in the indexable text:\n%s", want, got)
		}
	}
	for _, unwanted := range []string{"activeIndices", "```array", "values:"} {
		if strings.Contains(got, unwanted) {
			t.Errorf("expected %q to be stripped:\n%s", unwanted, got)
		}
	}
}

func TestIndexableContentLeavesOtherFencesAlone(t *testing.T) {
	page := "```python\nvalues = [1]\n```\n"
	if got := IndexableContent(page); !strings.Contains(got, "values = [1]") {
		t.Errorf("a code fence must survive indexing: %q", got)
	}
}

func TestIndexableContentKeepsAnUnclaimedTreeFence(t *testing.T) {
	page := "```tree\nsrc/\n  lib/\n```\n"
	got := IndexableContent(page)
	if !strings.Contains(got, "src/") {
		t.Errorf("a directory listing is real content: %q", got)
	}
}

func TestStripWidgetFencesCanRewriteForExport(t *testing.T) {
	page := "```array\nvalues: [1]\ncaption: A sweep\n```\n"
	got := StripWidgetFences(page, func(lang, summary, _ string) string {
		return "> " + lang + ": " + summary
	})
	if !strings.Contains(got, "> array: A sweep") {
		t.Errorf("unexpected rewrite: %q", got)
	}
}

func TestStripWidgetFencesKeepsAnUnclosedFenceVerbatim(t *testing.T) {
	page := "```array\nvalues: [1]\n"
	got := StripWidgetFences(page, func(_, summary, _ string) string { return summary })
	if !strings.Contains(got, "values: [1]") {
		t.Errorf("an unclosed fence must not lose its body: %q", got)
	}
}
