package refactor

import (
	"fmt"
	"sort"
	"strings"

	"github.com/bmatcuk/doublestar/v4"
	"github.com/kiwifs/kiwifs/internal/markdown"
)

// Policy is a workspace's standing rules for restructuring ([refactor] in
// config). The zero value allows everything and never asks for approval.
type Policy struct {
	// ApprovalFiles and ApprovalLinks: a plan that writes or deletes more
	// files, or rewrites more links, than these needs a human's approval
	// before an agent may apply it. Zero disables the check.
	ApprovalFiles int
	ApprovalLinks int
	// Protect lists globs of paths no plan may write, delete or move.
	Protect []string
	// Scope, when set, is the only folder plans may touch.
	Scope string
	// FolderMap is the page that lists where pages belong; moving a page
	// into a folder it does not list is a warning.
	FolderMap string
}

// Approval says whether a plan needs a human's approval, and why.
type Approval struct {
	Required bool   `json:"required"`
	Reason   string `json:"reason,omitempty"`
}

// Integrity is the link health of the workspace the plan leaves behind,
// computed from the plan itself.
type Integrity struct {
	// Unresolved counts links in the written pages that will point
	// nowhere. The plan never breaks a working link, so these were
	// already broken (or were edited in by a replace).
	Unresolved int `json:"unresolved"`
	// Orphaned lists pages that had links pointing at them before and will
	// have none after: typically pages only a merged-away page linked to.
	Orphaned []string `json:"orphaned,omitempty"`
	// Complete is false when the plan did not read every page (an
	// edits-only plan), so orphans cannot be known.
	Complete bool `json:"complete"`
}

// enforcePolicy rejects touching protected or out-of-scope paths and
// warns about moves into folders the folder map does not list.
func (p *planner) enforcePolicy() {
	pol := p.opts.Policy
	scope := strings.Trim(pol.Scope, "/")
	check := func(path, what string) {
		if path == "" {
			return
		}
		if scope != "" && path != scope && !strings.HasPrefix(path, scope+"/") {
			p.plan.Reject(path, fmt.Sprintf("%s %s is outside the refactor scope %s/", what, path, scope))
			return
		}
		for _, g := range pol.Protect {
			if ok, _ := doublestar.Match(strings.TrimPrefix(g, "/"), path); ok {
				p.plan.Reject(path, fmt.Sprintf("%s %s is protected (%s)", what, path, g))
				return
			}
		}
	}
	for _, w := range p.plan.Ops.Writes {
		if w.Source != "" && w.Source != w.Path {
			check(w.Source, "moving")
		}
		check(w.Path, "writing")
	}
	for _, d := range p.plan.Ops.Deletes {
		check(d.Path, "deleting")
	}
}

// warnUnmappedFolders flags moves into folders the folder map page does
// not list. A folder is mapped when it, or a folder above it, is listed.
func (p *planner) warnUnmappedFolders(folders []string) {
	if folders == nil {
		return
	}
	mapped := func(dir string) bool {
		if dir == "" {
			return true
		}
		for _, f := range folders {
			if dir == f || strings.HasPrefix(dir, f+"/") {
				return true
			}
		}
		return false
	}
	seen := map[string]bool{}
	for _, mv := range p.plan.Moves {
		d := dirOf(mv.To)
		if !mapped(d) && !seen[d] {
			seen[d] = true
			p.plan.Warnings = append(p.plan.Warnings, fmt.Sprintf("%s/ is not in the folder map %s", d, p.opts.Policy.FolderMap))
		}
	}
}

// ParseFolderMap reads the folders a folder-map page lists: its
// frontmatter folders: list if it has one, else every "- path" bullet.
func ParseFolderMap(content []byte) []string {
	clean := func(s string) string {
		s = strings.TrimSpace(s)
		s = strings.Trim(s, "`")
		if strings.HasPrefix(s, "[[") && strings.HasSuffix(s, "]]") {
			s = s[2 : len(s)-2]
		}
		return strings.Trim(strings.TrimSpace(s), "/")
	}
	out := []string{}
	if fm, err := markdown.Frontmatter(content); err == nil && fm != nil {
		if list, ok := fm["folders"].([]any); ok {
			for _, v := range list {
				if s, ok := v.(string); ok && clean(s) != "" {
					out = append(out, clean(s))
				}
			}
			return out
		}
	}
	_, body, _ := markdown.SplitFrontmatter(content)
	for _, line := range strings.Split(string(body), "\n") {
		t := strings.TrimSpace(line)
		if !strings.HasPrefix(t, "- ") && !strings.HasPrefix(t, "* ") {
			continue
		}
		item := t[2:]
		if i := strings.Index(item, " — "); i >= 0 {
			item = item[:i]
		}
		if i := strings.Index(item, " - "); i >= 0 {
			item = item[:i]
		}
		if f := clean(item); f != "" && !strings.ContainsAny(f, " \t") {
			out = append(out, f)
		}
	}
	return out
}

// approval decides whether the plan is big enough to need a human.
func (p *planner) approval() *Approval {
	pol := p.opts.Policy
	files := len(p.plan.Ops.Writes) + len(p.plan.Ops.Deletes)
	var reasons []string
	if pol.ApprovalFiles > 0 && files > pol.ApprovalFiles {
		reasons = append(reasons, fmt.Sprintf("%d files (limit %d)", files, pol.ApprovalFiles))
	}
	if pol.ApprovalLinks > 0 && p.plan.Stats.Rewritten > pol.ApprovalLinks {
		reasons = append(reasons, fmt.Sprintf("%d rewritten links (limit %d)", p.plan.Stats.Rewritten, pol.ApprovalLinks))
	}
	if len(reasons) == 0 {
		return &Approval{}
	}
	return &Approval{Required: true, Reason: strings.Join(reasons, ", ")}
}

// integrity tallies inbound links before and after from what rewritePages
// resolved.
func (p *planner) integrity(complete bool) *Integrity {
	in := &Integrity{Unresolved: p.unresolvedAfter, Complete: complete}
	if !complete {
		return in
	}
	for target, n := range p.inboundBefore {
		if n == 0 {
			continue
		}
		after := p.final(target)
		if _, merged := p.merged[target]; merged {
			continue
		}
		if p.inboundAfter[after] == 0 {
			in.Orphaned = append(in.Orphaned, after)
		}
	}
	sort.Strings(in.Orphaned)
	return in
}
