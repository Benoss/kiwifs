//go:build !nod2

package d2render

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRenderProducesSVG(t *testing.T) {
	r := New("")
	svg, err := r.Render(context.Background(), "client -> server: request\nserver -> db", Options{})
	if err != nil {
		t.Fatal(err)
	}
	s := string(svg)
	if !strings.Contains(s, "<svg") || !strings.Contains(s, "client") || !strings.Contains(s, "request") {
		t.Fatalf("unexpected svg: %.200s", s)
	}
}

func TestDarkThemeChangesOutputAndKey(t *testing.T) {
	r := New("")
	light, err := r.Render(context.Background(), "a -> b", Options{})
	if err != nil {
		t.Fatal(err)
	}
	dark, err := r.Render(context.Background(), "a -> b", Options{Dark: true})
	if err != nil {
		t.Fatal(err)
	}
	if string(light) == string(dark) {
		t.Fatal("dark render should differ from light")
	}
	if r.Key("a -> b", Options{}) == r.Key("a -> b", Options{Dark: true}) {
		t.Fatal("cache key must include the theme")
	}
}

func TestELKLayout(t *testing.T) {
	src := "vars: {d2-config: {layout-engine: elk}}\na -> b -> c"
	if _, err := New("").Render(context.Background(), src, Options{}); err != nil {
		t.Fatal(err)
	}
}

func TestSourceErrors(t *testing.T) {
	r := New("")
	for name, src := range map[string]string{
		"syntax":  "a -> {",
		"layout":  "vars: {d2-config: {layout-engine: tala}}\na -> b",
		"imports": "...@etc/passwd\na -> b",
	} {
		_, err := r.Render(context.Background(), src, Options{})
		var se *SourceError
		if !errors.As(err, &se) {
			t.Errorf("%s: want SourceError, got %v", name, err)
		}
	}
}

func TestImportsCannotReadTheFilesystem(t *testing.T) {
	dir := t.TempDir()
	secret := filepath.Join(dir, "secret.d2")
	if err := os.WriteFile(secret, []byte("leaked_node"), 0o600); err != nil {
		t.Fatal(err)
	}
	svg, err := New("").Render(context.Background(), fmt.Sprintf("x: @%s", strings.TrimSuffix(secret, ".d2")), Options{})
	if strings.Contains(string(svg), "leaked_node") {
		t.Fatal("an import read a file off the server's disk")
	}
	var se *SourceError
	if !errors.As(err, &se) {
		t.Fatalf("an import should be a source error, got %v", err)
	}
	t.Log(se.Msg)
}

func TestLimits(t *testing.T) {
	r := New("")
	if _, err := r.Render(context.Background(), strings.Repeat("a", MaxSourceBytes+1), Options{}); !errors.Is(err, ErrTooLarge) {
		t.Errorf("want ErrTooLarge, got %v", err)
	}
	if _, err := r.Render(context.Background(), " \n ", Options{}); !errors.Is(err, ErrEmpty) {
		t.Errorf("want ErrEmpty, got %v", err)
	}
}

func TestTimeoutReturnsWhileRenderContinues(t *testing.T) {
	r := New("")
	r.timeout = time.Nanosecond
	var b strings.Builder
	for i := range 400 {
		fmt.Fprintf(&b, "n%d -> n%d\n", i, (i*7+3)%400)
	}
	_, err := r.Render(context.Background(), b.String(), Options{})
	if !errors.Is(err, ErrTimeout) {
		t.Fatalf("want ErrTimeout, got %v", err)
	}
}

func TestDiskCache(t *testing.T) {
	dir := t.TempDir()
	r := New(dir)
	src := "cached -> hit"
	first, err := r.Render(context.Background(), src, Options{})
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, r.Key(src, Options{})+".svg")
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("render was not cached: %v", err)
	}
	if err := os.WriteFile(path, []byte("<svg>from cache</svg>"), 0o644); err != nil {
		t.Fatal(err)
	}
	again, err := r.Render(context.Background(), src, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if string(again) != "<svg>from cache</svg>" || string(first) == string(again) {
		t.Fatal("second render should come from the cache")
	}
}

func TestPruneKeepsNewest(t *testing.T) {
	dir := t.TempDir()
	r := New(dir)
	base := time.Now().Add(-time.Hour)
	for i := range maxCachedFiles + 5 {
		p := filepath.Join(dir, fmt.Sprintf("%04d.svg", i))
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		mod := base.Add(time.Duration(i) * time.Second)
		if err := os.Chtimes(p, mod, mod); err != nil {
			t.Fatal(err)
		}
	}
	r.prune()
	entries, _ := os.ReadDir(dir)
	if len(entries) != maxCachedFiles {
		t.Fatalf("want %d files, got %d", maxCachedFiles, len(entries))
	}
	if _, err := os.Stat(filepath.Join(dir, "0000.svg")); !os.IsNotExist(err) {
		t.Fatal("oldest render should have been pruned")
	}
}
