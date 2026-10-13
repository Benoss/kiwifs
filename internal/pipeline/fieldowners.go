package pipeline

import (
	"context"
	"crypto/sha1"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/kiwifs/kiwifs/internal/markdown"
)

// Frontmatter field ownership, after Kubernetes server-side apply: when an
// agent sets a frontmatter key through PatchFrontmatter (or a manifest
// edit) as a field manager, it owns that key. Another manager changing the
// key's value gets a conflict naming the owner, unless it forces. Two
// agents that each own their own keys can patch the same page concurrently
// without either clobbering the other's fields.
//
// Ownership is evidence, not a lock: when the key's value is no longer the
// one its owner set (a person edited the page, a full write replaced it),
// the ownership is stale and nobody owns the key until it is set again.

// fieldOwnersPath records ownership. It is derived state: losing it only
// forgets who owns what.
const fieldOwnersPath = ".kiwi/state/field-owners.json"

// FieldOwner is who set a key, and the value they set (hashed).
type FieldOwner struct {
	Manager string    `json:"manager"`
	Value   string    `json:"value"`
	At      time.Time `json:"at"`
}

// FieldConflict is one key another manager owns.
type FieldConflict struct {
	Key     string `json:"key"`
	Manager string `json:"manager"`
}

// FieldConflictError is returned when a patch would change keys other
// managers own. Nothing has been written.
type FieldConflictError struct {
	Path      string
	Conflicts []FieldConflict
}

// ErrFieldConflict matches a *FieldConflictError with errors.Is.
var ErrFieldConflict = errors.New("frontmatter field owned by another manager")

func (e *FieldConflictError) Error() string {
	var parts []string
	for _, c := range e.Conflicts {
		parts = append(parts, fmt.Sprintf("%s (managed by %s)", c.Key, c.Manager))
	}
	return fmt.Sprintf("%s: %s; force to take them over", e.Path, strings.Join(parts, ", "))
}

func (e *FieldConflictError) Is(target error) bool { return target == ErrFieldConflict }

type fieldOwnerStore struct {
	mu sync.Mutex
}

// valueHash identifies a frontmatter value independently of YAML styling.
func valueHash(v any) string {
	data, _ := json.Marshal(jsonSafe(v))
	return fmt.Sprintf("%x", sha1.Sum(data))[:16]
}

func (p *Pipeline) loadFieldOwners() map[string]map[string]FieldOwner {
	out := map[string]map[string]FieldOwner{}
	if p.Root == "" {
		return out
	}
	data, err := os.ReadFile(filepath.Join(p.Root, filepath.FromSlash(fieldOwnersPath)))
	if err == nil {
		_ = json.Unmarshal(data, &out)
	}
	return out
}

func (p *Pipeline) saveFieldOwners(all map[string]map[string]FieldOwner) {
	if p.Root == "" {
		return
	}
	for path, keys := range all {
		if len(keys) == 0 {
			delete(all, path)
		}
	}
	data, err := json.Marshal(all)
	if err != nil {
		return
	}
	_ = writeAtomic(filepath.Join(p.Root, filepath.FromSlash(fieldOwnersPath)), data)
}

// FieldOwners returns who owns which frontmatter keys of the page now,
// leaving out ownership the page's current values have made stale.
func (p *Pipeline) FieldOwners(ctx context.Context, path string) (map[string]FieldOwner, error) {
	content, err := p.Store.Read(ctx, path)
	if err != nil {
		return nil, err
	}
	p.fieldOwners.mu.Lock()
	defer p.fieldOwners.mu.Unlock()
	return liveOwners(p.loadFieldOwners()[path], content), nil
}

func liveOwners(owners map[string]FieldOwner, content []byte) map[string]FieldOwner {
	out := map[string]FieldOwner{}
	if len(owners) == 0 {
		return out
	}
	fm, _ := markdown.Frontmatter(content)
	for k, o := range owners {
		if v, ok := fm[k]; ok && valueHash(v) == o.Value {
			out[k] = o
		}
	}
	return out
}

// fieldConflicts lists the keys whose value changes between before and
// after that a live owner other than manager holds.
func fieldConflicts(owners map[string]FieldOwner, before, after []byte, manager string) []FieldConflict {
	live := liveOwners(owners, before)
	if len(live) == 0 {
		return nil
	}
	fb, _ := markdown.Frontmatter(before)
	fa, _ := markdown.Frontmatter(after)
	var out []FieldConflict
	for k, o := range live {
		if o.Manager == manager {
			continue
		}
		vb, inBefore := fb[k]
		va, inAfter := fa[k]
		if inBefore != inAfter || valueHash(vb) != valueHash(va) {
			out = append(out, FieldConflict{Key: k, Manager: o.Manager})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Key < out[j].Key })
	return out
}

// recordFieldOwners makes manager the owner of every key that changed
// between before and after on path; removed keys lose their owner.
func (p *Pipeline) recordFieldOwners(path, manager string, before, after []byte) {
	if manager == "" {
		return
	}
	fb, _ := markdown.Frontmatter(before)
	fa, _ := markdown.Frontmatter(after)
	p.fieldOwners.mu.Lock()
	defer p.fieldOwners.mu.Unlock()
	all := p.loadFieldOwners()
	owners := all[path]
	if owners == nil {
		owners = map[string]FieldOwner{}
	}
	changed := false
	for k, va := range fa {
		if vb, ok := fb[k]; ok && valueHash(vb) == valueHash(va) {
			continue
		}
		owners[k] = FieldOwner{Manager: manager, Value: valueHash(va), At: time.Now().UTC()}
		changed = true
	}
	for k := range fb {
		if _, ok := fa[k]; !ok {
			delete(owners, k)
			changed = true
		}
	}
	if changed {
		all[path] = owners
		p.saveFieldOwners(all)
	}
}

// moveFieldOwners keeps ownership with pages a restructuring moved; a
// path mapped to "" was merged away and its ownership dropped.
func (p *Pipeline) moveFieldOwners(renames map[string]string) {
	if len(renames) == 0 {
		return
	}
	p.fieldOwners.mu.Lock()
	defer p.fieldOwners.mu.Unlock()
	all := p.loadFieldOwners()
	moved := map[string]map[string]FieldOwner{}
	changed := false
	for from, to := range renames {
		if owners, ok := all[from]; ok {
			delete(all, from)
			changed = true
			if to != "" {
				moved[to] = owners
			}
		}
	}
	if !changed {
		return
	}
	for to, owners := range moved {
		all[to] = owners
	}
	p.saveFieldOwners(all)
}

// fieldOwnerCheck is what the planner asks: who else owns a key of a page
// whose value would change.
func (p *Pipeline) fieldOwnerCheck() func(path string, before, after []byte, manager string) []string {
	return func(path string, before, after []byte, manager string) []string {
		p.fieldOwners.mu.Lock()
		owners := p.loadFieldOwners()[path]
		p.fieldOwners.mu.Unlock()
		var out []string
		for _, c := range fieldConflicts(owners, before, after, manager) {
			out = append(out, fmt.Sprintf("%s (managed by %s)", c.Key, c.Manager))
		}
		return out
	}
}
