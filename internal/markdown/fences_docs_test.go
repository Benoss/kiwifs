package markdown

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Documentation that teaches an invalid fence is worse than no documentation.
// The examples in docs/ are fenced inside ````markdown blocks, so they are
// extracted and linted as if they were a page.
func TestDocumentedFencesLintClean(t *testing.T) {
	root := repoRoot(t)
	for _, name := range []string{"EXAMPLES.md", "WIDGETS.md", "FAQ.md", "ROADMAP.md"} {
		path := filepath.Join(root, "docs", name)
		content, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		for i, snippet := range extractNestedFences(string(content)) {
			page := "---\ntitle: t\n---\n\n" + snippet + "\n"
			for _, issue := range LintMarkdown([]byte(page)) {
				if issue.Rule == "fence-widget-invalid" {
					t.Errorf("docs/%s snippet %d: %s\n%s", name, i, issue.Message, snippet)
				}
			}
		}
	}
}

// extractNestedFences returns the bodies of ````-delimited blocks, which is how
// the docs show a ```-delimited example.
func extractNestedFences(content string) []string {
	var out []string
	lines := strings.Split(content, "\n")
	for i := 0; i < len(lines); i++ {
		trimmed := strings.TrimSpace(lines[i])
		if !strings.HasPrefix(trimmed, "````") {
			continue
		}
		var body []string
		i++
		for i < len(lines) && !strings.HasPrefix(strings.TrimSpace(lines[i]), "````") {
			body = append(body, lines[i])
			i++
		}
		if len(body) > 0 {
			out = append(out, strings.Join(body, "\n"))
		}
	}
	return out
}

func repoRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("could not find the repository root")
		}
		dir = parent
	}
}
