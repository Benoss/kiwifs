package mcpserver

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/kiwifs/kiwifs/internal/markdown"
	"github.com/mark3labs/mcp-go/mcp"
)

func decodeReference(t *testing.T, raw string) widgetReferenceDoc {
	t.Helper()
	var doc widgetReferenceDoc
	if err := json.Unmarshal([]byte(raw), &doc); err != nil {
		t.Fatalf("decode reference: %v\n%s", err, raw)
	}
	return doc
}

func TestWidgetReferenceListsEveryFence(t *testing.T) {
	out := mustCallTool(t, handleWidgetReference(), "kiwi_widget_reference", map[string]any{})
	doc := decodeReference(t, out)

	if len(doc.Fences) < 10 {
		t.Fatalf("expected the whole catalogue, got %d", len(doc.Fences))
	}
	if doc.Grammar == "" || doc.MetaString == "" {
		t.Error("an agent needs the body grammar, not just a key list")
	}
	if len(doc.ReservedTopLevel) == 0 || len(doc.ReservedStep) == 0 {
		t.Error("expected the reserved key sets")
	}
	for _, f := range doc.Fences {
		if f.Description == "" {
			t.Errorf("%s has no description", f.Fence)
		}
		// The list form stays small: attributes and examples are per-fence.
		if len(f.Attributes) != 0 || f.Example != "" {
			t.Errorf("%s: the list form should not carry attributes or an example", f.Fence)
		}
	}
}

func TestWidgetReferenceWithExamples(t *testing.T) {
	out := mustCallTool(t, handleWidgetReference(), "kiwi_widget_reference", map[string]any{"examples": true})
	doc := decodeReference(t, out)
	for _, f := range doc.Fences {
		if f.Example == "" {
			t.Errorf("%s has no example", f.Fence)
		}
	}
}

func TestWidgetReferenceOneFence(t *testing.T) {
	out := mustCallTool(t, handleWidgetReference(), "kiwi_widget_reference", map[string]any{"name": "array"})
	doc := decodeReference(t, out)

	if len(doc.Fences) != 1 || doc.Fences[0].Fence != "array" {
		t.Fatalf("expected just the array fence, got %+v", doc.Fences)
	}
	spec := doc.Fences[0]
	if spec.Example == "" {
		t.Error("expected a worked example")
	}
	// Required keys come first, so an agent reading the top of the list
	// already has something that renders.
	if len(spec.Attributes) == 0 {
		t.Fatal("expected attributes")
	}
	var sawFixed bool
	for _, a := range spec.Attributes {
		if a.Name == "cellSize" {
			sawFixed = a.FixedAcross
		}
	}
	if !sawFixed {
		t.Error("expected cellSize to be marked as fixed across steps")
	}
}

func TestWidgetReferenceResolvesAliases(t *testing.T) {
	for _, name := range []string{"kiwi-array", "widget:array", "arraystack"} {
		out := mustCallTool(t, handleWidgetReference(), "kiwi_widget_reference", map[string]any{"name": name})
		doc := decodeReference(t, out)
		if len(doc.Fences) != 1 || doc.Fences[0].Fence != "array" {
			t.Errorf("%s did not resolve to array: %+v", name, doc.Fences)
		}
	}
}

func TestWidgetReferenceUnknownNameListsTheOptions(t *testing.T) {
	result, err := handleWidgetReference()(context.Background(), callToolReq("kiwi_widget_reference", map[string]any{"name": "nope"}))
	if err != nil {
		t.Fatal(err)
	}
	if !result.IsError {
		t.Fatal("expected an error result")
	}
	msg := result.Content[0].(mcp.TextContent).Text
	if !strings.Contains(msg, "Available:") || !strings.Contains(msg, "array") {
		t.Errorf("an unknown name should say what is available: %q", msg)
	}
}

// Every documented example must survive the linter that checks what agents
// write; a reference that teaches an invalid fence is worse than none.
func TestWidgetReferenceExamplesLintClean(t *testing.T) {
	fences, err := markdown.WidgetFences()
	if err != nil {
		t.Fatal(err)
	}
	for _, spec := range fences {
		page := "---\ntitle: t\n---\n\n" + spec.Example + "\n"
		for _, issue := range markdown.LintMarkdown([]byte(page)) {
			if issue.Rule == "fence-widget-invalid" {
				t.Errorf("%s example: %s", spec.Lang, issue.Message)
			}
		}
	}
}
