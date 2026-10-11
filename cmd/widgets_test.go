package cmd

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWalkMarkdownReportsUnreadableFiles(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root reads everything")
	}
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "ok.md"), []byte("# ok\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	locked := filepath.Join(root, "locked.md")
	if err := os.WriteFile(locked, []byte("# locked\n"), 0o000); err != nil {
		t.Fatal(err)
	}

	var warn bytes.Buffer
	var seen []string
	if err := walkMarkdown(root, &warn, func(path string, _ []byte) {
		seen = append(seen, filepath.Base(path))
	}); err != nil {
		t.Fatalf("walk: %v", err)
	}
	if len(seen) != 1 || seen[0] != "ok.md" {
		t.Errorf("expected only ok.md to be visited, got %v", seen)
	}
	if !strings.Contains(warn.String(), "locked.md") {
		t.Errorf("expected the unreadable file on stderr, got %q", warn.String())
	}
}

func TestWidgetsSuggestDefaultsToTheRootFlag(t *testing.T) {
	root := t.TempDir()
	page := "```widget:live\nrender(<ArrayView values={[1, 2]} />)\n```\n"
	if err := os.WriteFile(filepath.Join(root, "p.md"), []byte(page), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := widgetsSuggestCmd.Flags().Set("root", root); err != nil {
		t.Fatal(err)
	}
	defer widgetsSuggestCmd.Flags().Set("root", "./knowledge")

	var stderr bytes.Buffer
	widgetsSuggestCmd.SetErr(&stderr)
	defer widgetsSuggestCmd.SetErr(nil)

	stdout := os.Stdout
	r, w, _ := os.Pipe()
	os.Stdout = w
	err := runWidgetsSuggest(widgetsSuggestCmd, nil)
	w.Close()
	os.Stdout = stdout
	var out bytes.Buffer
	out.ReadFrom(r)
	if err != nil {
		t.Fatalf("suggest: %v (stderr %q)", err, stderr.String())
	}
	if !strings.Contains(out.String(), "p.md") {
		t.Errorf("expected the page under --root to be scanned:\n%s", out.String())
	}
}
