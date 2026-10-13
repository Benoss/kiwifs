//go:build nod2

package d2render

import "context"

const Available = false

func (r *Renderer) render(context.Context, string, Options) ([]byte, error) {
	return nil, ErrUnavailable
}
