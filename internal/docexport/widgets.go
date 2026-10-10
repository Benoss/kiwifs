package docexport

import (
	"fmt"
	"strings"

	"github.com/kiwifs/kiwifs/internal/markdown"
)

// RewriteWidgetFences turns every widget fence into something a static reader
// can use: the caption, the step notes, and the YAML kept as a code block for
// anyone who wants the data.
//
// Without this, pandoc, typst, marp and mkdocs all treat a widget fence as an
// opaque code block, so a PDF of a well-illustrated page is a wall of
// `activeIndices`. Rendering a real picture needs a headless pass; this is the
// honest text version until then.
func RewriteWidgetFences(content []byte) []byte {
	return []byte(markdown.StripWidgetFences(string(content), renderStaticFence))
}

func renderStaticFence(lang, summary, source string) string {
	var buf strings.Builder

	lines := strings.Split(strings.TrimRight(summary, "\n"), "\n")
	// The first line of a summary is the caption or title when there is one.
	// Blockquote the prose: it is a figure's text, not body copy.
	for _, line := range lines {
		if strings.TrimSpace(line) == "" {
			buf.WriteString(">\n")
			continue
		}
		buf.WriteString("> ")
		buf.WriteString(line)
		buf.WriteString("\n")
	}
	if buf.Len() > 0 {
		buf.WriteString(">\n")
	}
	buf.WriteString(fmt.Sprintf("> *Interactive %s widget — open this page in KiwiFS to step through it.*\n", lang))
	buf.WriteString("\n```yaml\n")
	buf.WriteString(strings.TrimRight(source, "\n"))
	buf.WriteString("\n```\n")
	return buf.String()
}
