// Package d2render turns D2 diagram source into SVG inside the kiwifs
// process: D2's layout engines are native Go, so there is no JS runtime, no
// subprocess and no network call.
package d2render

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime/debug"
	"sort"
	"strings"
	"sync"
	"time"
)

// MaxSourceBytes bounds what one request may ask the layout engine to chew on.
const MaxSourceBytes = 64 << 10

const (
	defaultTimeout = 10 * time.Second
	// Renders that outlive their request keep running until D2 returns, so
	// concurrency is capped by slots, not by requests.
	maxConcurrent  = 2
	maxCachedFiles = 1000
	pruneEvery     = 64
)

var (
	ErrTooLarge = fmt.Errorf("d2 source exceeds %d bytes", MaxSourceBytes)
	ErrEmpty    = errors.New("d2 source is empty")
	ErrTimeout  = errors.New("d2 render timed out")
	// ErrUnavailable means this binary was built with -tags nod2.
	ErrUnavailable = errors.New("this kiwifs binary was built without D2 support")
)

// SourceError is a problem with the diagram itself, as opposed to the server.
type SourceError struct{ Msg string }

func (e *SourceError) Error() string { return e.Msg }

type Options struct {
	Dark bool
}

type Renderer struct {
	dir     string
	timeout time.Duration
	slots   chan struct{}
	rulers  sync.Pool
	version string

	mu     sync.Mutex
	writes int
}

// New returns a renderer caching under dir; an empty dir disables the cache.
func New(dir string) *Renderer {
	return &Renderer{
		dir:     dir,
		timeout: defaultTimeout,
		slots:   make(chan struct{}, maxConcurrent),
		version: engineVersion(),
	}
}

// CacheDir is where a knowledge root keeps rendered diagrams. It is
// derivative state, like the search index.
func CacheDir(root string) string {
	return filepath.Join(root, ".kiwi", "state", "d2")
}

// Key identifies a render: the same source, options and D2 version always
// produce the same SVG.
func (r *Renderer) Key(src string, opts Options) string {
	h := sha256.New()
	fmt.Fprintf(h, "d2 %s\x00dark=%t\x00", r.version, opts.Dark)
	io.WriteString(h, src)
	return hex.EncodeToString(h.Sum(nil))
}

func (r *Renderer) Render(ctx context.Context, src string, opts Options) ([]byte, error) {
	if len(src) > MaxSourceBytes {
		return nil, ErrTooLarge
	}
	if strings.TrimSpace(src) == "" {
		return nil, ErrEmpty
	}
	if !Available {
		return nil, ErrUnavailable
	}
	key := r.Key(src, opts)
	if svg, ok := r.load(key); ok {
		return svg, nil
	}

	ctx, cancel := context.WithTimeout(ctx, r.timeout)
	defer cancel()
	select {
	case r.slots <- struct{}{}:
	case <-ctx.Done():
		return nil, ErrTimeout
	}

	type result struct {
		svg []byte
		err error
	}
	done := make(chan result, 1)
	go func() {
		defer func() { <-r.slots }()
		defer func() {
			if p := recover(); p != nil {
				done <- result{err: &SourceError{Msg: fmt.Sprintf("d2 could not render this diagram: %v", p)}}
			}
		}()
		svg, err := r.render(ctx, src, opts)
		done <- result{svg, err}
	}()

	select {
	case res := <-done:
		if res.err != nil {
			return nil, res.err
		}
		r.store(key, res.svg)
		return res.svg, nil
	case <-ctx.Done():
		return nil, ErrTimeout
	}
}

func (r *Renderer) load(key string) ([]byte, bool) {
	if r.dir == "" {
		return nil, false
	}
	b, err := os.ReadFile(filepath.Join(r.dir, key+".svg"))
	return b, err == nil
}

func (r *Renderer) store(key string, svg []byte) {
	if r.dir == "" {
		return
	}
	if err := os.MkdirAll(r.dir, 0o755); err != nil {
		return
	}
	tmp, err := os.CreateTemp(r.dir, key+".*.tmp")
	if err != nil {
		return
	}
	_, werr := tmp.Write(svg)
	cerr := tmp.Close()
	if werr != nil || cerr != nil || os.Rename(tmp.Name(), filepath.Join(r.dir, key+".svg")) != nil {
		os.Remove(tmp.Name())
		return
	}

	r.mu.Lock()
	r.writes++
	prune := r.writes%pruneEvery == 0
	r.mu.Unlock()
	if prune {
		r.prune()
	}
}

// prune drops the oldest renders once the cache outgrows maxCachedFiles, so
// a live preview typed character by character cannot fill the disk.
func (r *Renderer) prune() {
	entries, err := os.ReadDir(r.dir)
	if err != nil {
		return
	}
	type file struct {
		name string
		mod  time.Time
	}
	files := make([]file, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".svg" {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		files = append(files, file{e.Name(), info.ModTime()})
	}
	if len(files) <= maxCachedFiles {
		return
	}
	sort.Slice(files, func(i, j int) bool { return files[i].mod.Before(files[j].mod) })
	for _, f := range files[:len(files)-maxCachedFiles] {
		os.Remove(filepath.Join(r.dir, f.name))
	}
}

func engineVersion() string {
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, dep := range info.Deps {
			if dep.Path == "github.com/d2lang/d2" {
				return dep.Version
			}
		}
	}
	return "unknown"
}
