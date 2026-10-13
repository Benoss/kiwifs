package lsp

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kiwifs/kiwifs/internal/refactor"
	"github.com/kiwifs/kiwifs/internal/storage"
)

func frame(v any) string {
	data, _ := json.Marshal(v)
	return fmt.Sprintf("Content-Length: %d\r\n\r\n%s", len(data), data)
}

func TestWillRenameFilesAnswersWithLinkEdits(t *testing.T) {
	dir := t.TempDir()
	for p, c := range map[string]string{"a.md": "# A\n", "index.md": "see [a](a.md)\n"} {
		if err := os.WriteFile(filepath.Join(dir, p), []byte(c), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	plan := func(ctx context.Context, root string, m *refactor.Manifest) (*refactor.Plan, error) {
		store, err := storage.NewLocal(root)
		if err != nil {
			return nil, err
		}
		return refactor.BuildPlan(ctx, refactor.Workspace{Root: root, Store: store}, m)
	}
	in := frame(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{"rootUri": refactor.FileURI(dir, "")}}) +
		frame(map[string]any{"jsonrpc": "2.0", "method": "initialized", "params": map[string]any{}}) +
		frame(map[string]any{"jsonrpc": "2.0", "id": 2, "method": "workspace/willRenameFiles", "params": map[string]any{
			"files": []any{map[string]any{"oldUri": refactor.FileURI(dir, "a.md"), "newUri": refactor.FileURI(dir, "docs/a.md")}},
		}}) +
		frame(map[string]any{"jsonrpc": "2.0", "id": 3, "method": "textDocument/hover", "params": map[string]any{}}) +
		frame(map[string]any{"jsonrpc": "2.0", "id": 4, "method": "shutdown"}) +
		frame(map[string]any{"jsonrpc": "2.0", "method": "exit"})
	pr, pw := io.Pipe()
	go func() {
		srv := &Server{Plan: plan, Version: "test"}
		_ = srv.Serve(context.Background(), strings.NewReader(in), pw)
		pw.Close()
	}()
	r := bufio.NewReader(pr)
	var replies []map[string]any
	for {
		body, err := readMessage(r)
		if err != nil {
			break
		}
		var m map[string]any
		_ = json.Unmarshal(body, &m)
		replies = append(replies, m)
	}
	if len(replies) != 4 {
		t.Fatalf("replies = %v", replies)
	}
	caps, _ := json.Marshal(replies[0]["result"])
	if !strings.Contains(string(caps), "willRename") {
		t.Fatalf("initialize = %s", caps)
	}
	edit, _ := json.Marshal(replies[1]["result"])
	if !strings.Contains(string(edit), refactor.FileURI(dir, "index.md")) || !strings.Contains(string(edit), `"newText":"docs/"`) {
		t.Fatalf("willRenameFiles = %s", edit)
	}
	if replies[2]["error"] == nil {
		t.Fatalf("an unsupported request must get an error: %v", replies[2])
	}
}
