//go:build nod2

package d2render

import (
	"context"
	"errors"
	"testing"
)

func TestWithoutD2(t *testing.T) {
	if _, err := New("").Render(context.Background(), "a -> b", Options{}); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("want ErrUnavailable, got %v", err)
	}
}
