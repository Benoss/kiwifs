package refactor

import (
	"context"
	"fmt"
	"path"
	"regexp"
	"sort"
	"strings"
	"unicode"
)

// Split breaks one page into a page per heading:
//
//	split:
//	  - from: guides/handbook.md
//	    level: 2              # split at ## headings (default 2)
//	    into: guides/handbook/ # where the new pages go (default: a folder
//	                           # named after the page, next to it)
//	    confirm: true         # a split is plan-only until confirmed
//
// Each section becomes <into>/<slug of its heading>.md, titled with the
// heading, its sub-headings promoted to match. In the original page the
// section is replaced by a link to its new page, so the page reads as an
// index. References to page#heading anywhere follow the section to its new
// page; references to the page itself still reach the index.
type Split struct {
	From    string `json:"from" yaml:"from"`
	Level   int    `json:"level,omitempty" yaml:"level"`
	Into    string `json:"into,omitempty" yaml:"into"`
	Confirm bool   `json:"confirm,omitempty" yaml:"confirm"`
}

// SplitView reports one split in a plan.
type SplitView struct {
	From  string   `json:"from"`
	Pages []string `json:"pages"`
}

type splitSection struct {
	path    string
	content []byte
}

var atxHeadingRe = regexp.MustCompile(`^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$`)

// anchorKey normalizes a heading or a #fragment for comparison: "Install
// Guide", "install-guide" and "Install guide!" are the same anchor.
func anchorKey(s string) string {
	var b strings.Builder
	dash := false
	for _, r := range strings.ToLower(strings.TrimSpace(s)) {
		switch {
		case unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_':
			if dash && b.Len() > 0 {
				b.WriteByte('-')
			}
			dash = false
			b.WriteRune(r)
		case r == ' ' || r == '-' || r == '\t':
			dash = true
		}
	}
	return b.String()
}

// heading is one ATX heading outside code.
type heading struct {
	level      int
	text       string
	start, end int // the line, without its newline
}

func headings(content []byte) []heading {
	masked := maskCode(content)
	var out []heading
	pos := 0
	for pos < len(masked) {
		end := pos
		for end < len(masked) && masked[end] != '\n' {
			end++
		}
		if m := atxHeadingRe.FindSubmatch(masked[pos:end]); m != nil {
			out = append(out, heading{level: len(m[1]), text: string(m[2]), start: pos, end: end})
		}
		pos = end + 1
	}
	return out
}

// expandSplits plans every split: the new pages, the original page turned
// into an index, and the anchors references will follow.
func (p *planner) expandSplits(ctx context.Context, splits []Split) error {
	for _, sp := range splits {
		from, _, err := cleanPath(sp.From)
		if err != nil || !p.exists[from] || !isMarkdown(from) {
			p.errorf("split %q: no such page", sp.From)
			continue
		}
		if _, ok := p.moved[from]; ok {
			p.errorf("split %s: the page also moves; split it first, move it after", from)
			continue
		}
		if _, ok := p.merged[from]; ok {
			p.errorf("split %s: the page is merged away", from)
			continue
		}
		level := sp.Level
		if level == 0 {
			level = 2
		}
		if level < 1 || level > 6 {
			p.errorf("split %s: level must be 1–6", from)
			continue
		}
		into := strings.TrimSuffix(from, path.Ext(from))
		if sp.Into != "" {
			if into, _, err = cleanPath(sp.Into); err != nil {
				p.errorf("split %s: into %q: %v", from, sp.Into, err)
				continue
			}
		}
		if _, dup := p.sections[from]; dup {
			p.errorf("split %s: split twice", from)
			continue
		}
		content, err := p.read(ctx, from)
		if err != nil {
			return err
		}
		p.splitPage(from, into, level, content)
		if !sp.Confirm {
			p.plan.PlanOnly = append(p.plan.PlanOnly, fmt.Sprintf("split %s is a preview: add confirm: true to apply it", from))
		}
	}
	return nil
}

func (p *planner) splitPage(from, into string, level int, content []byte) {
	hs := headings(content)
	type span struct {
		h          heading
		start, end int // the section, heading line included
	}
	var spans []span
	for i, h := range hs {
		if h.level != level {
			continue
		}
		end := len(content)
		for _, next := range hs[i+1:] {
			if next.level <= level {
				end = next.start
				break
			}
		}
		spans = append(spans, span{h: h, start: h.start, end: end})
	}
	if len(spans) == 0 {
		p.errorf("split %s: no level-%d headings", from, level)
		return
	}

	if p.sections == nil {
		p.sections = map[string]map[string]string{}
	}
	anchors := map[string]string{}
	used := map[string]bool{}
	var pages []string
	for _, s := range spans {
		name := Slug(s.h.text)
		dest := joinDir(into, name+".md")
		for n := 2; used[FoldKey(dest)]; n++ {
			dest = joinDir(into, fmt.Sprintf("%s-%d.md", name, n))
		}
		used[FoldKey(dest)] = true
		pages = append(pages, dest)
		if k := anchorKey(s.h.text); k != "" {
			if _, dup := anchors[k]; !dup {
				anchors[k] = dest
			}
		}
	}
	p.sections[from] = anchors

	// Each section becomes a page; in the original it becomes a link.
	// Consecutive sections become one list; a blank line that separated a
	// section from what follows it is kept.
	var index []splice
	for i, s := range spans {
		dest := pages[i]
		body := retargetSameAnchors(content[s.start:s.end], anchors, dest)
		p.splitPages = append(p.splitPages, splitSection{path: dest, content: promote(body, level-1)})
		p.created[dest] = from
		trail := ""
		nextIsSection := i+1 < len(spans) && spans[i+1].start == s.end
		if !nextIsSection && s.end < len(content) && strings.HasSuffix(string(content[s.start:s.end]), "\n\n") {
			trail = "\n"
		}
		index = append(index, splice{start: s.start, end: s.end, text: fmt.Sprintf("- [[%s|%s]]\n%s", trimMD(dest), s.h.text, trail)})
	}
	rest := applySplices(content, index)
	p.edited[from] = retargetSameAnchors(rest, anchors, from)
	p.editNotes[from] = []string{fmt.Sprintf("split into %d pages", len(pages))}
	p.plan.Splits = append(p.plan.Splits, SplitView{From: from, Pages: pages})
}

// promote raises every heading outside code by n levels, so a section
// split at ## starts with # and its ### become ##.
func promote(content []byte, n int) []byte {
	if n <= 0 {
		return content
	}
	var edits []splice
	for _, h := range headings(content) {
		cut := n
		if h.level-cut < 1 {
			cut = h.level - 1
		}
		if cut > 0 {
			edits = append(edits, splice{start: h.start, end: h.start + cut})
		}
	}
	return applySplices(content, edits)
}

var (
	sameMarkdownAnchorRe = regexp.MustCompile(`\]\(#([^)\s]+)\)`)
	sameWikiAnchorRe     = regexp.MustCompile(`\[\[#([^\]|]+)(\|[^\]]*)?\]\]`)
)

// retargetSameAnchors rewrites links to a heading of the same page
// (](#install), [[#Install]]) that now lives on a split-out page, as links
// to that page from where the content lives (at). Links to the section the
// content is itself part of stay as they are.
func retargetSameAnchors(content []byte, anchors map[string]string, at string) []byte {
	masked := maskCode(content)
	var edits []splice
	for _, m := range sameMarkdownAnchorRe.FindAllSubmatchIndex(masked, -1) {
		target, ok := anchors[anchorKey(decodeHref(string(masked[m[2]:m[3]])))]
		if !ok || target == at {
			continue
		}
		edits = append(edits, splice{start: m[0], end: m[1], text: "](" + encodeHref(relPath(dirOf(at), target)) + ")"})
	}
	for _, m := range sameWikiAnchorRe.FindAllSubmatchIndex(masked, -1) {
		heading := string(masked[m[2]:m[3]])
		target, ok := anchors[anchorKey(heading)]
		if !ok || target == at {
			continue
		}
		label := strings.TrimSpace(heading)
		if m[4] >= 0 {
			label = strings.TrimPrefix(string(masked[m[4]:m[5]]), "|")
		}
		edits = append(edits, splice{start: m[0], end: m[1], text: "[[" + trimMD(target) + "|" + label + "]]"})
	}
	if len(edits) == 0 {
		return content
	}
	return applySplices(content, edits)
}

// writeSplitPages relinks and writes the new pages: their content was
// written at the original page's path, so its references resolve from
// there and are respelled from the new page's folder.
func (p *planner) writeSplitPages() {
	sort.SliceStable(p.splitPages, func(i, j int) bool { return p.splitPages[i].path < p.splitPages[j].path })
	for _, sp := range p.splitPages {
		src := p.created[sp.path]
		res := p.relink(src, sp.path, sp.content)
		p.tally(res, sp.path, true)
		p.plan.Ops.Writes = append(p.plan.Ops.Writes, FileWrite{Path: sp.path, Content: res.updated, Edited: true})
	}
}
