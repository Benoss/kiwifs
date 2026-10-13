//go:build !nod2

package d2render

import (
	"context"
	"fmt"
	"log/slog"
	"testing/fstest"

	"github.com/d2lang/d2/d2graph"
	"github.com/d2lang/d2/d2layouts/d2dagrelayout"
	"github.com/d2lang/d2/d2layouts/d2elklayout"
	"github.com/d2lang/d2/d2lib"
	"github.com/d2lang/d2/d2renderers/d2svg"
	"github.com/d2lang/d2/d2themes/d2themescatalog"
	d2log "github.com/d2lang/d2/lib/log"
	"github.com/d2lang/d2/lib/textmeasure"
)

// Available reports whether this binary can render D2. D2 adds about 16 MB
// to a stripped binary; build with -tags nod2 to leave it out.
const Available = true

func (r *Renderer) render(ctx context.Context, src string, opts Options) ([]byte, error) {
	ruler, err := r.ruler()
	if err != nil {
		return nil, err
	}
	defer r.rulers.Put(ruler)

	themeID := d2themescatalog.NeutralDefault.ID
	if opts.Dark {
		themeID = d2themescatalog.DarkMauve.ID
	}
	pad := int64(16)
	renderOpts := &d2svg.RenderOpts{Pad: &pad, ThemeID: &themeID}
	compileOpts := &d2lib.CompileOptions{
		Ruler:          ruler,
		LayoutResolver: layoutFor,
		// A nil FS makes D2 resolve `@import` with os.Open, which would let a
		// page read any file the server can.
		FS: fstest.MapFS{},
	}

	ctx = d2log.With(ctx, slog.New(slog.DiscardHandler))
	diagram, _, err := d2lib.Compile(ctx, src, compileOpts, renderOpts)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ErrTimeout
		}
		return nil, &SourceError{Msg: err.Error()}
	}
	svg, err := d2svg.Render(diagram, renderOpts)
	if err != nil {
		return nil, &SourceError{Msg: err.Error()}
	}
	return svg, nil
}

func layoutFor(engine string) (d2graph.LayoutGraph, error) {
	switch engine {
	case "", "dagre":
		return d2dagrelayout.DefaultLayout, nil
	case "elk":
		return d2elklayout.DefaultLayout, nil
	}
	return nil, &SourceError{Msg: fmt.Sprintf("layout engine %q is not available; use dagre or elk", engine)}
}

// textmeasure.Ruler caches glyph metrics and is not safe for concurrent use.
func (r *Renderer) ruler() (*textmeasure.Ruler, error) {
	if v := r.rulers.Get(); v != nil {
		return v.(*textmeasure.Ruler), nil
	}
	return textmeasure.NewRuler()
}
