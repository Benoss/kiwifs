package markdown

import (
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/yuin/goldmark/v2/ast"
	"github.com/yuin/goldmark/v2/parser"
)

// Format normalizes markdown content, fixing cosmetic issues.
// Returns the cleaned content. Does not reject — only fixes.
//
// Transforms applied (in order):
//  1. Normalize line endings (\r\n → \n, strip trailing \r)
//  2. Ensure trailing newline
//  3. Close unclosed code fences
//  4. Normalize table alignment
//  5. Fix list marker consistency
//  6. Strip trailing whitespace (preserving intentional "  \n" breaks)
//  7. Collapse excessive blank lines (3+ → 2)
//  8. Preserve frontmatter verbatim
func Format(content []byte) []byte {
	if len(content) == 0 {
		return []byte("\n")
	}

	// Step 1: Normalize line endings — must be first so downstream
	// code can rely on \n-only splits.
	s := normalizeLineEndings(string(content))

	// Step 8 (early): Split frontmatter before processing body so we
	// can preserve it verbatim (only the body gets reformatted).
	fm, body := splitFMForFormat(s)

	// Step 3: Close unclosed code fences.
	body = closeUnclosedFences(body)

	// Step 4: Normalize table alignment.
	body = formatTables(body)

	// Step 5: Fix list marker consistency.
	body = fixListMarkers(body)

	// Step 6: Strip trailing whitespace (preserving "  \n" linebreaks).
	body = stripTrailingWhitespace(body)

	// Step 7: Collapse 3+ blank lines → 2.
	body = collapseBlankLines(body)

	// Reassemble.
	result := rejoinFM(fm, body)

	// Step 2: Ensure trailing newline.
	if len(result) == 0 || result[len(result)-1] != '\n' {
		result += "\n"
	}
	return []byte(result)
}

// ---------------------------------------------------------------------------
// Step 1: Normalize line endings
// ---------------------------------------------------------------------------

func normalizeLineEndings(s string) string {
	// Replace \r\n first, then lone \r.
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.ReplaceAll(s, "\r", "\n")
	return s
}

// ---------------------------------------------------------------------------
// Step 8 (early): Frontmatter split/rejoin
// ---------------------------------------------------------------------------

// splitFMForFormat splits the frontmatter block from the body for formatting.
// Returns raw frontmatter string (including delimiters+newlines) and body.
func splitFMForFormat(s string) (fm, body string) {
	fmBytes, bodyBytes, err := SplitFrontmatter([]byte(s))
	if err != nil || fmBytes == nil {
		return "", s
	}
	// Reconstruct the original frontmatter block exactly.
	fm = "---\n" + string(fmBytes) + "---\n"
	body = string(bodyBytes)
	return fm, body
}

func rejoinFM(fm, body string) string {
	if fm == "" {
		return body
	}
	return fm + body
}

// ---------------------------------------------------------------------------
// Step 3: Close unclosed code fences
// ---------------------------------------------------------------------------

// closeUnclosedFences detects fenced code blocks (``` or ~~~) that reach EOF
// without a matching closing fence and appends one.
func closeUnclosedFences(body string) string {
	lines := strings.Split(body, "\n")
	var result []string
	inFence := false
	var fenceMarker string // "```" or "~~~"

	for _, line := range lines {
		trimmed := strings.TrimSpace(line)

		if !inFence {
			if isOpeningFence(trimmed) {
				inFence = true
				fenceMarker = extractFenceMarker(trimmed)
			}
		} else {
			// Check if this line closes the current fence.
			if isClosingFence(trimmed, fenceMarker) {
				inFence = false
				fenceMarker = ""
			}
		}
		result = append(result, line)
	}

	// If still inside a fence at EOF, close it.
	if inFence && fenceMarker != "" {
		// When the input ends with "\n", Split produces a trailing empty
		// string. Insert the closing fence before that trailing blank so
		// we don't introduce an extra blank line.
		if len(result) > 0 && result[len(result)-1] == "" {
			result = append(result[:len(result)-1], fenceMarker, "")
		} else {
			result = append(result, fenceMarker)
		}
	}

	return strings.Join(result, "\n")
}

// fenceRe matches opening code fences: ``` or ~~~ optionally followed by
// a language identifier and other info.
var fenceRe = regexp.MustCompile(`^(\x60{3,}|~{3,})(.*)$`)

func isOpeningFence(trimmed string) bool {
	m := fenceRe.FindStringSubmatch(trimmed)
	if m == nil {
		return false
	}
	// An opening fence can have a language tag after the marker.
	// A closing fence must be ONLY the marker (possibly with trailing whitespace).
	// But for opening detection, we just need at least 3 backticks/tildes.
	return true
}

func extractFenceMarker(trimmed string) string {
	m := fenceRe.FindStringSubmatch(trimmed)
	if m == nil {
		return "```"
	}
	// Return just the fence characters (e.g. "```" or "~~~~").
	marker := m[1]
	// Use the same character but standard 3-char length for closing.
	ch := marker[0]
	return strings.Repeat(string(ch), len(marker))
}

func isClosingFence(trimmed, marker string) bool {
	if marker == "" {
		return false
	}
	// A closing fence is the marker character repeated at least as many times
	// as the opening, with nothing after it (except whitespace).
	ch := marker[0]
	if len(trimmed) < len(marker) {
		return false
	}
	for i := 0; i < len(trimmed); i++ {
		if trimmed[i] != ch {
			// Must be only whitespace after the fence chars.
			return strings.TrimSpace(trimmed[i:]) == ""
		}
	}
	return true
}

// ---------------------------------------------------------------------------
// Step 4: Normalize table alignment
// ---------------------------------------------------------------------------

// tableLineRe matches a line that looks like a table row.
var tableLineRe = regexp.MustCompile(`^\s*\|.*\|\s*$`)

// separatorCellRe matches a separator cell like "---", ":---", "---:", ":---:".
var separatorCellRe = regexp.MustCompile(`^\s*:?-{1,}:?\s*$`)

func formatTables(body string) string {
	lines := strings.Split(body, "\n")
	var result []string
	i := 0

	for i < len(lines) {
		// Detect start of a table block: contiguous lines matching |...|.
		if tableLineRe.MatchString(lines[i]) {
			// Collect contiguous table lines.
			start := i
			for i < len(lines) && tableLineRe.MatchString(lines[i]) {
				i++
			}
			tableLines := lines[start:i]
			formatted := reformatTable(tableLines)
			result = append(result, formatted...)
		} else {
			result = append(result, lines[i])
			i++
		}
	}

	return strings.Join(result, "\n")
}

// reformatTable takes a block of table lines and normalizes them:
// - Ensures separator row exists after header
// - Pads/trims data rows to match header column count
// - Aligns columns
func reformatTable(lines []string) []string {
	if len(lines) == 0 {
		return lines
	}

	// Parse all rows into cells.
	var rows [][]string
	separatorIdx := -1
	for i, line := range lines {
		cells := parseTableRow(line)
		rows = append(rows, cells)
		if i > 0 && separatorIdx < 0 && isSeparatorRow(cells) {
			separatorIdx = i
		}
	}

	if len(rows) == 0 {
		return lines
	}

	// Determine column count from header row.
	headerCols := len(rows[0])
	if headerCols == 0 {
		return lines
	}

	// If no separator row found, insert one after the header.
	if separatorIdx < 0 && len(rows) >= 1 {
		sep := make([]string, headerCols)
		for j := range sep {
			sep[j] = "---"
		}
		newRows := make([][]string, 0, len(rows)+1)
		newRows = append(newRows, rows[0])
		newRows = append(newRows, sep)
		newRows = append(newRows, rows[1:]...)
		rows = newRows
		separatorIdx = 1
	}

	// Normalize all rows to have the same column count as header.
	for i := range rows {
		for len(rows[i]) < headerCols {
			if i == separatorIdx {
				rows[i] = append(rows[i], "---")
			} else {
				rows[i] = append(rows[i], "")
			}
		}
		if len(rows[i]) > headerCols {
			rows[i] = rows[i][:headerCols]
		}
	}

	// Calculate max widths per column (minimum 3 for separator).
	colWidths := make([]int, headerCols)
	for _, row := range rows {
		for j, cell := range row {
			w := utf8.RuneCountInString(strings.TrimSpace(cell))
			if w < 3 {
				w = 3
			}
			if w > colWidths[j] {
				colWidths[j] = w
			}
		}
	}

	// Re-render rows with aligned columns.
	var output []string
	for i, row := range rows {
		var buf strings.Builder
		buf.WriteByte('|')
		for j, cell := range row {
			buf.WriteByte(' ')
			trimmed := strings.TrimSpace(cell)
			if i == separatorIdx {
				// Re-render separator preserving alignment markers.
				buf.WriteString(renderSepCell(trimmed, colWidths[j]))
			} else {
				buf.WriteString(padRight(trimmed, colWidths[j]))
			}
			buf.WriteString(" |")
		}
		output = append(output, buf.String())
	}

	return output
}

func parseTableRow(line string) []string {
	// Trim leading/trailing whitespace and pipes.
	line = strings.TrimSpace(line)
	if len(line) >= 2 && line[0] == '|' {
		line = line[1:]
	}
	if len(line) >= 1 && line[len(line)-1] == '|' {
		line = line[:len(line)-1]
	}
	parts := strings.Split(line, "|")
	cells := make([]string, len(parts))
	for i, p := range parts {
		cells[i] = strings.TrimSpace(p)
	}
	return cells
}

func isSeparatorRow(cells []string) bool {
	if len(cells) == 0 {
		return false
	}
	for _, c := range cells {
		if !separatorCellRe.MatchString(c) {
			return false
		}
	}
	return true
}

func renderSepCell(cell string, width int) string {
	leftColon := strings.HasPrefix(cell, ":")
	rightColon := strings.HasSuffix(cell, ":")

	dashes := width
	if leftColon {
		dashes--
	}
	if rightColon {
		dashes--
	}
	if dashes < 1 {
		dashes = 1
	}

	var buf strings.Builder
	if leftColon {
		buf.WriteByte(':')
	}
	buf.WriteString(strings.Repeat("-", dashes))
	if rightColon {
		buf.WriteByte(':')
	}
	return buf.String()
}

func padRight(s string, width int) string {
	n := utf8.RuneCountInString(s)
	if n >= width {
		return s
	}
	return s + strings.Repeat(" ", width-n)
}

// ---------------------------------------------------------------------------
// Step 5: Fix list marker consistency
// ---------------------------------------------------------------------------

// fixListMarkers normalizes list markers within each list. Uses goldmark AST
// to identify list boundaries, then performs targeted surgery on the source.
func fixListMarkers(body string) string {
	if body == "" {
		return body
	}

	src := []byte(body)
	doc := parser.New().Parse(src)

	// Collect list info from AST: for each list, gather the line numbers
	// and whether it's ordered.
	type listRange struct {
		startLine int
		endLine   int
		ordered   bool
	}
	var lists []listRange

	ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		list, ok := n.(*ast.List)
		if !ok {
			return ast.WalkContinue, nil
		}
		startLine := nodeStartLine(src, n)
		endLine := nodeEndLine(src, n)
		if startLine >= 0 && endLine >= startLine {
			lists = append(lists, listRange{
				startLine: startLine,
				endLine:   endLine,
				ordered:   list.IsOrdered(),
			})
		}
		return ast.WalkSkipChildren, nil
	})

	if len(lists) == 0 {
		return body
	}

	lines := strings.Split(body, "\n")

	// unorderedRe matches an unordered list marker at the start of a line.
	unorderedRe := regexp.MustCompile(`^(\s*)[*+](\s+)`)
	// orderedRe matches an ordered list marker.
	orderedRe := regexp.MustCompile(`^(\s*)\d+[.)]\s+`)

	for _, lr := range lists {
		if lr.ordered {
			// Normalize ordered list markers to "N. " format.
			num := 1
			for li := lr.startLine; li <= lr.endLine && li < len(lines); li++ {
				m := orderedRe.FindStringSubmatch(lines[li])
				if m != nil {
					indent := m[1]
					// Find where the actual text starts after the marker.
					rest := orderedRe.ReplaceAllString(lines[li], "")
					lines[li] = indent + strconv.Itoa(num) + ". " + rest
					num++
				}
			}
		} else {
			// Normalize unordered list to use "-".
			for li := lr.startLine; li <= lr.endLine && li < len(lines); li++ {
				lines[li] = unorderedRe.ReplaceAllString(lines[li], "${1}-${2}")
			}
		}
	}

	return strings.Join(lines, "\n")
}

// isBlockNode reports whether n is a block-level node (has Lines() method
// that won't panic). Inline nodes panic when Lines() is called.
func isBlockNode(n ast.Node) bool {
	_, ok := n.(ast.BlockNode)
	return ok || n.Kind() == ast.KindDocument
}

// nodeStartLine returns the 0-based line number of the first line of a node.
func nodeStartLine(src []byte, n ast.Node) int {
	// Walk to the first block leaf to find the earliest segment.
	var first ast.Node
	ast.Walk(n, func(child ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		if !isBlockNode(child) {
			return ast.WalkSkipChildren, nil
		}
		if len(BlockLines(child)) > 0 {
			first = child
			return ast.WalkStop, nil
		}
		return ast.WalkContinue, nil
	})
	if first == nil {
		return -1
	}
	seg := BlockLines(first)[0]
	return countNewlines(src, seg.Start)
}

// nodeEndLine returns the 0-based line number of the last line of a node.
func nodeEndLine(src []byte, n ast.Node) int {
	lastLine := -1
	ast.Walk(n, func(child ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		if !isBlockNode(child) {
			return ast.WalkSkipChildren, nil
		}
		if lines := BlockLines(child); len(lines) > 0 {
			seg := lines[len(lines)-1]
			l := countNewlines(src, seg.Start)
			if l > lastLine {
				lastLine = l
			}
		}
		return ast.WalkContinue, nil
	})
	return lastLine
}

func countNewlines(src []byte, offset int) int {
	n := 0
	for i := 0; i < offset && i < len(src); i++ {
		if src[i] == '\n' {
			n++
		}
	}
	return n
}

// ---------------------------------------------------------------------------
// Step 6: Strip trailing whitespace
// ---------------------------------------------------------------------------

// stripTrailingWhitespace removes trailing spaces/tabs from each line,
// except it preserves exactly two trailing spaces ("  \n") which is a
// hard line break in markdown. Lines with >2 trailing spaces are trimmed
// to exactly 2 (normalized hard break).
func stripTrailingWhitespace(body string) string {
	lines := strings.Split(body, "\n")
	for i, line := range lines {
		trimmed := strings.TrimRight(line, " \t")
		// Count trailing spaces (not tabs) in the original.
		trailing := len(line) - len(strings.TrimRight(line, " "))
		if trailing >= 2 {
			// Intentional hard break — normalize to exactly 2 trailing spaces.
			lines[i] = trimmed + "  "
		} else {
			lines[i] = trimmed
		}
	}
	return strings.Join(lines, "\n")
}

// ---------------------------------------------------------------------------
// Step 7: Collapse excessive blank lines
// ---------------------------------------------------------------------------

// collapseBlankLines reduces 3+ consecutive blank lines to 2.
func collapseBlankLines(body string) string {
	lines := strings.Split(body, "\n")
	var result []string
	blanks := 0

	for _, line := range lines {
		if strings.TrimSpace(line) == "" {
			blanks++
			if blanks <= 2 {
				result = append(result, line)
			}
		} else {
			blanks = 0
			result = append(result, line)
		}
	}

	return strings.Join(result, "\n")
}

// ---------------------------------------------------------------------------
// Goldmark table-related helpers (used in lint, not format; kept here for
// the package to share AST utilities)
// ---------------------------------------------------------------------------

// ParseMarkdownAST returns the goldmark AST document for content. Shared by
// both format and lint so each doesn't build its own parser.
func ParseMarkdownAST(content []byte) ast.Node {
	return parser.New().Parse(content)
}

// CountNewlines is exported for lint to reuse.
func CountNewlines(src []byte, offset int) int {
	return countNewlines(src, offset)
}

// fenceInfoRe matches the info string after opening fence markers.
var fenceInfoRe = regexp.MustCompile(`^(\x60{3,}|~{3,})\s*(\S*)`)

// FenceInfo returns (marker, language) for an opening code fence line,
// or ("","") if the line is not an opening fence.
func FenceInfo(line string) (marker, lang string) {
	trimmed := strings.TrimSpace(line)
	m := fenceInfoRe.FindStringSubmatch(trimmed)
	if m == nil {
		return "", ""
	}
	return m[1], m[2]
}

// IsFenceClose reports whether line closes the given fence marker.
func IsFenceClose(line, marker string) bool {
	return isClosingFence(strings.TrimSpace(line), marker)
}

// bytesFenceState is an internal helper used during AST inspection
// to extract code block info from raw bytes. Not exported.
func isInsideFence(lines []string, lineIdx int) bool {
	inFence := false
	var marker string
	for i := 0; i < lineIdx && i < len(lines); i++ {
		trimmed := strings.TrimSpace(lines[i])
		if !inFence {
			if isOpeningFence(trimmed) {
				inFence = true
				marker = extractFenceMarker(trimmed)
			}
		} else if isClosingFence(trimmed, marker) {
			inFence = false
			marker = ""
		}
	}
	return inFence
}
