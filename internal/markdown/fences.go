package markdown

import (
	"embed"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"

	"gopkg.in/yaml.v3"
)

// fences.json is generated from the UI's fence specs by
// `ui/scripts/emit-fence-schemas.mjs`. It is the one description of every
// widget fence: the linter below, the kiwi_widget_reference MCP tool, the
// REST mirror, and docs/WIDGETS.md all read it, so a key documented once is
// documented everywhere. CI fails if it drifts from the specs.
//
//go:embed fenceschemas/fences.json
var fenceSchemaFS embed.FS

// MaxFenceBodyBytes caps a single widget fence. Same reasoning as
// MaxDataBlockBytes: yaml.v3 guards against aliasing on its own, but a size
// cap keeps a pathological page from dominating a lint or index pass.
const MaxFenceBodyBytes = 256 * 1024

// FenceAttribute describes one key of a widget fence.
type FenceAttribute struct {
	Type        string `json:"type"`
	Required    bool   `json:"required,omitempty"`
	Items       string `json:"items,omitempty"`
	Matches     []any  `json:"matches,omitempty"`
	Pattern     string `json:"pattern,omitempty"`
	Description string `json:"description,omitempty"`
	// Steppable is a pointer so "absent" reads as true, matching the emitter,
	// which only writes the field when a key is pinned.
	Steppable *bool `json:"steppable,omitempty"`
}

// CanStep reports whether a step patch may set this key.
func (a FenceAttribute) CanStep() bool {
	return a.Steppable == nil || *a.Steppable
}

// FenceSpec is one widget fence: its language tag, its keys, and an example.
type FenceSpec struct {
	Lang        string   `json:"lang"`
	Aliases     []string `json:"aliases"`
	Description string   `json:"description"`
	Required    []string `json:"required"`
	// RequireOneOf names keys of which at least one has to be present. A
	// table needs its rows from somewhere — `rows:` or `fromData:` — and no
	// single key can be marked required to say that.
	RequireOneOf []string                  `json:"requireOneOf,omitempty"`
	Example      string                    `json:"example"`
	Attributes   map[string]FenceAttribute `json:"attributes"`
}

// FenceCatalogue is the whole generated file.
type FenceCatalogue struct {
	Version          int         `json:"version"`
	ReservedTopLevel []string    `json:"reservedTopLevel"`
	ReservedStep     []string    `json:"reservedStep"`
	Fences           []FenceSpec `json:"fences"`
}

var (
	catalogueOnce sync.Once
	catalogue     FenceCatalogue
	catalogueErr  error
	byLang        map[string]*FenceSpec
	reservedTop   map[string]bool
	reservedStep  map[string]bool
)

func loadCatalogue() {
	catalogueOnce.Do(func() {
		data, err := fenceSchemaFS.ReadFile("fenceschemas/fences.json")
		if err != nil {
			catalogueErr = fmt.Errorf("read fence schemas: %w", err)
			return
		}
		if err := json.Unmarshal(data, &catalogue); err != nil {
			catalogueErr = fmt.Errorf("parse fence schemas: %w", err)
			return
		}
		byLang = make(map[string]*FenceSpec, len(catalogue.Fences)*3)
		for i := range catalogue.Fences {
			spec := &catalogue.Fences[i]
			byLang[spec.Lang] = spec
			for _, alias := range spec.Aliases {
				byLang[alias] = spec
			}
		}
		reservedTop = make(map[string]bool, len(catalogue.ReservedTopLevel))
		for _, k := range catalogue.ReservedTopLevel {
			reservedTop[k] = true
		}
		reservedStep = make(map[string]bool, len(catalogue.ReservedStep))
		for _, k := range catalogue.ReservedStep {
			reservedStep[k] = true
		}
	})
}

// WidgetFences returns every fence in the catalogue, ordered by language tag.
func WidgetFences() ([]FenceSpec, error) {
	loadCatalogue()
	if catalogueErr != nil {
		return nil, catalogueErr
	}
	return catalogue.Fences, nil
}

// WidgetFence looks up one fence by its tag or any alias.
func WidgetFence(lang string) (*FenceSpec, bool) {
	loadCatalogue()
	if catalogueErr != nil {
		return nil, false
	}
	spec, ok := byLang[strings.TrimSpace(lang)]
	return spec, ok
}

// WidgetFenceReserved returns the reserved key sets, for callers rendering a
// reference page.
func WidgetFenceReserved() (topLevel, step []string) {
	loadCatalogue()
	if catalogueErr != nil {
		return nil, nil
	}
	return catalogue.ReservedTopLevel, catalogue.ReservedStep
}

// ---------------------------------------------------------------------------
// Sniffing
// ---------------------------------------------------------------------------

// claimsBody mirrors the UI's rule: an explicit `kiwi-…` or `widget:…`
// spelling always belongs to the fence, while a bare tag only claims a body
// that parses to a mapping carrying one of the spec's required keys. That is
// what lets an imported vault keep using ```tree for a directory listing.
func claimsBody(spec *FenceSpec, lang string, body map[string]any) bool {
	if lang != spec.Lang {
		return true
	}
	if body == nil {
		return false
	}
	if len(spec.Required) == 0 {
		return true
	}
	for _, key := range spec.Required {
		if _, ok := body[key]; ok {
			return true
		}
	}
	return false
}

// looksIntended reports whether a body that failed to parse was nonetheless
// written as this widget's YAML: one of its required keys appears at the start
// of a line, followed by a colon.
func looksIntended(spec *FenceSpec, lines []string) bool {
	for _, key := range spec.Required {
		needle := key + ":"
		for _, line := range lines {
			if strings.HasPrefix(strings.TrimLeft(line, " \t-"), needle) {
				return true
			}
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// Rule 11: fence-widget-invalid
// ---------------------------------------------------------------------------

type widgetFenceBlock struct {
	lang  string
	spec  *FenceSpec
	line  int // 1-based line of the opening fence
	lines []string
}

// collectWidgetFences walks the body for fences whose tag names a widget.
func collectWidgetFences(body []byte, lineOffset int) []widgetFenceBlock {
	var out []widgetFenceBlock
	lines := strings.Split(string(body), "\n")
	inFence := false
	var marker string
	var current widgetFenceBlock

	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if !inFence {
			if !isOpeningFence(trimmed) {
				continue
			}
			inFence = true
			marker = extractFenceMarker(trimmed)
			_, lang := FenceInfo(trimmed)
			spec, ok := WidgetFence(lang)
			current = widgetFenceBlock{lang: lang, line: i + 1 + lineOffset}
			if ok {
				current.spec = spec
			}
			continue
		}
		if isClosingFence(trimmed, marker) {
			if current.spec != nil {
				out = append(out, current)
			}
			inFence = false
			marker = ""
			current = widgetFenceBlock{}
			continue
		}
		if current.spec != nil {
			current.lines = append(current.lines, line)
		}
	}
	return out
}

func lintWidgetFences(body []byte, lineOffset int) []LintIssue {
	loadCatalogue()
	if catalogueErr != nil {
		return nil
	}
	var issues []LintIssue
	for _, block := range collectWidgetFences(body, lineOffset) {
		issues = append(issues, lintWidgetFence(block)...)
	}
	return issues
}

func lintWidgetFence(block widgetFenceBlock) []LintIssue {
	source := strings.Join(block.lines, "\n")
	if len(source) > MaxFenceBodyBytes {
		return []LintIssue{{
			Rule:     "fence-widget-invalid",
			Line:     block.line,
			Message:  fmt.Sprintf("%s fence body exceeds %d bytes", block.lang, MaxFenceBodyBytes),
			Severity: "warning",
		}}
	}

	var raw any
	if err := yaml.Unmarshal([]byte(source), &raw); err != nil {
		// An explicit kiwi-/widget: spelling asked to be checked, so broken
		// YAML is an error. A bare tag only gets a warning, and only when the
		// body was plainly meant as this widget's YAML — a ```table holding a
		// pipe table is a code block, and saying otherwise is noise.
		severity := "error"
		if block.lang == block.spec.Lang {
			if !looksIntended(block.spec, block.lines) {
				return nil
			}
			severity = "warning"
		}
		return []LintIssue{{
			Rule:     "fence-widget-invalid",
			Line:     block.line,
			Message:  fmt.Sprintf("%s fence: YAML parse error: %s", block.lang, firstLine(err.Error())),
			Severity: severity,
		}}
	}

	body, _ := raw.(map[string]any)
	if !claimsBody(block.spec, block.lang, body) {
		// Renders as a plain code block in the UI; nothing to check.
		return nil
	}
	if body == nil {
		return []LintIssue{{
			Rule:     "fence-widget-invalid",
			Line:     block.line,
			Message:  fmt.Sprintf("%s fence: expected a YAML mapping of widget properties", block.lang),
			Severity: "error",
		}}
	}

	spec := block.spec
	var issues []LintIssue
	add := func(key, message, severity string) {
		issues = append(issues, LintIssue{
			Rule:     "fence-widget-invalid",
			Line:     block.line + keyLineOffset(block.lines, key),
			Message:  fmt.Sprintf("%s fence: %s", block.lang, message),
			Severity: severity,
		})
	}

	known := make([]string, 0, len(spec.Attributes))
	for key := range spec.Attributes {
		known = append(known, key)
	}
	sort.Strings(known)

	// Top-level keys.
	props := map[string]any{}
	for key, value := range body {
		if reservedTop[key] {
			continue
		}
		attr, ok := spec.Attributes[key]
		if !ok {
			add(key, unknownKeyMessage(key, known), "warning")
			continue
		}
		props[key] = value
		if msg := checkType(key, attr, value); msg != "" {
			add(key, msg, "error")
		}
	}
	// `props:` carries anything whose name collides with a reserved key.
	if escaped, ok := body["props"].(map[string]any); ok {
		for key, value := range escaped {
			if attr, ok := spec.Attributes[key]; ok {
				props[key] = value
				if msg := checkType(key, attr, value); msg != "" {
					add(key, msg, "error")
				}
			}
		}
	}

	// Steps.
	steps, _ := body["steps"].([]any)
	if steps == nil {
		if frames, ok := body["frames"].([]any); ok && !isReclaimedFrames(spec) {
			steps = frames
		}
	}
	for i, rawStep := range steps {
		if _, isString := rawStep.(string); isString {
			continue // a bare note over unchanged props
		}
		patch, ok := rawStep.(map[string]any)
		if !ok {
			add("steps", fmt.Sprintf("steps[%d] must be a mapping or a string", i), "error")
			continue
		}
		for key, value := range patch {
			if reservedStep[key] {
				continue
			}
			attr, ok := spec.Attributes[key]
			if !ok {
				add(key, fmt.Sprintf("steps[%d]: %s", i, unknownKeyMessage(key, known)), "warning")
				continue
			}
			if !attr.CanStep() {
				add(key, fmt.Sprintf("steps[%d]: %q cannot change between steps", i, key), "error")
				continue
			}
			props[key] = value
			if msg := checkType(key, attr, value); msg != "" {
				add(key, fmt.Sprintf("steps[%d]: %s", i, msg), "error")
			}
		}
	}

	// Required keys hold on whatever the first frame shows, not on the base:
	// a stepped fence may legitimately introduce `value:` only in step one.
	for _, key := range known {
		if !spec.Attributes[key].Required {
			continue
		}
		if _, ok := props[key]; !ok {
			add(key, fmt.Sprintf("missing required key %q", key), "error")
		}
	}
	if len(spec.RequireOneOf) > 0 {
		satisfied := false
		for _, key := range spec.RequireOneOf {
			if _, ok := props[key]; ok {
				satisfied = true
				break
			}
		}
		if !satisfied {
			quoted := make([]string, len(spec.RequireOneOf))
			for i, key := range spec.RequireOneOf {
				quoted[i] = fmt.Sprintf("%q", key)
			}
			add(spec.RequireOneOf[0], fmt.Sprintf("needs one of %s", strings.Join(quoted, ", ")), "error")
		}
	}

	sort.SliceStable(issues, func(i, j int) bool { return issues[i].Line < issues[j].Line })
	return issues
}

// isReclaimedFrames reports whether this fence uses `frames` as a prop of its
// own (SequenceView's alt/loop boxes) rather than as one prop set per step.
func isReclaimedFrames(spec *FenceSpec) bool {
	_, ok := spec.Attributes["frames"]
	return ok
}

func checkType(key string, attr FenceAttribute, value any) string {
	if value == nil {
		return ""
	}
	want := strings.Split(attr.Type, "|")
	got := yamlTypeName(value)
	if !contains(want, "any") && !contains(want, got) {
		return fmt.Sprintf("%q must be %s, got %s", key, strings.Join(want, " or "), got)
	}
	if attr.Items != "" {
		if list, ok := value.([]any); ok {
			itemWant := strings.Split(attr.Items, "|")
			for i, item := range list {
				if item == nil || contains(itemWant, "any") {
					continue
				}
				if itemGot := yamlTypeName(item); !contains(itemWant, itemGot) {
					return fmt.Sprintf("%q[%d] must be %s, got %s", key, i, attr.Items, itemGot)
				}
			}
		}
	}
	if len(attr.Matches) > 0 {
		for _, allowed := range attr.Matches {
			if fmt.Sprint(allowed) == fmt.Sprint(value) {
				return ""
			}
		}
		names := make([]string, len(attr.Matches))
		for i, a := range attr.Matches {
			names[i] = fmt.Sprintf("%q", fmt.Sprint(a))
		}
		return fmt.Sprintf("%q must be one of %s", key, strings.Join(names, ", "))
	}
	return ""
}

func yamlTypeName(value any) string {
	switch value.(type) {
	case string:
		return "string"
	case bool:
		return "boolean"
	case int, int64, uint64, float64:
		return "number"
	case []any:
		return "array"
	// `activeKeys: {0: [0]}` is a perfectly ordinary mapping keyed by node
	// index. yaml.v3 hands those back as map[any]any, where js-yaml gives an
	// object with string keys — so without this the Go linter rejects a fence
	// the UI renders happily.
	case map[string]any, map[any]any:
		return "object"
	default:
		return "any"
	}
}

func contains(list []string, want string) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
}

// unknownKeyMessage names the nearest known key, which is what turns a typo
// from a silent no-op into a one-line fix.
func unknownKeyMessage(key string, known []string) string {
	best, bestScore := "", 1<<30
	for _, candidate := range known {
		if d := editDistance(strings.ToLower(key), strings.ToLower(candidate)); d < bestScore {
			best, bestScore = candidate, d
		}
	}
	budget := len(key) / 4
	if budget < 1 {
		budget = 1
	}
	if best != "" && bestScore <= budget {
		return fmt.Sprintf("unknown key %q — did you mean %q?", key, best)
	}
	return fmt.Sprintf("unknown key %q", key)
}

func editDistance(a, b string) int {
	ar, br := []rune(a), []rune(b)
	if len(ar) == 0 {
		return len(br)
	}
	if len(br) == 0 {
		return len(ar)
	}
	prev := make([]int, len(br)+1)
	for j := range prev {
		prev[j] = j
	}
	row := make([]int, len(br)+1)
	for i := 1; i <= len(ar); i++ {
		row[0] = i
		for j := 1; j <= len(br); j++ {
			cost := 1
			if ar[i-1] == br[j-1] {
				cost = 0
			}
			row[j] = min3(prev[j]+1, row[j-1]+1, prev[j-1]+cost)
		}
		copy(prev, row)
	}
	return prev[len(br)]
}

func min3(a, b, c int) int {
	if b < a {
		a = b
	}
	if c < a {
		a = c
	}
	return a
}

// keyLineOffset finds `key:` within a fence body, so an issue can point at the
// line the author has to edit. 0 means "the opening fence line".
func keyLineOffset(lines []string, key string) int {
	needle := key + ":"
	for i, line := range lines {
		trimmed := strings.TrimLeft(line, " \t-")
		if strings.HasPrefix(trimmed, needle) {
			return i + 1
		}
	}
	return 0
}

func firstLine(s string) string {
	if idx := strings.IndexByte(s, '\n'); idx >= 0 {
		return s[:idx]
	}
	return s
}

// ---------------------------------------------------------------------------
// Degradation outside the UI
// ---------------------------------------------------------------------------

// WidgetFenceClaims reports whether this body really belongs to the widget
// its language tag names. A bare ```tree holding a directory listing does
// not, and must pass through every pass untouched.
func WidgetFenceClaims(lang, source string) bool {
	spec, ok := WidgetFence(lang)
	if !ok {
		return false
	}
	var raw any
	if err := yaml.Unmarshal([]byte(source), &raw); err != nil {
		return false
	}
	body, _ := raw.(map[string]any)
	return claimsBody(spec, lang, body)
}

// SummarizeWidgetFence reduces a fence body to the prose a reader would get
// without the UI: its caption, its title, and the step notes. Everything else
// is coordinates.
func SummarizeWidgetFence(lang, source string) string {
	spec, ok := WidgetFence(lang)
	if !ok {
		return ""
	}
	var raw any
	if err := yaml.Unmarshal([]byte(source), &raw); err != nil {
		return ""
	}
	body, _ := raw.(map[string]any)
	if !claimsBody(spec, lang, body) {
		return ""
	}

	var parts []string
	for _, key := range []string{"title", "caption"} {
		if s, ok := body[key].(string); ok && strings.TrimSpace(s) != "" {
			parts = append(parts, strings.TrimSpace(s))
		}
	}
	if steps, ok := body["steps"].([]any); ok {
		for _, rawStep := range steps {
			switch step := rawStep.(type) {
			case string:
				parts = append(parts, step)
			case map[string]any:
				if note, ok := step["note"].(string); ok && strings.TrimSpace(note) != "" {
					parts = append(parts, strings.TrimSpace(note))
				}
			}
		}
	}
	// The code listing is prose a reader can act on, unlike the coordinates.
	if code, ok := body["code"].(string); ok && strings.TrimSpace(code) != "" {
		parts = append(parts, strings.TrimSpace(code))
	}
	return strings.Join(parts, "\n")
}

// StripWidgetFences replaces every widget fence body with its summary, leaving
// the rest of the page untouched.
//
// Used before indexing, where a body of `activeIndices` and `cellColors` keys
// otherwise pollutes BM25 scoring for every page that draws a picture, and
// before export, where the YAML is noise on the page.
func StripWidgetFences(content string, render func(lang, summary, source string) string) string {
	lines := strings.Split(content, "\n")
	out := make([]string, 0, len(lines))
	inFence := false
	var marker, lang string
	var body []string
	var openLine string

	flush := func(closing string) {
		source := strings.Join(body, "\n")
		keepVerbatim := func() {
			out = append(out, openLine)
			out = append(out, body...)
			out = append(out, closing)
		}
		// A bare tag whose body is something else — a directory listing, a
		// pipe table — renders as a code block in the UI, so every other pass
		// has to leave it exactly as it is.
		if !WidgetFenceClaims(lang, source) {
			keepVerbatim()
			return
		}
		replacement := render(lang, SummarizeWidgetFence(lang, source), source)
		if replacement == "" {
			keepVerbatim()
			return
		}
		out = append(out, strings.Split(replacement, "\n")...)
	}

	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if !inFence {
			if isOpeningFence(trimmed) {
				_, l := FenceInfo(trimmed)
				if _, ok := WidgetFence(l); ok {
					inFence = true
					marker = extractFenceMarker(trimmed)
					lang = l
					body = nil
					openLine = line
					continue
				}
			}
			out = append(out, line)
			continue
		}
		if isClosingFence(trimmed, marker) {
			flush(line)
			inFence = false
			marker, lang, body = "", "", nil
			continue
		}
		body = append(body, line)
	}
	if inFence {
		// Unclosed; lintFences reports it. Keep what we have verbatim.
		out = append(out, openLine)
		out = append(out, body...)
	}
	return strings.Join(out, "\n")
}

// IndexableContent is what the search index should store for a page: widget
// fences reduced to their captions and step notes.
func IndexableContent(content string) string {
	return StripWidgetFences(content, func(_, summary, _ string) string {
		return summary
	})
}
