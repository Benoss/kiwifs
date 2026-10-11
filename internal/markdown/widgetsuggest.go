package markdown

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// Suggesting a typed fence for a `widget:live` block.
//
// Most live blocks are not programs: they are a literal array and one view
// call, written as JSX because that was the only option. Those convert
// mechanically, and this says so — as an info-level lint rule and through
// `kiwifs widgets suggest`, never as an automatic rewrite. A heuristic that
// edits a page is a heuristic that eventually eats one.

// WidgetSuggestion is one convertible `widget:live` block.
type WidgetSuggestion struct {
	// Line of the opening fence, 1-based.
	Line int `json:"line"`
	// The typed fence tag this block would become.
	Fence string `json:"fence"`
	// What made it look convertible, in one phrase.
	Reason string `json:"reason"`
	// A starting point for the replacement, not a finished rewrite.
	Draft string `json:"draft"`
}

// viewCall matches `<ArrayView values={...} />` and `ArrayView({...})`.
var (
	viewElement = regexp.MustCompile(`<([A-Z][A-Za-z]*View|ArrayStack)\b`)
	renderCall  = regexp.MustCompile(`\brender\s*\(`)
	// Anything that makes a block a program rather than a picture.
	liveLogic = regexp.MustCompile(`\b(useState|useEffect|useMemo|useCallback|usePlayback|function|=>|for\s*\(|while\s*\(|\.map\s*\(|\.filter\s*\(|\.reduce\s*\()`)
)

// componentToFence maps a view component to the fence that replaces it.
var componentToFence = map[string]string{
	"ArrayView":      "array",
	"ArrayStack":     "array",
	"MatrixView":     "matrix",
	"TableView":      "table",
	"TreeView":       "tree",
	"GraphView":      "graph",
	"PlotView":       "plot",
	"BarView":        "bars",
	"BitsView":       "bits",
	"LinkedListView": "list",
	"StackView":      "stack",
	"QueueView":      "queue",
	"TimelineView":   "timeline",
	"SequenceView":   "sequence",
	"NumberLineView": "numberline",
	"PlaneView":      "plane",
	"MapView":        "map",
	"MemoryView":     "memory",
}

// SuggestWidgetFences finds `widget:live` blocks that are a static view call
// and nothing else, and names the fence each would become.
func SuggestWidgetFences(content []byte) []WidgetSuggestion {
	var out []WidgetSuggestion
	lines := strings.Split(string(content), "\n")
	inFence := false
	var marker string
	isLive := false
	start := 0
	var body []string

	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if !inFence {
			if !isOpeningFence(trimmed) {
				continue
			}
			inFence = true
			marker = extractFenceMarker(trimmed)
			_, lang := FenceInfo(trimmed)
			isLive = lang == "widget:live"
			start = i + 1
			body = nil
			continue
		}
		if isClosingFence(trimmed, marker) {
			if isLive {
				if s := suggestForLive(strings.Join(body, "\n"), start); s != nil {
					out = append(out, *s)
				}
			}
			inFence = false
			marker = ""
			isLive = false
			continue
		}
		if isLive {
			body = append(body, line)
		}
	}
	return out
}

func suggestForLive(source string, line int) *WidgetSuggestion {
	components := viewElement.FindAllStringSubmatch(source, -1)
	if len(components) == 0 {
		return nil
	}

	// Exactly one view, or the shape is not a single picture.
	if len(components) != 1 {
		return nil
	}
	component := components[0][1]
	fence, ok := componentToFence[component]
	if !ok {
		return nil
	}

	// Strip the `render(...)` wrapper before looking for logic, since every
	// live block has one and it is not what makes a block a program.
	probe := renderCall.ReplaceAllString(source, "(")
	if liveLogic.MatchString(probe) {
		return nil
	}

	attrs, ok := elementAttributes(source, viewElement.FindStringIndex(source)[1])
	if !ok {
		return nil
	}
	props := staticProps(attrs)
	if len(props) == 0 {
		return nil
	}

	return &WidgetSuggestion{
		Line:   line,
		Fence:  fence,
		Reason: fmt.Sprintf("a static %s and nothing else", component),
		Draft:  draftFence(fence, props),
	}
}

// elementAttributes returns the text between a JSX tag name and the `>` or
// `/>` that ends the tag, so only the element's own attributes are read as
// props — not a `const data = {…}` elsewhere in the block.
func elementAttributes(source string, from int) (string, bool) {
	depth := 0
	var quote byte
	for i := from; i < len(source); i++ {
		c := source[i]
		switch {
		case quote != 0:
			if c == quote {
				quote = 0
			}
		case c == '"' || c == '\'' || c == '`':
			quote = c
		case c == '{':
			depth++
		case c == '}':
			depth--
		case c == '>' && depth == 0:
			return strings.TrimSuffix(source[from:i], "/"), true
		}
	}
	return "", false
}

// staticProps pulls `name={literal}` pairs whose value is a JSON-ish literal.
// A prop holding an expression disqualifies the block, because converting it
// would silently drop behaviour.
var propPair = regexp.MustCompile(`(?:^|\s)([a-zA-Z][\w]*)\s*=\s*\{`)

func staticProps(source string) map[string]string {
	out := map[string]string{}
	for _, m := range propPair.FindAllStringSubmatchIndex(source, -1) {
		name := source[m[2]:m[3]]
		value, ok := balanced(source, m[1]-1)
		if !ok {
			return nil
		}
		trimmed := strings.TrimSpace(value)
		// A literal starts with a bracket, a brace, a digit, a quote, or is a
		// bare true/false. Anything else is code.
		if trimmed == "" {
			return nil
		}
		switch {
		case strings.HasPrefix(trimmed, "["), strings.HasPrefix(trimmed, "{"),
			strings.HasPrefix(trimmed, `"`), strings.HasPrefix(trimmed, "'"),
			trimmed == "true", trimmed == "false",
			trimmed[0] >= '0' && trimmed[0] <= '9', trimmed[0] == '-':
			out[name] = trimmed
		default:
			return nil
		}
	}
	return out
}

// balanced returns the text inside the `{...}` starting at `open`.
func balanced(source string, open int) (string, bool) {
	if open < 0 || open >= len(source) || source[open] != '{' {
		return "", false
	}
	depth := 0
	for i := open; i < len(source); i++ {
		switch source[i] {
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return source[open+1 : i], true
			}
		}
	}
	return "", false
}

// draftFence writes the props as YAML. JS object literals are close enough to
// flow-style YAML that the common cases come out valid; it is a draft, and the
// linter is what says whether it actually is.
func draftFence(fence string, props map[string]string) string {
	keys := make([]string, 0, len(props))
	for key := range props {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	var b strings.Builder
	fmt.Fprintf(&b, "```%s\n", fence)
	for _, key := range keys {
		value := collapse(props[key])
		// Quote a JS-style key, which YAML flow mappings accept unquoted only
		// for plain scalars.
		fmt.Fprintf(&b, "%s: %s\n", key, value)
	}
	b.WriteString("```")
	return b.String()
}

var whitespaceRun = regexp.MustCompile(`\s+`)

func collapse(value string) string {
	return strings.TrimSpace(whitespaceRun.ReplaceAllString(value, " "))
}

// lintWidgetLiveSuggestions reports convertible blocks at info severity, so a
// `kiwi_lint` call after a write mentions them without failing anything.
func lintWidgetLiveSuggestions(body []byte, lineOffset int) []LintIssue {
	var issues []LintIssue
	for _, s := range SuggestWidgetFences(body) {
		issues = append(issues, LintIssue{
			Rule:     "widget-live-convertible",
			Line:     s.Line + lineOffset,
			Message:  fmt.Sprintf("this widget:live block is %s — it could be a ```%s fence. Run `kiwifs widgets suggest` for a draft.", s.Reason, s.Fence),
			Severity: "info",
		})
	}
	return issues
}
