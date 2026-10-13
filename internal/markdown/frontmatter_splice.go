package markdown

import (
	"bytes"
	"reflect"
	"strings"

	yaml "go.yaml.in/yaml/v3"
)

// spliceFrontmatterField sets key by replacing only that key's lines. ok is
// false when the frontmatter cannot be spliced safely; the caller then
// re-encodes the whole block.
func spliceFrontmatterField(content []byte, key string, value any) ([]byte, bool) {
	first := bytes.IndexByte(content, '\n')
	if first < 0 || string(bytes.TrimRight(content[:first], "\r")) != "---" {
		return nil, false
	}
	fm, _, err := SplitFrontmatter(content)
	if err != nil || fm == nil {
		return nil, false
	}
	fmStart := first + 1
	fmEnd := fmStart + len(fm)
	if fmEnd > len(content) || !bytes.Equal(content[fmStart:fmEnd], fm) {
		return nil, false
	}
	eol := "\n"
	if bytes.Contains(fm, []byte("\r\n")) {
		eol = "\r\n"
	}

	var doc yaml.Node
	if err := yaml.Unmarshal(fm, &doc); err != nil {
		return nil, false
	}
	var mapping *yaml.Node
	switch {
	case doc.Kind == 0:
		mapping = &yaml.Node{Kind: yaml.MappingNode}
	case doc.Kind == yaml.DocumentNode && len(doc.Content) == 1 && doc.Content[0].Kind == yaml.MappingNode:
		mapping = doc.Content[0]
	default:
		return nil, false
	}
	var k, v *yaml.Node
	for i := 0; i+1 < len(mapping.Content); i += 2 {
		if mapping.Content[i].Value == key {
			k, v = mapping.Content[i], mapping.Content[i+1]
			break
		}
	}
	if k == nil && value == nil {
		return content, true
	}

	var snippet string
	if value != nil {
		valNode, err := valueToYAMLNode(value)
		if err != nil {
			return nil, false
		}
		keyNode := &yaml.Node{Kind: yaml.ScalarNode, Value: key}
		if k != nil {
			keepStyle(valNode, v)
			keyNode.Style = k.Style
		}
		var ok bool
		if snippet, ok = encodePair(keyNode, valNode, eol); !ok {
			return nil, false
		}
	}

	lines := splitLinesKeepEOL(fm)
	var out []string
	if k == nil {
		out = append(out, lines...)
		if n := len(out); n > 0 && !strings.HasSuffix(out[n-1], "\n") {
			out[n-1] += eol
		}
		out = append(out, snippet)
	} else {
		start, end, ok := valueLines(lines, k, v)
		if !ok {
			return nil, false
		}
		out = append(out, lines[:start]...)
		if snippet != "" {
			out = append(out, snippet)
		}
		out = append(out, lines[end:]...)
	}
	newFM := strings.Join(out, "")
	if !onlyKeyChanged(fm, []byte(newFM), key, value) {
		return nil, false
	}
	var buf bytes.Buffer
	buf.Grow(len(content) + len(snippet))
	buf.Write(content[:fmStart])
	buf.WriteString(newFM)
	buf.Write(content[fmEnd:])
	return buf.Bytes(), true
}

// valueLines returns the half-open line range [start, end) holding a
// top-level key and its value: the key's line plus every following line
// that is indented (or, for an indentless block sequence, starts with "-").
// Trailing blank lines stay outside. A comment inside the range would be
// dropped by the rewrite, so it makes the splice refuse.
func valueLines(lines []string, k, v *yaml.Node) (int, int, bool) {
	if k.Column != 1 || k.Line < 1 || k.Line > len(lines) {
		return 0, 0, false
	}
	start := k.Line - 1
	last := start
	for j := start + 1; j < len(lines); j++ {
		l := strings.TrimRight(lines[j], "\r\n")
		if strings.TrimSpace(l) == "" {
			continue
		}
		if l[0] != ' ' && l[0] != '\t' && !(l[0] == '-' && v.Kind == yaml.SequenceNode) {
			break
		}
		if strings.HasPrefix(strings.TrimSpace(l), "#") {
			return 0, 0, false
		}
		last = j
	}
	return start, last + 1, true
}

// keepStyle makes a replacement value look like the one it replaces: a flow
// list stays a flow list, a quoted string stays quoted the same way, and an
// inline comment survives.
func keepStyle(n, old *yaml.Node) {
	if old == nil {
		return
	}
	if n.Kind == old.Kind {
		switch n.Kind {
		case yaml.SequenceNode, yaml.MappingNode:
			n.Style |= old.Style & yaml.FlowStyle
		case yaml.ScalarNode:
			if n.Tag == "!!str" && old.Style&(yaml.DoubleQuotedStyle|yaml.SingleQuotedStyle) != 0 {
				n.Style = old.Style & (yaml.DoubleQuotedStyle | yaml.SingleQuotedStyle)
			}
		}
	}
	n.LineComment = old.LineComment
}

// encodePair encodes one "key: value" entry the way hand-written
// frontmatter looks: two-space indentation, no document markers.
func encodePair(k, v *yaml.Node, eol string) (string, bool) {
	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(&yaml.Node{Kind: yaml.MappingNode, Content: []*yaml.Node{k, v}}); err != nil {
		return "", false
	}
	if err := enc.Close(); err != nil {
		return "", false
	}
	s := buf.String()
	if eol != "\n" {
		s = strings.ReplaceAll(s, "\n", eol)
	}
	return s, true
}

func splitLinesKeepEOL(b []byte) []string {
	var out []string
	s := string(b)
	for s != "" {
		i := strings.IndexByte(s, '\n')
		if i < 0 {
			out = append(out, s)
			break
		}
		out = append(out, s[:i+1])
		s = s[i+1:]
	}
	return out
}

// onlyKeyChanged decodes both versions and checks that key now holds value
// (or is gone) and that no other key changed. It is the guard that lets the
// splice be clever: anything it gets wrong falls back to re-encoding.
func onlyKeyChanged(before, after []byte, key string, value any) bool {
	var a, b map[string]any
	if err := yaml.Unmarshal(before, &a); err != nil {
		return false
	}
	if err := yaml.Unmarshal(after, &b); err != nil {
		return false
	}
	if a == nil {
		a = map[string]any{}
	}
	if b == nil {
		b = map[string]any{}
	}
	got, has := b[key]
	if value == nil {
		if has {
			return false
		}
	} else {
		want, err := roundTrip(value)
		if err != nil || !has || !reflect.DeepEqual(got, want) {
			return false
		}
	}
	delete(a, key)
	delete(b, key)
	return reflect.DeepEqual(a, b)
}

// roundTrip is value as YAML decodes it, so it compares equal to what the
// spliced frontmatter decodes to.
func roundTrip(value any) (any, error) {
	n, err := valueToYAMLNode(value)
	if err != nil {
		return nil, err
	}
	data, err := yaml.Marshal(n)
	if err != nil {
		return nil, err
	}
	var out any
	err = yaml.Unmarshal(data, &out)
	return out, err
}
