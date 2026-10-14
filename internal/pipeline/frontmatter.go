package pipeline

import (
	"context"
	"errors"
	"fmt"
	"sort"

	"github.com/kiwifs/kiwifs/internal/markdown"
	"github.com/kiwifs/kiwifs/internal/storage"
)

// PatchFrontmatter sets (or, with a nil value, removes) frontmatter fields
// on one page and writes it back through WriteWithOpts, so formatting,
// validation, workflow transitions and the commit all apply.
//
// The write is pinned to the ETag of the content the patch was computed
// from, so an edit landing in between is never overwritten. With ifMatch
// the caller pins its own earlier read and gets ErrConflict if the page has
// moved on; without it, a lost race is retried against the fresh content.
func (p *Pipeline) PatchFrontmatter(ctx context.Context, path string, fields map[string]any, ifMatch, actor string) (Result, error) {
	return p.PatchFrontmatterAs(ctx, path, fields, ifMatch, actor, "", false)
}

// PatchFrontmatterAs is PatchFrontmatter as a field manager: keys whose
// value another manager set are refused with a *FieldConflictError unless
// force, and the keys this patch changes become manager's. An empty
// manager patches without taking part in ownership.
func (p *Pipeline) PatchFrontmatterAs(ctx context.Context, path string, fields map[string]any, ifMatch, actor, manager string, force bool) (Result, error) {
	if !storage.IsKnowledgeFile(path) {
		return Result{}, fmt.Errorf("frontmatter patch requires a markdown file: %s", path)
	}
	if len(fields) == 0 {
		return Result{}, fmt.Errorf("at least one frontmatter field is required")
	}
	keys := make([]string, 0, len(fields))
	for k := range fields {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	for attempt := 0; ; attempt++ {
		content, err := p.Store.Read(ctx, path)
		if err != nil {
			return Result{}, err
		}
		etag := ETag(content)
		if ifMatch != "" && ifMatch != "*" && ifMatch != etag {
			return Result{}, ErrConflict
		}
		before := content
		for _, k := range keys {
			content, err = markdown.SetFrontmatterField(content, k, NormalizeJSONNumber(fields[k]))
			if err != nil {
				return Result{}, err
			}
		}
		if manager != "" && !force {
			p.fieldOwners.mu.Lock()
			owners := p.loadFieldOwners()[path]
			p.fieldOwners.mu.Unlock()
			if conflicts := fieldConflicts(owners, before, content, manager); len(conflicts) > 0 {
				return Result{}, &FieldConflictError{Path: path, Conflicts: conflicts}
			}
		}
		res, err := p.WriteWithOpts(ctx, path, content, actor, WriteOpts{IfMatch: etag})
		if errors.Is(err, ErrConflict) && (ifMatch == "" || ifMatch == "*") && attempt < staleRetries {
			continue
		}
		if err == nil {
			p.recordFieldOwners(path, manager, before, content)
		}
		return res, err
	}
}

// NormalizeJSONNumber turns a whole float64 (how encoding/json decodes every
// number) back into an int, so it is written as a YAML int.
func NormalizeJSONNumber(v any) any {
	if x, ok := v.(float64); ok {
		if n := int(x); float64(n) == x {
			return n
		}
	}
	return v
}
