package docexport

import (
	"strings"
	"testing"
)

const widgetPage = "# Two Sum\n\n" +
	"```array id=two-sum\n" +
	"values: [2, 7, 11]\n" +
	"caption: Two pointers meet\n" +
	"activeIndices: [0]\n" +
	"steps:\n" +
	"  - note: lo moves right\n" +
	"  - note: they cross\n" +
	"```\n\n" +
	"Closing prose.\n"

func TestRewriteWidgetFencesKeepsTheProse(t *testing.T) {
	got := string(RewriteWidgetFences([]byte(widgetPage)))

	for _, want := range []string{
		"# Two Sum",
		"> Two pointers meet",
		"> lo moves right",
		"> they cross",
		"Interactive array widget",
		"Closing prose.",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("expected %q in:\n%s", want, got)
		}
	}
}

func TestRewriteWidgetFencesKeepsTheDataAsYAML(t *testing.T) {
	got := string(RewriteWidgetFences([]byte(widgetPage)))
	if !strings.Contains(got, "```yaml") {
		t.Errorf("the data should still be readable:\n%s", got)
	}
	if !strings.Contains(got, "values: [2, 7, 11]") {
		t.Errorf("expected the original body to survive:\n%s", got)
	}
	// And no longer as a fence pandoc would try to highlight as `array`.
	if strings.Contains(got, "```array") {
		t.Errorf("the widget tag should be gone:\n%s", got)
	}
}

func TestRewriteWidgetFencesLeavesCodeFencesAlone(t *testing.T) {
	page := "```python\nvalues = [1]\n```\n"
	got := string(RewriteWidgetFences([]byte(page)))
	if got != page {
		t.Errorf("a code fence must pass through untouched:\n%s", got)
	}
}

func TestRewriteWidgetFencesLeavesADirectoryListingAlone(t *testing.T) {
	// A bare ```tree holding a directory listing is not a widget.
	page := "```tree\nsrc/\n  lib/\n```\n"
	got := string(RewriteWidgetFences([]byte(page)))
	if strings.Contains(got, "Interactive") {
		t.Errorf("a directory listing must not become a figure:\n%s", got)
	}
	if !strings.Contains(got, "src/") {
		t.Errorf("content lost:\n%s", got)
	}
}

func TestRewriteWidgetFencesHandlesAFenceWithNoProse(t *testing.T) {
	page := "```array\nvalues: [1, 2]\n```\n"
	got := string(RewriteWidgetFences([]byte(page)))
	if !strings.Contains(got, "Interactive array widget") {
		t.Errorf("expected the pointer back to KiwiFS:\n%s", got)
	}
	if !strings.Contains(got, "values: [1, 2]") {
		t.Errorf("expected the data:\n%s", got)
	}
}
