package mcpserver

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mark3labs/mcp-go/mcp"
)

func writeTree(t *testing.T, root string, files map[string]string) {
	t.Helper()
	for p, c := range files {
		abs := filepath.Join(root, filepath.FromSlash(p))
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(abs, []byte(c), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func readTree(t *testing.T, root, p string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(p)))
	if err != nil {
		t.Fatalf("read %s: %v", p, err)
	}
	return string(b)
}

func callTool(t *testing.T, h func(context.Context, mcp.CallToolRequest) (*mcp.CallToolResult, error), name string, args map[string]any) *mcp.CallToolResult {
	t.Helper()
	res, err := h(context.Background(), callToolReq(name, args))
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	return res
}

func resultText(r *mcp.CallToolResult) string {
	if len(r.Content) == 0 {
		return ""
	}
	return r.Content[0].(mcp.TextContent).Text
}

func planOf(t *testing.T, r *mcp.CallToolResult) planView {
	t.Helper()
	var v planView
	if err := json.Unmarshal([]byte(resultText(r)), &v); err != nil {
		t.Fatalf("decode plan: %v\n%s", err, resultText(r))
	}
	return v
}

func TestRefactorTools_PlanThenApply(t *testing.T) {
	b, root := setupTestBackend(t)
	defer b.Close()
	writeTree(t, root, map[string]string{
		"notes/target.md": "# Target\n\nSee [the index](../index.md).\n",
		"other/intro.md":  "# Another intro\n",
		"hub.md": "# Hub\n\n" +
			"- [[target]]\n" +
			"- [md link](notes/target.md#top)\n" +
			"| a | b |\n|---|---|\n| [[target\\|alias]] | x |\n\n" +
			"~~~\n[[target]] stays literal\n~~~\n",
	})

	manifest := "moves:\n  - from: notes/target.md\n    to: archive/intro.md\n"
	plan := planOf(t, callTool(t, handleRefactorPlan(b), "kiwi_refactor_plan", map[string]any{"manifest": manifest, "detail": "full"}))
	if !plan.Applicable || plan.Digest == "" {
		t.Fatalf("plan not applicable: %+v", plan)
	}
	if plan.Counts.Moves != 1 || plan.Moves[0].To != "archive/intro.md" {
		t.Fatalf("moves = %+v", plan.Moves)
	}

	res := callTool(t, handleRefactorApply(b), "kiwi_refactor_apply", map[string]any{"manifest": manifest, "digest": plan.Digest})
	if res.IsError {
		t.Fatalf("apply: %s", resultText(res))
	}

	hub := readTree(t, root, "hub.md")
	// "intro" alone would now be ambiguous with other/intro.md, so the wiki
	// links are qualified; the markdown link keeps its relative style and
	// its anchor; the table link keeps its escaped pipe; the fence is text.
	for _, want := range []string{
		"- [[archive/intro]]\n",
		"[md link](archive/intro.md#top)",
		"| [[archive/intro\\|alias]] | x |",
		"~~~\n[[target]] stays literal\n~~~",
	} {
		if !strings.Contains(hub, want) {
			t.Errorf("hub.md missing %q:\n%s", want, hub)
		}
	}
	moved := readTree(t, root, "archive/intro.md")
	if !strings.Contains(moved, "[the index](../index.md)") {
		t.Errorf("relative link inside the moved page broke:\n%s", moved)
	}
	if _, err := os.Stat(filepath.Join(root, "notes/target.md")); !os.IsNotExist(err) {
		t.Errorf("old path still exists")
	}
}

func TestRefactorTools_StaleDigestReturnsFreshPlan(t *testing.T) {
	b, root := setupTestBackend(t)
	defer b.Close()
	writeTree(t, root, map[string]string{
		"a.md": "# A\n\n[[b]]\n",
		"b.md": "# B\n",
	})
	manifest := map[string]any{"moves": []any{map[string]any{"from": "b.md", "to": "c.md"}}}
	plan := planOf(t, callTool(t, handleRefactorPlan(b), "kiwi_refactor_plan", map[string]any{"manifest": manifest}))

	// Another agent edits a page the plan rewrites.
	if _, err := b.WriteFile(context.Background(), "a.md", "# A\n\n[[b]] and more\n", "other", ""); err != nil {
		t.Fatal(err)
	}
	res := callTool(t, handleRefactorApply(b), "kiwi_refactor_apply", map[string]any{"manifest": manifest, "digest": plan.Digest})
	if !res.IsError {
		t.Fatalf("stale apply succeeded: %s", resultText(res))
	}
	var body struct {
		Plan planView `json:"plan"`
	}
	if err := json.Unmarshal([]byte(resultText(res)), &body); err != nil {
		t.Fatal(err)
	}
	if body.Plan.Digest == "" || body.Plan.Digest == plan.Digest {
		t.Fatalf("want a fresh digest, got %q (old %q)", body.Plan.Digest, plan.Digest)
	}
	if _, err := os.Stat(filepath.Join(root, "b.md")); err != nil {
		t.Fatalf("nothing should have moved: %v", err)
	}
	res = callTool(t, handleRefactorApply(b), "kiwi_refactor_apply", map[string]any{"manifest": manifest, "digest": body.Plan.Digest})
	if res.IsError {
		t.Fatalf("apply with fresh digest: %s", resultText(res))
	}
	if got := readTree(t, root, "a.md"); got != "# A\n\n[[c]] and more\n" {
		t.Fatalf("a.md = %q", got)
	}
}

func TestRefactorTools_ApplyRequiresDigestAndRejectsErrors(t *testing.T) {
	b, root := setupTestBackend(t)
	defer b.Close()
	writeTree(t, root, map[string]string{"x.md": "x\n", "y.md": "y\n"})

	res := callTool(t, handleRefactorApply(b), "kiwi_refactor_apply", map[string]any{"manifest": "moves: [{from: x.md, to: z.md}]"})
	if !res.IsError || !strings.Contains(resultText(res), "digest is required") {
		t.Fatalf("want digest error, got %s", resultText(res))
	}
	plan := planOf(t, callTool(t, handleRefactorPlan(b), "kiwi_refactor_plan", map[string]any{"manifest": "moves: [{from: x.md, to: y.md}]"}))
	if plan.Applicable || len(plan.Errors) == 0 {
		t.Fatalf("moving onto an existing page must be an error: %+v", plan)
	}
	res = callTool(t, handleRefactorPlan(b), "kiwi_refactor_plan", map[string]any{"manifest": "moves: [{from: x.md, to: z.md}]\nbogus: 1\n"})
	if !res.IsError {
		t.Fatal("unknown manifest keys must be rejected")
	}
}

func TestRefactorTools_PlanPaging(t *testing.T) {
	b, root := setupTestBackend(t)
	defer b.Close()
	files := map[string]string{}
	for _, n := range []string{"a", "b", "c", "d", "e"} {
		files["batch/"+n+".md"] = "# " + n + "\n"
	}
	writeTree(t, root, files)
	args := map[string]any{"manifest": "moves: [{from: batch/, to: done/}]", "limit": 2}
	first := planOf(t, callTool(t, handleRefactorPlan(b), "kiwi_refactor_plan", args))
	if first.Counts.Moves != 5 || len(first.Moves) != 2 || first.NextOffset != 2 {
		t.Fatalf("page 1 = %+v", first)
	}
	args["offset"] = 4
	last := planOf(t, callTool(t, handleRefactorPlan(b), "kiwi_refactor_plan", args))
	if len(last.Moves) != 1 || last.NextOffset != 0 || last.Digest != first.Digest {
		t.Fatalf("last page = %+v", last)
	}
}

func TestRenameTool_RewritesMarkdownLinks(t *testing.T) {
	b, root := setupTestBackend(t)
	defer b.Close()
	writeTree(t, root, map[string]string{
		"guide.md": "# Guide\n\nRead [auth](concepts/auth.md) and [[auth]].\n",
	})
	res := callTool(t, handleRename(b), "kiwi_rename", map[string]any{"from": "concepts/auth.md", "to": "security/authentication.md"})
	if res.IsError {
		t.Fatalf("rename: %s", resultText(res))
	}
	got := readTree(t, root, "guide.md")
	if want := "Read [auth](security/authentication.md) and [[authentication]].\n"; !strings.HasSuffix(got, want) {
		t.Fatalf("guide.md = %q, want suffix %q", got, want)
	}
	if !strings.Contains(resultText(res), "guide.md") {
		t.Errorf("result should list the relinked page: %s", resultText(res))
	}

	writeTree(t, root, map[string]string{"taken.md": "# Taken\n"})
	res = callTool(t, handleRename(b), "kiwi_rename", map[string]any{"from": "guide.md", "to": "taken.md"})
	if !res.IsError {
		t.Fatal("rename onto an existing page must fail")
	}
	if readTree(t, root, "taken.md") != "# Taken\n" {
		t.Fatal("existing destination was overwritten")
	}
}

func TestWriteTool_IfMatch(t *testing.T) {
	b, _ := setupTestBackend(t)
	defer b.Close()
	ctx := context.Background()
	_, etag, err := b.ReadFile(ctx, "index.md")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := b.WriteFile(ctx, "index.md", "# Index\n\nsomeone else\n", "other", ""); err != nil {
		t.Fatal(err)
	}
	res := callTool(t, handleWrite(b), "kiwi_write", map[string]any{"path": "index.md", "content": "# mine\n", "if_match": etag})
	if !res.IsError || !strings.Contains(resultText(res), "changed since you read it") {
		t.Fatalf("stale if_match should fail: %s", resultText(res))
	}
	_, fresh, _ := b.ReadFile(ctx, "index.md")
	res = callTool(t, handleWrite(b), "kiwi_write", map[string]any{"path": "index.md", "content": "# mine\n", "if_match": fresh})
	if res.IsError {
		t.Fatalf("fresh if_match should succeed: %s", resultText(res))
	}
}

func TestBulkWriteTool_IfMatchFailsWholeBatch(t *testing.T) {
	b, root := setupTestBackend(t)
	defer b.Close()
	res := callTool(t, handleBulkWrite(b), "kiwi_bulk_write", map[string]any{"files": []any{
		map[string]any{"path": "new.md", "content": "# new\n"},
		map[string]any{"path": "index.md", "content": "# clobber\n", "if_match": "0000"},
	}})
	if !res.IsError {
		t.Fatalf("stale if_match should fail the batch: %s", resultText(res))
	}
	if _, err := os.Stat(filepath.Join(root, "new.md")); !os.IsNotExist(err) {
		t.Fatal("no file in a failed batch may be written")
	}
}

func TestPatchFrontmatterTool(t *testing.T) {
	b, root := setupTestBackend(t)
	defer b.Close()
	ctx := context.Background()
	_, etag, _ := b.ReadFile(ctx, "concepts/auth.md")
	res := callTool(t, handlePatchFrontmatter(b), "kiwi_patch_frontmatter", map[string]any{
		"path":     "concepts/auth.md",
		"fields":   map[string]any{"status": "draft", "priority": float64(2), "tags": nil},
		"if_match": etag,
	})
	if res.IsError {
		t.Fatalf("patch: %s", resultText(res))
	}
	got := readTree(t, root, "concepts/auth.md")
	if !strings.Contains(got, "status: draft") || !strings.Contains(got, "priority: 2\n") || strings.Contains(got, "tags:") {
		t.Fatalf("frontmatter not patched:\n%s", got)
	}
	if !strings.HasSuffix(got, "# Authentication\n\nAuth overview.\n") {
		t.Fatalf("body changed:\n%s", got)
	}
	res = callTool(t, handlePatchFrontmatter(b), "kiwi_patch_frontmatter", map[string]any{
		"path": "concepts/auth.md", "fields": map[string]any{"status": "x"}, "if_match": etag,
	})
	if !res.IsError {
		t.Fatal("stale if_match must fail")
	}
}
