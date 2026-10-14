package markdown

import (
	"strings"
	"testing"
	"time"
)

func TestSetFrontmatterField_NewField(t *testing.T) {
	input := []byte("---\ntitle: Hello\n---\nBody content\n")
	result, err := SetFrontmatterField(input, "published", true)
	if err != nil {
		t.Fatal(err)
	}
	s := string(result)
	if !strings.Contains(s, "published: true") {
		t.Errorf("expected published: true in output, got:\n%s", s)
	}
	if !strings.Contains(s, "title: Hello") {
		t.Errorf("expected title to be preserved, got:\n%s", s)
	}
	if !strings.Contains(s, "Body content") {
		t.Errorf("expected body to be preserved, got:\n%s", s)
	}
}

func TestSetFrontmatterField_OverwriteExisting(t *testing.T) {
	input := []byte("---\ntitle: Hello\npublished: false\n---\nBody\n")
	result, err := SetFrontmatterField(input, "published", true)
	if err != nil {
		t.Fatal(err)
	}
	s := string(result)
	if !strings.Contains(s, "published: true") {
		t.Errorf("expected published: true, got:\n%s", s)
	}
	if strings.Contains(s, "published: false") {
		t.Errorf("should not contain published: false, got:\n%s", s)
	}
}

func TestSetFrontmatterField_NoFrontmatter(t *testing.T) {
	input := []byte("Just some body text\n")
	result, err := SetFrontmatterField(input, "published", true)
	if err != nil {
		t.Fatal(err)
	}
	s := string(result)
	if !strings.Contains(s, "---\n") {
		t.Errorf("expected frontmatter delimiters, got:\n%s", s)
	}
	if !strings.Contains(s, "published: true") {
		t.Errorf("expected published field, got:\n%s", s)
	}
	if !strings.Contains(s, "Just some body text") {
		t.Errorf("expected body to be preserved, got:\n%s", s)
	}
}

func TestSetFrontmatterField_TimeValue(t *testing.T) {
	input := []byte("---\ntitle: Post\n---\nContent\n")
	ts := time.Date(2026, 5, 16, 12, 0, 0, 0, time.UTC)
	result, err := SetFrontmatterField(input, "published_at", ts)
	if err != nil {
		t.Fatal(err)
	}
	s := string(result)
	if !strings.Contains(s, "2026-05-16T12:00:00Z") {
		t.Errorf("expected timestamp in output, got:\n%s", s)
	}
}

func TestSetFrontmatterField_RemoveField(t *testing.T) {
	input := []byte("---\ntitle: Post\npublished: true\n---\nContent\n")
	result, err := SetFrontmatterField(input, "published", nil)
	if err != nil {
		t.Fatal(err)
	}
	s := string(result)
	if strings.Contains(s, "published") {
		t.Errorf("expected published field to be removed, got:\n%s", s)
	}
	if !strings.Contains(s, "title: Post") {
		t.Errorf("expected title to remain, got:\n%s", s)
	}
}

func TestSetFrontmatterField_StringValue(t *testing.T) {
	input := []byte("---\ntitle: Hello\n---\nBody\n")
	result, err := SetFrontmatterField(input, "visibility", "public")
	if err != nil {
		t.Fatal(err)
	}
	s := string(result)
	if !strings.Contains(s, "visibility: public") {
		t.Errorf("expected visibility: public, got:\n%s", s)
	}
}

func TestSetFrontmatterField_PreservesBodyNewlines(t *testing.T) {
	input := []byte("---\ntitle: Hello\n---\nLine 1\n\nLine 3\n")
	result, err := SetFrontmatterField(input, "published", true)
	if err != nil {
		t.Fatal(err)
	}
	// Verify body is preserved (split at "---\n" after frontmatter)
	parts := strings.SplitN(string(result), "---\n", 3)
	if len(parts) < 3 {
		t.Fatalf("expected 3 parts from split, got %d: %q", len(parts), string(result))
	}
	body := parts[2]
	if !strings.Contains(body, "Line 1\n\nLine 3") {
		t.Errorf("body not preserved correctly, got:\n%q", body)
	}
}

func TestSetFrontmatterField_SplicesOnlyTheChangedKey(t *testing.T) {
	src := "---\n" +
		"# Owner: docs team\n" +
		"title:   Hand  Aligned   # keep me\n" +
		"tags: [a, b]\n" +
		"status: \"draft\"  # workflow\n" +
		"related:\n" +
		"- x\n" +
		"- y\n" +
		"\n" +
		"weird_spacing:    {k: v}\n" +
		"---\n" +
		"Body\n"
	cases := []struct {
		key   string
		value any
		want  string
	}{
		{"tags", []string{"a", "b", "c"}, strings.Replace(src, "tags: [a, b]\n", "tags: [a, b, c]\n", 1)},
		{"status", "done", strings.Replace(src, "status: \"draft\"  # workflow\n", "status: \"done\" # workflow\n", 1)},
		{"related", nil, strings.Replace(src, "related:\n- x\n- y\n", "", 1)},
		{"related", []string{"z"}, strings.Replace(src, "related:\n- x\n- y\n", "related:\n  - z\n", 1)},
		{"new", 3, strings.Replace(src, "weird_spacing:    {k: v}\n", "weird_spacing:    {k: v}\nnew: 3\n", 1)},
	}
	for _, tc := range cases {
		got, err := SetFrontmatterField([]byte(src), tc.key, tc.value)
		if err != nil {
			t.Fatal(err)
		}
		if string(got) != tc.want {
			t.Errorf("set %s=%v:\n got: %q\nwant: %q", tc.key, tc.value, got, tc.want)
		}
	}
}

func TestSetFrontmatterField_CRLFAndFallback(t *testing.T) {
	crlf := "---\r\ntitle: T\r\ntags: [a]\r\n---\r\nBody\r\n"
	got, err := SetFrontmatterField([]byte(crlf), "tags", []string{"a", "b"})
	if err != nil {
		t.Fatal(err)
	}
	if want := "---\r\ntitle: T\r\ntags: [a, b]\r\n---\r\nBody\r\n"; string(got) != want {
		t.Fatalf("got %q", got)
	}
	// A comment inside the value cannot survive a line splice; the whole
	// block is re-encoded instead (and still decodes to the right value).
	odd := "---\ntags:\n  # first\n  - a\n---\n"
	got, err = SetFrontmatterField([]byte(odd), "tags", []string{"b"})
	if err != nil {
		t.Fatal(err)
	}
	fm, _ := Frontmatter(got)
	if tags, _ := fm["tags"].([]any); len(tags) != 1 || tags[0] != "b" {
		t.Fatalf("fallback result = %q", got)
	}
}
