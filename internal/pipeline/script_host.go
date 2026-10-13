package pipeline

import (
	"context"
	"fmt"
	"strings"
	"sync"

	"github.com/bmatcuk/doublestar/v4"
	"github.com/kiwifs/kiwifs/internal/markdown"
	"github.com/kiwifs/kiwifs/internal/refactor"
	"github.com/kiwifs/kiwifs/internal/refactor/script"
	"github.com/kiwifs/kiwifs/internal/storage"
)

// scriptHost is everything a refactor script may read, and nothing it may
// write.
type scriptHost struct {
	p        *Pipeline
	once     sync.Once
	resolver *refactor.LinkResolver
	err      error
}

func (h *scriptHost) Query(ctx context.Context, dql string) ([]string, error) {
	if h.p.SelectPages == nil {
		return nil, fmt.Errorf("query() needs the sqlite search engine")
	}
	if h.p.AsyncIdx != nil {
		h.p.AsyncIdx.Flush()
	}
	return h.p.SelectPages(ctx, dql)
}

func (h *scriptHost) Files(ctx context.Context, glob string) ([]string, error) {
	if !doublestar.ValidatePattern(glob) {
		return nil, fmt.Errorf("invalid glob %q", glob)
	}
	out := []string{}
	err := storage.WalkAll(ctx, h.p.Store, "/", func(e storage.Entry) error {
		path := strings.TrimPrefix(e.Path, "/")
		if ok, _ := doublestar.Match(glob, path); ok {
			out = append(out, path)
		}
		return nil
	})
	return out, err
}

func (h *scriptHost) Read(ctx context.Context, path string) (string, error) {
	b, err := h.p.Store.Read(ctx, path)
	return string(b), err
}

func (h *scriptHost) Frontmatter(ctx context.Context, path string) (map[string]any, error) {
	b, err := h.p.Store.Read(ctx, path)
	if err != nil {
		return nil, err
	}
	fm, err := markdown.Frontmatter(b)
	if err != nil || fm == nil {
		return map[string]any{}, nil
	}
	return jsonSafe(fm).(map[string]any), nil
}

func (h *scriptHost) Links(ctx context.Context, path string) ([]string, error) {
	h.once.Do(func() { h.resolver, h.err = refactor.NewLinkResolver(ctx, h.p.RefactorWorkspace()) })
	if h.err != nil {
		return nil, h.err
	}
	b, err := h.p.Store.Read(ctx, path)
	if err != nil {
		return nil, err
	}
	return h.resolver.OutLinks(path, b), nil
}

// jsonSafe turns YAML's map[any]any into map[string]any, all the way
// down, so frontmatter crosses to the script as JSON.
func jsonSafe(v any) any {
	switch x := v.(type) {
	case map[any]any:
		out := make(map[string]any, len(x))
		for k, e := range x {
			out[fmt.Sprint(k)] = jsonSafe(e)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(x))
		for k, e := range x {
			out[k] = jsonSafe(e)
		}
		return out
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = jsonSafe(e)
		}
		return out
	}
	return v
}

// ScriptLimits bound refactor scripts; tests point Command at themselves.
var ScriptLimits = script.DefaultLimits

// RunRefactorScript runs a Starlark script that computes a manifest from
// the workspace (read-only, out of process) and plans what it returns.
// Nothing is written: apply the manifest with Refactor and the plan's
// digest, like any other.
func (p *Pipeline) RunRefactorScript(ctx context.Context, src string, opts refactor.Options) (*script.Result, *refactor.Plan, error) {
	res, err := script.Run(ctx, src, &scriptHost{p: p}, ScriptLimits)
	if err != nil {
		return nil, nil, err
	}
	plan, err := p.PlanRefactor(ctx, res.Manifest, opts)
	return res, plan, err
}
