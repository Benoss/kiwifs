package refactor

import (
	"context"
	"fmt"
	"path"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/bmatcuk/doublestar/v4"
	"github.com/expr-lang/expr"
	"github.com/expr-lang/expr/vm"
	"github.com/kiwifs/kiwifs/internal/markdown"
)

// ContentEdit reports what the edits in a manifest did to one page.
type ContentEdit struct {
	// Path is where the page lives after the refactor; From is set when
	// it also moves.
	Path    string   `json:"path"`
	From    string   `json:"from,omitempty"`
	Changes []string `json:"changes"`
}

// SelectFunc resolves a DQL query or WHERE expression to page paths.
type SelectFunc func(ctx context.Context, query string) ([]string, error)

// inlineTagChars are the characters an inline #tag may contain, matching
// markdown's inline tag pattern.
var inlineTagRe = regexp.MustCompile(`^[a-zA-Z0-9_/.-]+$`)

func isInlineTagChar(b byte) bool {
	return b == '_' || b == '/' || b == '.' || b == '-' ||
		b >= 'a' && b <= 'z' || b >= 'A' && b <= 'Z' || b >= '0' && b <= '9'
}

// editStep is one manifest edit, compiled, with the pages it applies to.
type editStep struct {
	index   int
	edit    *Edit
	pages   map[string]bool
	when    *vm.Program
	compute map[string]*vm.Program
	moveTo  *template
	suffix  string // on_conflict suffix format; "" means report a conflict
}

var suffixRe = regexp.MustCompile(`^suffix(?:\(\s*"(.*)"\s*\))?$`)

// selectEdits compiles every edit, resolves its selection and when:
// against the workspace as it is now, and turns move_to templates into
// moves. It runs before destinations are checked, so computed moves are
// checked like any other.
func (p *planner) selectEdits(ctx context.Context, m *Manifest) error {
	for i := range m.Edits {
		e := &m.Edits[i]
		st, err := compileEdit(i, e)
		if err != nil {
			p.errorf("edits[%d]: %v", i, err)
			continue
		}
		pages, err := p.selectPages(ctx, e.Select)
		if err != nil {
			p.errorf("edits[%d]: %v", i, err)
			continue
		}
		if st.when != nil {
			for _, f := range sortedKeys(pages) {
				env, err := p.env(ctx, f)
				if err != nil {
					return err
				}
				ok, err := expr.Run(st.when, env)
				if err != nil {
					p.plan.Reject(f, fmt.Sprintf("%s: edits[%d] when: %v", f, i, err))
					continue
				}
				if b, _ := ok.(bool); !b {
					delete(pages, f)
				}
			}
		}
		if len(pages) == 0 {
			p.plan.Warnings = append(p.plan.Warnings, fmt.Sprintf("edits[%d] selects no pages", i))
		}
		st.pages = pages
		p.steps = append(p.steps, st)
	}
	for _, st := range p.steps {
		if st.moveTo != nil {
			if err := p.expandComputedMoves(ctx, st); err != nil {
				return err
			}
		}
	}
	return nil
}

func compileEdit(i int, e *Edit) (*editStep, error) {
	if err := validateEdit(e); err != nil {
		return nil, err
	}
	st := &editStep{index: i, edit: e}
	var err error
	if e.When != "" {
		if st.when, err = compileExpr(e.When, expr.AsBool()); err != nil {
			return nil, fmt.Errorf("when: %w", err)
		}
	}
	if len(e.Compute) > 0 {
		st.compute = map[string]*vm.Program{}
		for k, src := range e.Compute {
			if strings.TrimSpace(k) == "" {
				return nil, fmt.Errorf("compute: empty key")
			}
			if st.compute[k], err = compileExpr(src); err != nil {
				return nil, fmt.Errorf("compute %s: %w", k, err)
			}
		}
	}
	if e.MoveTo != "" {
		if st.moveTo, err = compileTemplate(e.MoveTo); err != nil {
			return nil, fmt.Errorf("move_to: %w", err)
		}
	}
	switch oc := strings.TrimSpace(e.OnConflict); {
	case oc == "" || oc == "error":
	default:
		m := suffixRe.FindStringSubmatch(oc)
		if m == nil {
			return nil, fmt.Errorf(`on_conflict must be "error" or suffix("-%%d"), got %q`, oc)
		}
		st.suffix = m[1]
		if st.suffix == "" {
			st.suffix = "-%d"
		}
		if strings.Count(st.suffix, "%d") != 1 || strings.Count(st.suffix, "%") != 1 || strings.ContainsAny(st.suffix, "/\\") {
			return nil, fmt.Errorf("on_conflict suffix needs exactly one %%d and no slashes")
		}
		if st.moveTo == nil {
			return nil, fmt.Errorf("on_conflict only applies to move_to")
		}
	}
	return st, nil
}

// expandComputedMoves renders move_to for each selected page, in source
// order, and resolves collisions with the suffix policy when there is one.
// A destination is taken when a page that stays, or another destination,
// has the same NFC + case-folded path.
func (p *planner) expandComputedMoves(ctx context.Context, st *editStep) error {
	taken := map[string]bool{}
	for _, f := range p.files {
		if _, moving := p.moved[f]; !moving {
			taken[FoldKey(f)] = true
		}
	}
	for _, to := range p.moved {
		taken[FoldKey(to)] = true
	}
	for _, f := range sortedKeys(st.pages) {
		env, err := p.env(ctx, f)
		if err != nil {
			return err
		}
		raw, err := st.moveTo.render(env)
		if err != nil {
			p.plan.Reject(f, fmt.Sprintf("%s: edits[%d] move_to: %v", f, st.index, err))
			continue
		}
		to, toDir, err := cleanPath(raw)
		if err != nil {
			p.plan.Reject(f, fmt.Sprintf("%s: edits[%d] move_to %q: %v", f, st.index, raw, err))
			continue
		}
		if toDir || to == "" {
			to = joinDir(to, path.Base(f))
		}
		if to == f {
			continue
		}
		delete(taken, FoldKey(f))
		if st.suffix != "" && taken[FoldKey(to)] {
			ext := path.Ext(to)
			base := strings.TrimSuffix(to, ext)
			for n := 2; ; n++ {
				if n > 10000 {
					p.plan.Reject(f, fmt.Sprintf("%s: edits[%d]: no free name for %s", f, st.index, to))
					break
				}
				cand := base + fmt.Sprintf(st.suffix, n) + ext
				if !taken[FoldKey(cand)] {
					to = cand
					break
				}
			}
		}
		taken[FoldKey(to)] = true
		p.addMove(f, to)
	}
	return nil
}

// env is the cached expression environment of a page, from disk.
func (p *planner) env(ctx context.Context, f string) (map[string]any, error) {
	if e, ok := p.envs[f]; ok {
		return e, nil
	}
	content, err := p.read(ctx, f)
	if err != nil {
		return nil, err
	}
	var modified time.Time
	if info, err := p.ws.Store.Stat(ctx, f); err == nil && info != nil {
		modified = info.ModTime.UTC()
	}
	var out []string
	seen := map[string]bool{}
	for _, r := range scanAll(content, p.ws.typedFields()) {
		if r.Unsplicable {
			continue
		}
		if target := resolve(p.pre, r.Kind, r.Path, f); target != "" && !seen[target] {
			seen[target] = true
			out = append(out, target)
		}
	}
	if p.envs == nil {
		p.envs = map[string]map[string]any{}
	}
	e := pageEnv(f, content, modified, p.now, out)
	p.envs[f] = e
	return e, nil
}

func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// planEdits applies every edit and tag rename to the pages they select,
// against the content on disk now, and keeps the result for rewritePages
// to relink and write. Selection never sees the effect of earlier edits or
// of the moves in the same manifest: the whole manifest is evaluated
// against one snapshot.
func (p *planner) planEdits(ctx context.Context, m *Manifest) error {
	if len(p.steps) == 0 && len(m.RenameTags) == 0 {
		return nil
	}
	steps := p.steps
	for i, r := range m.RenameTags {
		if strings.TrimSpace(r.From) == "" || strings.TrimSpace(r.To) == "" || strings.ContainsAny(r.From+r.To, "\n\r,") {
			p.errorf("rename_tags[%d]: from and to must be single tags", i)
		}
	}
	if len(p.plan.Errors) > 0 {
		return nil
	}

	// Tag renames look at every page; plain edits only at what they select.
	candidates := p.files
	if len(m.RenameTags) == 0 {
		union := map[string]bool{}
		for _, st := range steps {
			for f := range st.pages {
				union[f] = true
			}
		}
		candidates = candidates[:0:0]
		for _, f := range p.files {
			if union[f] {
				candidates = append(candidates, f)
			}
		}
	}
	existing := map[string]int{} // lowercased tag → pages carrying it before
	for _, f := range candidates {
		if !isMarkdown(f) {
			continue
		}
		content, err := p.read(ctx, f)
		if err != nil {
			return err
		}
		working := content
		var notes []string
		for _, st := range steps {
			if !st.pages[f] {
				continue
			}
			var env map[string]any
			if st.compute != nil {
				if env, err = p.env(ctx, f); err != nil {
					return err
				}
			}
			out, n, err := applyEdit(working, st, env)
			if err != nil {
				p.plan.Reject(f, fmt.Sprintf("%s: edits[%d]: %v", f, st.index, err))
				break
			}
			working, notes = out, append(notes, n...)
		}
		if len(m.RenameTags) > 0 {
			for _, t := range pageTags(content) {
				existing[strings.ToLower(t)]++
			}
			out, n, err := renameTags(working, m.RenameTags)
			if err != nil {
				p.plan.Reject(f, fmt.Sprintf("%s: %v", f, err))
				continue
			}
			working, notes = out, append(notes, n...)
		}
		if string(working) != string(content) {
			if _, split := p.sections[f]; split {
				p.errorf("%s is both split and edited; split it in a manifest of its own", f)
				continue
			}
			if _, merged := p.merged[f]; merged {
				p.plan.Warnings = append(p.plan.Warnings, fmt.Sprintf("%s is merged away; its edits are dropped", f))
				continue
			}
			p.edited[f] = working
			p.editNotes[f] = notes
		}
	}
	for _, r := range m.RenameTags {
		if n := existing[strings.ToLower(r.To)]; n > 0 && !strings.EqualFold(r.From, r.To) {
			p.plan.Warnings = append(p.plan.Warnings, fmt.Sprintf("tag %q already exists on %d pages; renaming %q merges into it", r.To, n, r.From))
		}
	}
	return nil
}

func validateEdit(e *Edit) error {
	if len(e.Set) == 0 && len(e.Compute) == 0 && len(e.Unset) == 0 && len(e.AddTags) == 0 && len(e.RemoveTags) == 0 && len(e.Replace) == 0 && e.MoveTo == "" {
		return fmt.Errorf("edit changes nothing")
	}
	for k := range e.Set {
		if strings.TrimSpace(k) == "" {
			return fmt.Errorf("set: empty key")
		}
	}
	for _, r := range e.Replace {
		if r.Find == "" {
			return fmt.Errorf("replace: find is empty")
		}
		if r.Regex {
			if len(r.Find) > regexMaxLen {
				return fmt.Errorf("replace: regex longer than %d bytes", regexMaxLen)
			}
			if _, err := regexp.Compile(r.Find); err != nil {
				return fmt.Errorf("replace %q: %v", r.Find, err)
			}
		}
	}
	return nil
}

// selectPages intersects the criteria of a selector over the markdown
// pages that exist now.
func (p *planner) selectPages(ctx context.Context, sel Selector) (map[string]bool, error) {
	if len(sel.Paths) == 0 && sel.Glob == "" && sel.Query == "" {
		return nil, fmt.Errorf("select needs paths, glob or query (glob: \"**\" selects everything)")
	}
	var out map[string]bool
	narrow := func(next map[string]bool) {
		if out == nil {
			out = next
			return
		}
		for f := range out {
			if !next[f] {
				delete(out, f)
			}
		}
	}
	if len(sel.Paths) > 0 {
		set := map[string]bool{}
		for _, raw := range sel.Paths {
			f, _, err := cleanPath(raw)
			if err != nil || !p.exists[f] || !isMarkdown(f) {
				return nil, fmt.Errorf("select path %q: no such page", raw)
			}
			set[f] = true
		}
		narrow(set)
	}
	if sel.Glob != "" {
		if !doublestar.ValidatePattern(sel.Glob) {
			return nil, fmt.Errorf("select glob %q is invalid", sel.Glob)
		}
		set := map[string]bool{}
		for _, f := range p.files {
			if ok, _ := doublestar.Match(sel.Glob, f); ok && isMarkdown(f) {
				set[f] = true
			}
		}
		narrow(set)
	}
	if sel.Query != "" {
		if p.opts.Select == nil {
			return nil, fmt.Errorf("select query needs the sqlite search engine")
		}
		paths, err := p.opts.Select(ctx, sel.Query)
		if err != nil {
			return nil, fmt.Errorf("select query: %w", err)
		}
		// The index can trail the disk; only pages that exist now count,
		// and their content is read from disk below.
		set := map[string]bool{}
		for _, raw := range paths {
			f := strings.TrimPrefix(raw, "/")
			if p.exists[f] && isMarkdown(f) {
				set[f] = true
			}
		}
		narrow(set)
	}
	return out, nil
}

// applyEdit runs one edit on one page's content. env is the page's
// expression environment (pre-change), needed only for compute.
func applyEdit(content []byte, st *editStep, env map[string]any) ([]byte, []string, error) {
	e := st.edit
	var notes []string
	keys := make([]string, 0, len(e.Set))
	for k := range e.Set {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var err error
	for _, k := range keys {
		before := content
		if content, err = markdown.SetFrontmatterField(content, k, normalizeNumber(e.Set[k])); err != nil {
			return nil, nil, err
		}
		if string(before) != string(content) {
			notes = append(notes, "set "+k)
		}
	}
	ckeys := make([]string, 0, len(st.compute))
	for k := range st.compute {
		ckeys = append(ckeys, k)
	}
	sort.Strings(ckeys)
	for _, k := range ckeys {
		v, err := expr.Run(st.compute[k], env)
		if err != nil {
			return nil, nil, fmt.Errorf("compute %s: %w", k, err)
		}
		before := content
		if content, err = markdown.SetFrontmatterField(content, k, normalizeNumber(v)); err != nil {
			return nil, nil, err
		}
		if string(before) != string(content) {
			notes = append(notes, "compute "+k)
		}
	}
	for _, k := range e.Unset {
		before := content
		if content, err = markdown.SetFrontmatterField(content, k, nil); err != nil {
			return nil, nil, err
		}
		if string(before) != string(content) {
			notes = append(notes, "unset "+k)
		}
	}
	if len(e.AddTags) > 0 || len(e.RemoveTags) > 0 {
		tags := pageTags(content)
		has := func(t string) int {
			for i, x := range tags {
				if strings.EqualFold(x, t) {
					return i
				}
			}
			return -1
		}
		changed := false
		for _, t := range e.AddTags {
			if t = strings.TrimSpace(t); t != "" && has(t) < 0 {
				tags = append(tags, t)
				notes = append(notes, "+tag "+t)
				changed = true
			}
		}
		for _, t := range e.RemoveTags {
			if i := has(strings.TrimSpace(t)); i >= 0 {
				tags = append(tags[:i], tags[i+1:]...)
				notes = append(notes, "-tag "+t)
				changed = true
			}
		}
		if changed {
			if content, err = setTags(content, tags); err != nil {
				return nil, nil, err
			}
		}
	}
	for _, r := range e.Replace {
		out, n, err := replaceOutsideCode(content, r)
		if err != nil {
			return nil, nil, err
		}
		if n > 0 {
			content = out
			notes = append(notes, fmt.Sprintf("replace %q (%d)", r.Find, n))
		}
	}
	return content, notes, nil
}

func setTags(content []byte, tags []string) ([]byte, error) {
	if len(tags) == 0 {
		return markdown.SetFrontmatterField(content, "tags", nil)
	}
	return markdown.SetFrontmatterField(content, "tags", tags)
}

// pageTags reads the frontmatter tags list (or single tag string).
func pageTags(content []byte) []string {
	fm, err := markdown.Frontmatter(content)
	if err != nil || fm == nil {
		return nil
	}
	switch v := fm["tags"].(type) {
	case []any:
		out := make([]string, 0, len(v))
		for _, item := range v {
			if s, ok := item.(string); ok && strings.TrimSpace(s) != "" {
				out = append(out, s)
			}
		}
		return out
	case string:
		if strings.TrimSpace(v) != "" {
			return []string{v}
		}
	}
	return nil
}

// renameTags renames tags in the frontmatter list and inline #tags in the
// body, outside code.
func renameTags(content []byte, renames []TagRename) ([]byte, []string, error) {
	var notes []string
	tags := pageTags(content)
	changed := false
	for _, r := range renames {
		var out []string
		seen := map[string]bool{}
		hit := false
		for _, t := range tags {
			if strings.EqualFold(t, r.From) {
				t = r.To
				hit = true
			}
			if seen[strings.ToLower(t)] {
				continue
			}
			seen[strings.ToLower(t)] = true
			out = append(out, t)
		}
		if hit {
			tags = out
			changed = true
			notes = append(notes, fmt.Sprintf("tag %s → %s", r.From, r.To))
		}
	}
	var err error
	if changed {
		if content, err = setTags(content, tags); err != nil {
			return nil, nil, err
		}
	}
	for _, r := range renames {
		if !inlineTagRe.MatchString(r.From) || !inlineTagRe.MatchString(r.To) {
			continue
		}
		out, n := renameInlineTag(content, r.From, r.To)
		if n > 0 {
			content = out
			notes = append(notes, fmt.Sprintf("#%s → #%s (%d inline)", r.From, r.To, n))
		}
	}
	return content, notes, nil
}

// renameInlineTag rewrites #from as #to wherever it stands as a whole tag:
// at the start of a line or after whitespace or an opening bracket, and not
// followed by more tag characters (so #ml does not touch #mlops).
func renameInlineTag(content []byte, from, to string) ([]byte, int) {
	masked := maskCode(content)
	needle := "#" + asciiLower(from)
	// ASCII-only folding keeps byte offsets aligned with content; the tag
	// itself is ASCII (inlineTagRe).
	lower := asciiLower(string(masked))
	var edits []splice
	for i := 0; ; {
		j := strings.Index(lower[i:], needle)
		if j < 0 {
			break
		}
		at := i + j
		end := at + len(needle)
		i = end
		if at > 0 {
			switch masked[at-1] {
			case ' ', '\t', '\n', '(', '[', ',':
			default:
				continue
			}
		}
		if end < len(masked) && isInlineTagChar(masked[end]) {
			continue
		}
		edits = append(edits, splice{start: at + 1, end: end, text: to})
	}
	if len(edits) == 0 {
		return content, 0
	}
	return applySplices(content, edits), len(edits)
}

// replaceOutsideCode applies one replace to the body, never inside the
// frontmatter, a fenced block or an inline code span. A match that touches
// code is skipped whole.
func replaceOutsideCode(content []byte, r Replace) ([]byte, int, error) {
	masked := maskCode(content)
	inCode := func(from, to int) bool {
		for i := from; i < to; i++ {
			if masked[i] != content[i] {
				return true
			}
		}
		return false
	}
	var edits []splice
	if r.Regex {
		re, err := regexp.Compile(r.Find)
		if err != nil {
			return nil, 0, err
		}
		for _, m := range re.FindAllSubmatchIndex(masked, -1) {
			if m[0] == m[1] || inCode(m[0], m[1]) {
				continue
			}
			text := re.Expand(nil, []byte(r.With), content, m)
			edits = append(edits, splice{start: m[0], end: m[1], text: string(text)})
		}
	} else {
		s := string(masked)
		for i := 0; ; {
			j := strings.Index(s[i:], r.Find)
			if j < 0 {
				break
			}
			at := i + j
			i = at + len(r.Find)
			if inCode(at, i) {
				continue
			}
			edits = append(edits, splice{start: at, end: i, text: r.With})
		}
	}
	if len(edits) == 0 {
		return content, 0, nil
	}
	return applySplices(content, edits), len(edits), nil
}

func asciiLower(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + 'a' - 'A'
		}
	}
	return string(b)
}

// normalizeNumber turns a whole float64 (how JSON decodes every number)
// back into an int, so a JSON manifest writes `priority: 2`, not 2.0.
func normalizeNumber(v any) any {
	if x, ok := v.(float64); ok {
		if n := int(x); float64(n) == x {
			return n
		}
	}
	return v
}
