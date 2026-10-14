package refactor

import (
	"strings"
	"unicode/utf8"

	yaml "go.yaml.in/yaml/v3"
)

// scanTypedLinks finds the page references held in typed-link frontmatter
// fields (contradicts, supersedes, related, … — whatever [links]
// typed_fields lists), with byte offsets into content, so a move rewrites
// `supersedes: [[old/page]]` exactly as it rewrites a link in the body.
//
// A value is a reference when it is a plain, single- or double-quoted
// scalar whose source bytes equal its decoded value (no escapes, no folding),
// written either as a path or as [[path|label]]. Anything else — a block
// scalar, an escaped string — cannot be spliced safely, so it is reported
// as Unsplicable and the planner refuses to move its target rather than
// leave it pointing at nothing.
func scanTypedLinks(content []byte, fields []string) []linkRef {
	end := frontmatterEnd(content)
	if end == 0 || len(fields) == 0 {
		return nil
	}
	open := 4
	if strings.HasPrefix(string(content), "---\r\n") {
		open = 5
	}
	closeAt := strings.LastIndex(string(content[:end]), "\n---")
	if closeAt < open {
		return nil
	}
	var doc yaml.Node
	if err := yaml.Unmarshal(content[open:closeAt+1], &doc); err != nil || len(doc.Content) == 0 {
		return nil
	}
	mapping := doc.Content[0]
	if mapping.Kind != yaml.MappingNode {
		return nil
	}
	want := map[string]bool{}
	for _, f := range fields {
		want[f] = true
	}

	lineStarts := []int{0}
	for i, b := range content {
		if b == '\n' {
			lineStarts = append(lineStarts, i+1)
		}
	}
	// The YAML starts on the page's second line, so a node's 1-based YAML
	// line is its 0-based line index in the page. Columns count runes.
	offset := func(n *yaml.Node) int {
		li := n.Line
		if li < 1 || li >= len(lineStarts) {
			return -1
		}
		pos := lineStarts[li]
		for col := 1; col < n.Column && pos < len(content); col++ {
			_, size := utf8.DecodeRune(content[pos:])
			pos += size
		}
		return pos
	}

	var refs []linkRef
	var visit func(n *yaml.Node)
	visit = func(n *yaml.Node) {
		switch n.Kind {
		case yaml.SequenceNode:
			for _, c := range n.Content {
				visit(c)
			}
		case yaml.ScalarNode:
			if r, ok := typedRef(content, n, offset(n)); ok {
				refs = append(refs, r)
			}
		}
	}
	for i := 0; i+1 < len(mapping.Content); i += 2 {
		if want[mapping.Content[i].Value] {
			visit(mapping.Content[i+1])
		}
	}
	return refs
}

func typedRef(content []byte, n *yaml.Node, at int) (linkRef, bool) {
	val := n.Value
	if strings.TrimSpace(val) == "" || at < 0 {
		return linkRef{}, false
	}
	start := at
	switch n.Style {
	case 0:
	case yaml.DoubleQuotedStyle, yaml.SingleQuotedStyle:
		start++
	default:
		return unfixed(n), true
	}
	if start+len(val) > len(content) || string(content[start:start+len(val)]) != val {
		return unfixed(n), true
	}
	inner, lo := val, 0
	if strings.HasPrefix(inner, "[[") && strings.HasSuffix(inner, "]]") {
		inner, lo = inner[2:len(inner)-2], 2
	}
	if i := strings.IndexAny(inner, "|#"); i >= 0 {
		inner = inner[:i]
	}
	lead := len(inner) - len(strings.TrimLeft(inner, " \t"))
	page := strings.TrimSpace(inner)
	if page == "" || schemeRe.MatchString(page) {
		return linkRef{}, false
	}
	s := start + lo + lead
	return linkRef{Kind: kindWiki, Start: s, End: s + len(page), FragEnd: s + len(page), Path: page, Typed: true}, true
}

// unfixed is a typed reference the planner can resolve but not rewrite.
func unfixed(n *yaml.Node) linkRef {
	page := strings.TrimSpace(n.Value)
	if strings.HasPrefix(page, "[[") && strings.HasSuffix(page, "]]") {
		page = page[2 : len(page)-2]
	}
	if i := strings.IndexAny(page, "|#"); i >= 0 {
		page = page[:i]
	}
	return linkRef{Kind: kindWiki, Start: -1, End: -1, Path: strings.TrimSpace(page), Typed: true, Unsplicable: true, Line: n.Line + 1}
}
