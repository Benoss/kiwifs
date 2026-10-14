// Package markdown parses knowledge-base markdown files on the backend.
//
// Two outputs callers care about:
//   - Frontmatter (YAML, at the top of the file) — surfaced to the tree /
//     page API so the UI can show metadata badges without shipping a
//     parser itself.
//   - Heading AST — used by the /toc endpoint and by the lint engine to
//     spot empty sections and broken anchor links.
//
// Built on goldmark (frontmatter decoded with yaml.v2, see goldmark.go) so we stay on a battle-tested parser
// and share configuration with the frontend wherever it uses the same
// library.
package markdown

import (
	"bytes"
	"fmt"
	"regexp"
	"strings"
	"unicode"

	"github.com/yuin/goldmark/v2/ast"
	"github.com/yuin/goldmark/v2/extension"
	"github.com/yuin/goldmark/v2/parser"
)

// Heading is one entry in the table of contents.
type Heading struct {
	Level int    `json:"level"` // 1..6
	Text  string `json:"text"`
	Slug  string `json:"slug"` // slugified, suitable for anchor links
}

// Parsed captures everything we extract from a markdown file in one pass.
type Parsed struct {
	Frontmatter map[string]any `json:"frontmatter,omitempty"`
	Headings    []Heading      `json:"headings,omitempty"`
}

// MaxFrontmatterBytes caps the raw YAML frontmatter block at 64 KB.
// This is a belt-and-suspenders defence against YAML bomb amplification:
// gopkg.in/yaml.v3 already rejects excessive aliasing, but a size cap
// protects against bloated frontmatter regardless of parser behaviour.
// 64 KB is generous for any legitimate metadata; Kubernetes uses 3 MB for
// entire manifests.
const MaxFrontmatterBytes = 64 * 1024

// Parse returns frontmatter + heading outline for content. A malformed
// frontmatter block returns it as empty but still yields the heading list
// — we'd rather render a page with partial metadata than fail open.
// Frontmatter blocks exceeding MaxFrontmatterBytes are silently treated
// as empty (the body/headings are still extracted).
func Parse(content []byte) (*Parsed, error) {
	fm, _, _ := SplitFrontmatter(content)
	if len(fm) > MaxFrontmatterBytes {
		return parseFrontmatterless(content)
	}

	doc, pc := parse(content)

	out := &Parsed{Frontmatter: frontmatterOf(pc)}

	ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		h, ok := n.(*ast.Heading)
		if !ok {
			return ast.WalkContinue, nil
		}
		var buf bytes.Buffer
		for c := h.FirstChild(); c != nil; c = c.NextSibling() {
			extractText(&buf, c, content)
		}
		txt := strings.TrimSpace(buf.String())
		if txt == "" {
			return ast.WalkContinue, nil
		}
		out.Headings = append(out.Headings, Heading{
			Level: h.Level,
			Text:  txt,
			Slug:  Slugify(txt),
		})
		return ast.WalkContinue, nil
	})

	return out, nil
}

// parseFrontmatterless extracts headings only, skipping frontmatter parsing
// entirely. Used when the frontmatter block is too large (potential bomb).
func parseFrontmatterless(content []byte) (*Parsed, error) {
	_, body, _ := SplitFrontmatter(content)
	if body == nil {
		body = content
	}
	doc := parser.New().Parse(body)
	out := &Parsed{}
	ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		h, ok := n.(*ast.Heading)
		if !ok {
			return ast.WalkContinue, nil
		}
		var buf bytes.Buffer
		for c := h.FirstChild(); c != nil; c = c.NextSibling() {
			extractText(&buf, c, body)
		}
		txt := strings.TrimSpace(buf.String())
		if txt != "" {
			out.Headings = append(out.Headings, Heading{Level: h.Level, Text: txt, Slug: Slugify(txt)})
		}
		return ast.WalkContinue, nil
	})
	return out, nil
}

// Frontmatter is a lightweight helper when callers only want the metadata
// block — avoids walking the full AST. Returns empty if the frontmatter
// exceeds MaxFrontmatterBytes.
func Frontmatter(content []byte) (map[string]any, error) {
	fm, _, _ := SplitFrontmatter(content)
	if len(fm) > MaxFrontmatterBytes {
		return map[string]any{}, nil
	}
	_, pc := parse(content)
	m := frontmatterOf(pc)
	if m == nil {
		return map[string]any{}, nil
	}
	return m, nil
}

// SplitFrontmatter returns the YAML frontmatter block (without the `---`
// delimiters) and the remaining body. A file without a leading `---\n`
// returns fm=nil and the whole input as body.
func SplitFrontmatter(content []byte) (fm, body []byte, err error) {
	delim := []byte("---")

	line, rest, ok := bytes.Cut(content, []byte("\n"))
	if !ok {
		return nil, content, nil
	}
	if !bytes.Equal(bytes.TrimRight(line, "\r"), delim) {
		return nil, content, nil
	}
	scanner := rest
	pos := 0
	for {
		nl := bytes.IndexByte(scanner, '\n')
		var current []byte
		if nl < 0 {
			current = scanner
		} else {
			current = scanner[:nl]
		}
		if bytes.Equal(bytes.TrimRight(current, "\r"), delim) {
			fm = rest[:pos]
			if nl < 0 {
				body = nil
			} else {
				body = scanner[nl+1:]
			}
			return fm, body, nil
		}
		if nl < 0 {
			return nil, nil, fmt.Errorf("frontmatter block not terminated")
		}
		pos += nl + 1
		scanner = scanner[nl+1:]
	}
}

// BodyAfterFrontmatter strips the YAML frontmatter and returns only the body.
func BodyAfterFrontmatter(content []byte) string {
	_, body, err := SplitFrontmatter(content)
	if err != nil {
		return string(content)
	}
	return strings.TrimLeft(string(body), "\n\r")
}

// Headings is the TOC-only accessor, used by /api/kiwi/toc.
func Headings(content []byte) []Heading {
	p, err := Parse(content)
	if err != nil {
		return nil
	}
	return p.Headings
}

// Slugify turns a heading into the same base anchor format used by the UI's
// rehype-slug/github-slugger pipeline: lowercase, keep Unicode letters/numbers
// plus hyphen/underscore, drop punctuation, and turn spaces into hyphens.
func Slugify(s string) string {
	s = strings.ToLower(s)
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		switch {
		case unicode.IsLetter(r), unicode.IsNumber(r), r == '-' || r == '_':
			b.WriteRune(r)
		case r == ' ':
			b.WriteByte('-')
		}
	}
	return b.String()
}

// DebugString is a compact human-readable dump used in tests / CLI output.
func (p *Parsed) DebugString() string {
	var b strings.Builder
	if len(p.Frontmatter) > 0 {
		b.WriteString("frontmatter:\n")
		for k, v := range p.Frontmatter {
			fmt.Fprintf(&b, "  %s: %v\n", k, v)
		}
	}
	for _, h := range p.Headings {
		fmt.Fprintf(&b, "%s%s (#%s)\n", strings.Repeat("  ", h.Level-1), h.Text, h.Slug)
	}
	return b.String()
}

func extractText(buf *bytes.Buffer, n ast.Node, source []byte) {
	switch v := n.(type) {
	case *ast.Text:
		buf.WriteString(v.Value.Str(source))
	case *ast.CodeSpan:
		// v1 kept code span content as child Text nodes; v2 holds it here.
		buf.WriteString(v.Value.Value(source))
	default:
		for c := n.FirstChild(); c != nil; c = c.NextSibling() {
			extractText(buf, c, source)
		}
	}
}

// Task represents a task item extracted from markdown content.
type Task struct {
	Text      string         `json:"text"`
	Completed bool           `json:"completed"`
	Line      int            `json:"line"`
	Tags      []string       `json:"tags,omitempty"`
	Due       string         `json:"due,omitempty"`
	Meta      map[string]any `json:"meta,omitempty"`
}

var inlineMetaRe = regexp.MustCompile(`\[(\w+)::\s*([^\]]+)\]`)
var inlineTagRe = regexp.MustCompile(`#([a-zA-Z0-9_/.-]+)`)

// Tasks extracts task items from markdown content using goldmark's TaskList extension.
func Tasks(content []byte) []Task {
	doc, _ := parse(content, extension.TaskListItemParser)

	var tasks []Task

	ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		li, ok := n.(*ast.ListItem)
		if !ok || !extension.IsTask(li) {
			return ast.WalkContinue, nil
		}

		var textBuf bytes.Buffer
		ast.Walk(li, func(child ast.Node, childEntering bool) (ast.WalkStatus, error) {
			if !childEntering {
				return ast.WalkContinue, nil
			}
			switch t := child.(type) {
			case *ast.Text:
				textBuf.WriteString(t.Value.Str(content))
			case *ast.CodeSpan:
				textBuf.WriteString(t.Value.Value(content))
			}
			return ast.WalkContinue, nil
		})

		status, _ := extension.TaskStatusOf(li)

		taskText := strings.TrimSpace(textBuf.String())

		task := Task{
			Text:      taskText,
			Completed: status == extension.TaskStatusCompleted,
			Line:      lineNumber(content, li),
		}

		if matches := inlineTagRe.FindAllStringSubmatch(taskText, -1); len(matches) > 0 {
			for _, m := range matches {
				task.Tags = append(task.Tags, m[1])
			}
		}

		if matches := inlineMetaRe.FindAllStringSubmatch(taskText, -1); len(matches) > 0 {
			task.Meta = make(map[string]any)
			for _, m := range matches {
				key, val := m[1], strings.TrimSpace(m[2])
				task.Meta[key] = val
				if key == "due" {
					task.Due = val
				}
			}
		}

		tasks = append(tasks, task)
		return ast.WalkSkipChildren, nil
	})

	return tasks
}

func lineNumber(source []byte, n ast.Node) int {
	if lines := BlockLines(n); len(lines) > 0 {
		seg := lines[0]
		line := 1
		for i := 0; i < seg.Start && i < len(source); i++ {
			if source[i] == '\n' {
				line++
			}
		}
		return line
	}
	return 0
}
