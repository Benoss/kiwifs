// Package lsp is a minimal Language Server for a KiwiFS workspace. It does
// one thing: when an editor is about to rename or move files
// (workspace/willRenameFiles), it answers with the edits that keep every
// link pointing at them, computed by the refactor planner, so renaming in
// VS Code, Zed or Neovim relinks the way kiwi_rename does.
package lsp

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/textproto"
	"strconv"
	"strings"
	"sync"

	"github.com/kiwifs/kiwifs/internal/refactor"
)

// PlanFunc plans a manifest against the workspace at root.
type PlanFunc func(ctx context.Context, root string, m *refactor.Manifest) (*refactor.Plan, error)

// Server speaks JSON-RPC 2.0 with LSP's Content-Length framing.
type Server struct {
	Root    string
	Plan    PlanFunc
	Version string

	out io.Writer
	mu  sync.Mutex
}

type message struct {
	JSONRPC string           `json:"jsonrpc"`
	ID      *json.RawMessage `json:"id,omitempty"`
	Method  string           `json:"method,omitempty"`
	Params  json.RawMessage  `json:"params,omitempty"`
	Result  any              `json:"result,omitempty"`
	Error   *rpcError        `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// Serve reads requests from in and answers on out until exit or EOF.
func (s *Server) Serve(ctx context.Context, in io.Reader, out io.Writer) error {
	s.out = out
	r := bufio.NewReader(in)
	for {
		body, err := readMessage(r)
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		var msg message
		if err := json.Unmarshal(body, &msg); err != nil {
			s.reply(nil, nil, &rpcError{Code: -32700, Message: "parse error"})
			continue
		}
		if msg.Method == "exit" {
			return nil
		}
		result, rerr := s.handle(ctx, msg)
		if msg.ID != nil {
			s.reply(msg.ID, result, rerr)
		}
	}
}

func readMessage(r *bufio.Reader) ([]byte, error) {
	header, err := textproto.NewReader(r).ReadMIMEHeader()
	if err != nil {
		return nil, err
	}
	n, err := strconv.Atoi(header.Get("Content-Length"))
	if err != nil || n < 0 || n > 64<<20 {
		return nil, fmt.Errorf("bad Content-Length %q", header.Get("Content-Length"))
	}
	body := make([]byte, n)
	_, err = io.ReadFull(r, body)
	return body, err
}

func (s *Server) write(v any) {
	data, err := json.Marshal(v)
	if err != nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	fmt.Fprintf(s.out, "Content-Length: %d\r\n\r\n%s", len(data), data)
}

func (s *Server) reply(id *json.RawMessage, result any, rerr *rpcError) {
	msg := map[string]any{"jsonrpc": "2.0", "id": id}
	if rerr != nil {
		msg["error"] = rerr
	} else {
		msg["result"] = result
	}
	s.write(msg)
}

func (s *Server) notify(method string, params any) {
	s.write(map[string]any{"jsonrpc": "2.0", "method": method, "params": params})
}

func (s *Server) handle(ctx context.Context, msg message) (any, *rpcError) {
	switch msg.Method {
	case "initialize":
		var p struct {
			RootURI          string `json:"rootUri"`
			WorkspaceFolders []struct {
				URI string `json:"uri"`
			} `json:"workspaceFolders"`
		}
		_ = json.Unmarshal(msg.Params, &p)
		if s.Root == "" {
			uri := p.RootURI
			if uri == "" && len(p.WorkspaceFolders) > 0 {
				uri = p.WorkspaceFolders[0].URI
			}
			s.Root = uriPath(uri)
		}
		return map[string]any{
			"capabilities": map[string]any{
				"workspace": map[string]any{
					"fileOperations": map[string]any{
						"willRename": map[string]any{
							"filters": []any{
								map[string]any{"scheme": "file", "pattern": map[string]any{"glob": "**/*"}},
							},
						},
					},
				},
			},
			"serverInfo": map[string]any{"name": "kiwifs", "version": s.Version},
		}, nil
	case "shutdown":
		return nil, nil
	case "workspace/willRenameFiles":
		return s.willRename(ctx, msg.Params)
	}
	if msg.ID != nil {
		return nil, &rpcError{Code: -32601, Message: "method not found: " + msg.Method}
	}
	return nil, nil
}

// willRename plans the renames and returns the link edits to make first,
// addressed by the files' current URIs. A rename the planner rejects gets
// no edits and a message saying why; the editor still renames.
func (s *Server) willRename(ctx context.Context, params json.RawMessage) (any, *rpcError) {
	var p struct {
		Files []struct {
			OldURI string `json:"oldUri"`
			NewURI string `json:"newUri"`
		} `json:"files"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &rpcError{Code: -32602, Message: err.Error()}
	}
	if s.Root == "" {
		return nil, nil
	}
	m := &refactor.Manifest{}
	for _, f := range p.Files {
		from, to := refactor.RelPath(s.Root, f.OldURI), refactor.RelPath(s.Root, f.NewURI)
		if from == "" || to == "" || hidden(from) || hidden(to) {
			continue
		}
		m.Moves = append(m.Moves, refactor.Move{From: from, To: to})
	}
	if len(m.Moves) == 0 {
		return nil, nil
	}
	plan, err := s.Plan(ctx, s.Root, m)
	if err != nil {
		return nil, &rpcError{Code: -32603, Message: err.Error()}
	}
	if len(plan.Errors) > 0 {
		s.notify("window/showMessage", map[string]any{
			"type":    2, // warning
			"message": "KiwiFS could not relink this rename: " + strings.Join(plan.Errors, "; "),
		})
		return nil, nil
	}
	return plan.PreRenameEdits(s.Root), nil
}

func hidden(rel string) bool {
	for _, seg := range strings.Split(rel, "/") {
		if strings.HasPrefix(seg, ".") {
			return true
		}
	}
	return false
}

func uriPath(uri string) string {
	if uri == "" {
		return ""
	}
	return refactor.URIPath(uri)
}
