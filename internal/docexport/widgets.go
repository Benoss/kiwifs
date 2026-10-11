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

func renderStaticFence(block markdown.WidgetFenceBlock) string {
	var buf strings.Builder

	// The code listing is already in the YAML below; repeating it as
	// blockquoted prose would print it twice, and unformatted.
	if prose := block.Prose(false); prose != "" {
		for _, line := range strings.Split(prose, "\n") {
			if strings.TrimSpace(line) == "" {
				buf.WriteString(">\n")
				continue
			}
			buf.WriteString("> ")
			buf.WriteString(line)
			buf.WriteString("\n")
		}
		buf.WriteString(">\n")
	}
	lang := block.Lang
	if block.Spec != nil {
		lang = block.Spec.Lang
	}
	buf.WriteString(fmt.Sprintf("> *Interactive %s widget — open this page in KiwiFS to step through it.*\n", lang))

	source := strings.TrimRight(block.Source, "\n")
	marker := strings.Repeat("`", max(3, longestBacktickRun(source)+1))
	buf.WriteString("\n" + marker + "yaml\n")
	buf.WriteString(source)
	buf.WriteString("\n" + marker + "\n")
	return buf.String()
}

// longestBacktickRun is the longest run of consecutive backticks in s. A
// `code:` listing holding a ``` fence of its own would otherwise close the
// YAML block early.
func longestBacktickRun(s string) int {
	longest, run := 0, 0
	for i := 0; i < len(s); i++ {
		if s[i] == '`' {
			run++
			longest = max(longest, run)
			continue
		}
		run = 0
	}
	return longest
}
