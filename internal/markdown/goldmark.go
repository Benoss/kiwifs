package markdown

import (
	"bytes"

	"github.com/yuin/goldmark/v2/ast"
	"github.com/yuin/goldmark/v2/parser"
	"github.com/yuin/goldmark/v2/text"
	"github.com/yuin/goldmark/v2/util"
	yamlv2 "go.yaml.in/yaml/v2"
)

// The YAML frontmatter block is recognised exactly as goldmark-meta does it
// (a line of dashes on the first line, closed by the next non-blank line of
// dashes), but decoded with yaml.v2 rather than goldmark-meta/v2's yaml.v4:
// v4 turns an unquoted 2026-01-02 into a time.Time and nested mappings into
// map[string]any, and every consumer of Frontmatter — the index, the API,
// the schema validator, lint's date rules — was written against yaml.v2's
// strings and map[any]any.

// kindFrontmatterBlock is the AST kind of the frontmatter block.
var kindFrontmatterBlock = ast.NewNodeKind("KiwiFrontmatter")

type frontmatterBlock struct {
	ast.BaseBlock
	Value text.Lines
}

func (n *frontmatterBlock) Kind() ast.NodeKind { return kindFrontmatterBlock }

func (n *frontmatterBlock) Dump(_ []byte) *ast.NodeDump {
	return ast.NewNodeDump(n, map[string]any{"Value": n.Value})
}

func newFrontmatterBlock() *frontmatterBlock {
	n := &frontmatterBlock{}
	n.Init(n)
	return n
}

var frontmatterKey = parser.NewContextKey()

type frontmatterParser struct{}

func isDashLine(line []byte) bool {
	line = util.TrimRightSpace(util.TrimLeftSpace(line))
	for _, c := range line {
		if c != '-' {
			return false
		}
	}
	return true
}

func (frontmatterParser) Trigger() []byte { return []byte{'-'} }

func (frontmatterParser) Open(_ ast.Node, reader text.Reader, _ parser.Context) (ast.Node, parser.State) {
	if linenum, _ := reader.Position(); linenum != 0 {
		return nil, parser.NoChildren
	}
	line, _ := reader.PeekLine()
	if !isDashLine(line) {
		return nil, parser.NoChildren
	}
	reader.AdvanceToEOL()
	return newFrontmatterBlock(), parser.NoChildren
}

func (frontmatterParser) Continue(node ast.Node, reader text.Reader, _ parser.Context) parser.State {
	line, segment := reader.PeekLine()
	if isDashLine(line) && !util.IsBlank(line) {
		reader.AdvanceToEOL()
		return parser.Close
	}
	node.(*frontmatterBlock).Value.AppendSegment(segment)
	reader.AdvanceToEOL()
	return parser.Continue | parser.NoChildren
}

// Close decodes the block. Like goldmark-meta, a block that is valid YAML
// leaves the AST, so no walker ever mistakes it for content.
func (frontmatterParser) Close(node ast.Node, reader text.Reader, pc parser.Context) {
	var buf bytes.Buffer
	for _, seg := range node.(*frontmatterBlock).Value.Segments() {
		buf.Write(seg.Bytes(reader.Source()))
	}
	fm := map[string]any{}
	if err := yamlv2.Unmarshal(buf.Bytes(), &fm); err != nil {
		return
	}
	pc.Set(frontmatterKey, fm)
	if parent := node.Parent(); parent != nil {
		parent.RemoveChild(node)
	}
}

func (frontmatterParser) CanInterruptParagraph() bool { return false }
func (frontmatterParser) CanAcceptIndentedLine() bool { return false }

type frontmatterExtension struct{}

func (frontmatterExtension) ParserOptions(_ *parser.Config) []parser.Option {
	return []parser.Option{parser.WithBlockParsers(util.Prioritized[parser.BlockParser](frontmatterParser{}, 0))}
}

// frontmatterOf returns the frontmatter a parse with the frontmatter
// extension found, or nil.
func frontmatterOf(pc parser.Context) map[string]any {
	fm, _ := pc.Get(frontmatterKey).(map[string]any)
	return fm
}

// parse parses source with the frontmatter extension and any others,
// returning the document and the parse context.
func parse(source []byte, exts ...parser.Extension) (ast.Node, parser.Context) {
	p := parser.New(parser.WithExtensions(append([]parser.Extension{frontmatterExtension{}}, exts...)...))
	pc := parser.NewContext()
	return p.Parse(source, parser.WithContext(pc)), pc
}

// BlockLines returns the source lines a block node covers, the way goldmark
// v1's Lines() did: the inline source of headings and paragraphs, and the
// body (without fences) of code and HTML blocks. Containers (lists, quotes)
// and inline nodes have none.
func BlockLines(n ast.Node) []text.Segment {
	switch b := n.(type) {
	case *ast.CodeBlock:
		return b.Value.Segments()
	case *ast.HTMLBlock:
		return b.Value.Segments()
	case ast.BlockNode:
		return b.Source()
	}
	return nil
}

// AppendInlineText appends the text of n's inline content the way goldmark
// v1's Node.Text did: text as written in the source, a newline per soft
// line break, code spans' content; raw HTML contributes nothing.
func AppendInlineText(buf []byte, n ast.Node, source []byte) []byte {
	for c := n.FirstChild(); c != nil; c = c.NextSibling() {
		switch t := c.(type) {
		case *ast.Text:
			buf = append(buf, t.Value.Str(source)...)
			if t.SoftLineBreak() {
				buf = append(buf, '\n')
			}
		case *ast.CodeSpan:
			buf = append(buf, t.Value.Value(source)...)
		case *ast.AutoLink:
			buf = append(buf, t.Label.Str(source)...)
		case *ast.RawHTML:
		default:
			buf = AppendInlineText(buf, c, source)
		}
	}
	return buf
}
