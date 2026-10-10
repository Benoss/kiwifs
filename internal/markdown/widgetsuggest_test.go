package markdown

import (
	"strings"
	"testing"
)

func fence(lang, body string) string {
	return "```" + lang + "\n" + body + "\n```\n"
}

func TestSuggestsAStaticArrayBlock(t *testing.T) {
	page := fence("widget:live", `render(<ArrayView values={[1, 2, 3]} activeIndex={1} />)`)
	got := SuggestWidgetFences([]byte(page))
	if len(got) != 1 {
		t.Fatalf("expected one suggestion, got %+v", got)
	}
	if got[0].Fence != "array" {
		t.Errorf("expected the array fence, got %q", got[0].Fence)
	}
	if got[0].Line != 1 {
		t.Errorf("expected line 1, got %d", got[0].Line)
	}
	for _, want := range []string{"```array", "values: [1, 2, 3]", "activeIndex: 1"} {
		if !strings.Contains(got[0].Draft, want) {
			t.Errorf("expected %q in the draft:\n%s", want, got[0].Draft)
		}
	}
}

func TestSuggestsForEveryMappedComponent(t *testing.T) {
	cases := map[string]string{
		"<MatrixView values={[[1]]} />":                "matrix",
		"<TreeView root={{value: 1}} />":               "tree",
		"<GraphView nodes={[]} edges={[]} />":          "graph",
		"<BitsView value={5} />":                       "bits",
		"<LinkedListView nodes={[]} />":                "list",
		"<TimelineView intervals={[]} />":              "timeline",
		"<NumberLineView min={0} max={1} />":           "numberline",
	}
	for jsx, want := range cases {
		got := SuggestWidgetFences([]byte(fence("widget:live", "render("+jsx+")")))
		if len(got) != 1 || got[0].Fence != want {
			t.Errorf("%s → expected %q, got %+v", jsx, want, got)
		}
	}
}

func TestDoesNotSuggestForARealProgram(t *testing.T) {
	// Anything that computes is not a picture, and converting it would
	// silently drop behaviour.
	programs := []string{
		`const [i, setI] = useState(0); render(<ArrayView values={[1]} activeIndex={i} />)`,
		`const pb = usePlayback(steps); render(<ArrayView values={[1]} />)`,
		`const dp = values.map(v => v * 2); render(<ArrayView values={dp} />)`,
		`function f() { return 1 } render(<ArrayView values={[1]} />)`,
		`for (let i = 0; i < 3; i++) {} render(<ArrayView values={[1]} />)`,
	}
	for _, program := range programs {
		if got := SuggestWidgetFences([]byte(fence("widget:live", program))); len(got) != 0 {
			t.Errorf("should not have suggested for %q: %+v", program, got)
		}
	}
}

func TestDoesNotSuggestForAnExpressionProp(t *testing.T) {
	page := fence("widget:live", `render(<ArrayView values={nums} />)`)
	if got := SuggestWidgetFences([]byte(page)); len(got) != 0 {
		t.Errorf("a prop holding an identifier is not a literal: %+v", got)
	}
}

func TestDoesNotSuggestForTwoDifferentViews(t *testing.T) {
	page := fence("widget:live", `render(<><ArrayView values={[1]} /><TreeView root={{value: 1}} /></>)`)
	if got := SuggestWidgetFences([]byte(page)); len(got) != 0 {
		t.Errorf("two views is a layout, not one picture: %+v", got)
	}
}

func TestDoesNotSuggestForAnUnmappedComponent(t *testing.T) {
	page := fence("widget:live", `render(<ActivityGrid days={[]} />)`)
	if got := SuggestWidgetFences([]byte(page)); len(got) != 0 {
		t.Errorf("no fence replaces ActivityGrid: %+v", got)
	}
}

func TestIgnoresOtherFences(t *testing.T) {
	page := fence("array", "values: [1]") + fence("python", "x = 1")
	if got := SuggestWidgetFences([]byte(page)); len(got) != 0 {
		t.Errorf("expected nothing, got %+v", got)
	}
}

func TestSuggestsForSeveralBlocksOnAPage(t *testing.T) {
	page := fence("widget:live", `render(<ArrayView values={[1]} />)`) +
		"\nprose\n\n" +
		fence("widget:live", `render(<MatrixView values={[[1]]} />)`)
	got := SuggestWidgetFences([]byte(page))
	if len(got) != 2 {
		t.Fatalf("expected two suggestions, got %+v", got)
	}
	if got[0].Line >= got[1].Line {
		t.Error("expected the suggestions in document order")
	}
}

func TestLintReportsSuggestionsAtInfoSeverity(t *testing.T) {
	page := "---\ntitle: t\n---\n\n" + fence("widget:live", `render(<ArrayView values={[1, 2]} />)`)
	var found *LintIssue
	for i, issue := range LintMarkdown([]byte(page)) {
		if issue.Rule == "widget-live-convertible" {
			found = &LintMarkdown([]byte(page))[i]
		}
	}
	if found == nil {
		t.Fatal("expected a widget-live-convertible issue")
	}
	if found.Severity != "info" {
		t.Errorf("a suggestion must not fail a lint run: %q", found.Severity)
	}
	if !strings.Contains(found.Message, "```array") {
		t.Errorf("unexpected message %q", found.Message)
	}
	// Line 5 of the page is where the fence opens.
	if found.Line != 5 {
		t.Errorf("expected line 5, got %d", found.Line)
	}
}

func TestDraftsLintClean(t *testing.T) {
	// A draft that the linter rejects is worse than no draft.
	page := fence("widget:live", `render(<ArrayView values={[1, 2, 3]} label={"nums"} />)`)
	got := SuggestWidgetFences([]byte(page))
	if len(got) != 1 {
		t.Fatalf("expected a suggestion, got %+v", got)
	}
	draft := "---\ntitle: t\n---\n\n" + got[0].Draft + "\n"
	for _, issue := range LintMarkdown([]byte(draft)) {
		if issue.Rule == "fence-widget-invalid" {
			t.Errorf("draft is not clean: %s\n%s", issue.Message, got[0].Draft)
		}
	}
}
