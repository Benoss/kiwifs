package pipeline

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/kiwifs/kiwifs/internal/refactor"
	"github.com/kiwifs/kiwifs/internal/versioning"
)

// rawMovesPath logs moves that happened without the refactor engine
// relinking anything: WebDAV and NFS renames, update_links=false, and files
// moved on disk behind KiwiFS's back. Each one may have left references
// pointing at a path that no longer exists; RawMoveFix turns the log into a
// relinks manifest that repairs them.
const rawMovesPath = ".kiwi/state/raw-moves.jsonl"

// rawMovePairWindow is how long a deletion and a creation of the same bytes
// are taken to be one move seen by the file watcher.
const rawMovePairWindow = 30 * time.Second

// RawMove is one move that left references behind.
type RawMove struct {
	From  string    `json:"from"`
	To    string    `json:"to"`
	Actor string    `json:"actor"`
	At    time.Time `json:"at"`
	// Via says how it was seen: "rename" (a protocol rename), "links-kept"
	// (a move asked not to relink), or "watcher" (on disk, by fsnotify).
	Via string `json:"via"`
}

type rawMoveTracker struct {
	mu sync.Mutex
	// deleted: blob hash of a file the watcher saw disappear → path, time.
	deleted map[string]seenFile
	// created: blob hash of a file the watcher saw appear → path, time.
	created map[string]seenFile
}

type seenFile struct {
	path string
	at   time.Time
}

func (p *Pipeline) noteRawMove(from, to, actor, via string) {
	if p.Root == "" || from == "" || to == "" || from == to {
		return
	}
	line, err := json.Marshal(RawMove{From: from, To: to, Actor: actor, At: time.Now().UTC(), Via: via})
	if err != nil {
		return
	}
	abs := filepath.Join(p.Root, filepath.FromSlash(rawMovesPath))
	p.rawMoves.mu.Lock()
	defer p.rawMoves.mu.Unlock()
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return
	}
	f, err := os.OpenFile(abs, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		log.Printf("pipeline: raw move log: %v", err)
		return
	}
	defer f.Close()
	f.Write(append(line, '\n'))
}

// referenced reports whether anything links to path, when the link index
// can tell; without one every move counts.
func (p *Pipeline) referenced(ctx context.Context, path string) bool {
	if p.Linker == nil {
		return true
	}
	entries, err := p.Linker.Backlinks(ctx, path)
	return err != nil || len(entries) > 0
}

// RawMoves returns the logged moves, oldest first.
func (p *Pipeline) RawMoves() ([]RawMove, error) {
	if p.Root == "" {
		return nil, nil
	}
	p.rawMoves.mu.Lock()
	defer p.rawMoves.mu.Unlock()
	data, err := os.ReadFile(filepath.Join(p.Root, filepath.FromSlash(rawMovesPath)))
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []RawMove
	sc := bufio.NewScanner(bytes.NewReader(data))
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		var m RawMove
		if json.Unmarshal(sc.Bytes(), &m) == nil && m.From != "" && m.To != "" {
			out = append(out, m)
		}
	}
	return out, sc.Err()
}

// rewriteRawMoves keeps only the moves keep accepts.
func (p *Pipeline) rewriteRawMoves(keep func(RawMove) bool) {
	moves, err := p.RawMoves()
	if err != nil || len(moves) == 0 {
		return
	}
	var buf bytes.Buffer
	for _, m := range moves {
		if keep(m) {
			line, _ := json.Marshal(m)
			buf.Write(append(line, '\n'))
		}
	}
	p.rawMoves.mu.Lock()
	defer p.rawMoves.mu.Unlock()
	abs := filepath.Join(p.Root, filepath.FromSlash(rawMovesPath))
	if buf.Len() == 0 {
		_ = os.Remove(abs)
		return
	}
	if err := writeAtomic(abs, buf.Bytes()); err != nil {
		log.Printf("pipeline: raw move log: %v", err)
	}
}

// RawMoveFix builds the relinks manifest that repairs the logged moves,
// following chains (a → b, then b → c, repairs references to a as c), and
// prunes moves there is nothing left to repair for. The manifest is nil
// when no move needs fixing. Plan and apply it like any manifest.
func (p *Pipeline) RawMoveFix(ctx context.Context) (*refactor.Manifest, []RawMove, error) {
	moves, err := p.RawMoves()
	if err != nil || len(moves) == 0 {
		return nil, nil, err
	}
	next := map[string]string{}
	for _, m := range moves {
		next[m.From] = m.To
	}
	var live []RawMove
	var relinks []refactor.Move
	seen := map[string]bool{}
	for _, m := range moves {
		to := m.To
		for hops := 0; hops < len(moves); hops++ {
			n, ok := next[to]
			if !ok || n == to {
				break
			}
			to = n
		}
		if seen[m.From] || p.Store.Exists(ctx, m.From) || !p.Store.Exists(ctx, to) && !p.dirExists(ctx, to) {
			continue
		}
		seen[m.From] = true
		live = append(live, m)
		relinks = append(relinks, refactor.Move{From: m.From, To: to})
	}
	if len(relinks) == 0 {
		p.rewriteRawMoves(func(RawMove) bool { return false })
		return nil, nil, nil
	}
	sort.Slice(relinks, func(i, j int) bool { return relinks[i].From < relinks[j].From })
	m := &refactor.Manifest{Relinks: relinks}
	plan, err := p.PlanRefactor(ctx, m, refactor.Options{})
	if err != nil {
		return nil, nil, err
	}
	if len(plan.Errors) == 0 && len(plan.Edits) == 0 {
		// Nothing references the old paths any more.
		p.rewriteRawMoves(func(RawMove) bool { return false })
		return nil, nil, nil
	}
	return m, live, nil
}

func (p *Pipeline) dirExists(ctx context.Context, path string) bool {
	info, err := p.Store.Stat(ctx, path)
	return err == nil && info != nil && info.IsDir
}

// pruneRelinked drops logged moves a successful relinks manifest repaired.
func (p *Pipeline) pruneRelinked(relinks []refactor.Move) {
	if len(relinks) == 0 {
		return
	}
	fixed := map[string]bool{}
	for _, r := range relinks {
		fixed[strings.Trim(r.From, "/")] = true
	}
	p.rewriteRawMoves(func(m RawMove) bool {
		for f := range fixed {
			if m.From == f || strings.HasPrefix(m.From, f+"/") {
				return false
			}
		}
		return true
	})
}

// watchDeleted and watchCreated pair the watcher's view of a move: the
// same bytes disappearing at one path and appearing at another within
// rawMovePairWindow, in either order. A deleted file's bytes come from git
// (it is gone from disk by the time we hear of it), so this needs history.
func (p *Pipeline) watchDeleted(ctx context.Context, path, actor string) {
	rec, ok := versioning.AsRecorder(p.Versioner)
	if !ok {
		return
	}
	head, err := rec.Head(ctx)
	if err != nil || head == "" {
		return
	}
	content, existed, err := rec.FileAt(ctx, path, head)
	if err != nil || !existed {
		return
	}
	blob := ETag(content)
	t := &p.rawMoves
	t.mu.Lock()
	created, ok := t.created[blob]
	if ok && time.Since(created.at) < rawMovePairWindow && created.path != path {
		delete(t.created, blob)
		t.mu.Unlock()
		if p.referenced(ctx, path) {
			p.noteRawMove(path, created.path, actor, "watcher")
		}
		return
	}
	if t.deleted == nil {
		t.deleted = map[string]seenFile{}
	}
	pruneSeen(t.deleted)
	t.deleted[blob] = seenFile{path: path, at: time.Now()}
	t.mu.Unlock()
}

func (p *Pipeline) watchCreated(ctx context.Context, path, etag, actor string) {
	t := &p.rawMoves
	t.mu.Lock()
	deleted, ok := t.deleted[etag]
	if ok && time.Since(deleted.at) < rawMovePairWindow && deleted.path != path {
		delete(t.deleted, etag)
		t.mu.Unlock()
		if p.referenced(ctx, deleted.path) {
			p.noteRawMove(deleted.path, path, actor, "watcher")
		}
		return
	}
	if t.created == nil {
		t.created = map[string]seenFile{}
	}
	pruneSeen(t.created)
	t.created[etag] = seenFile{path: path, at: time.Now()}
	t.mu.Unlock()
}

func pruneSeen(m map[string]seenFile) {
	for k, v := range m {
		if time.Since(v.at) > rawMovePairWindow {
			delete(m, k)
		}
	}
}
