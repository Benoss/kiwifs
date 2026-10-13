package refactor

import (
	"bytes"
	"unicode/utf8"

	udiff "github.com/aymanbagabas/go-udiff"
)

// FileDiff is one written page as a unified diff from what is on disk.
type FileDiff struct {
	Path string `json:"path"`
	// From is set when the page also moves.
	From string `json:"from,omitempty"`
	// Diff is empty for a pure move (same bytes) and for binary files.
	Diff   string `json:"diff,omitempty"`
	Binary bool   `json:"binary,omitempty"`
}

// FileDiffs renders every write in the plan as a unified diff, in plan
// order. It is computed on demand: a large restructuring's diffs are
// bigger than the plan.
func (p *Plan) FileDiffs() []FileDiff {
	out := make([]FileDiff, 0, len(p.Ops.Writes))
	for _, w := range p.Ops.Writes {
		d := FileDiff{Path: w.Path}
		if w.Source != "" && w.Source != w.Path {
			d.From = w.Source
		}
		switch {
		case !isMarkdown(w.Path) && (bytes.IndexByte(w.Content, 0) >= 0 || !utf8.Valid(w.Content)):
			d.Binary = true
		case !bytes.Equal(w.Prior, w.Content):
			from := w.Source
			if from == "" {
				from = w.Path
			}
			d.Diff = udiff.Unified("a/"+from, "b/"+w.Path, string(w.Prior), string(w.Content))
		}
		out = append(out, d)
	}
	return out
}
