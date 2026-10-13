package pipeline

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strings"

	"github.com/kiwifs/kiwifs/internal/refactor"
	"github.com/kiwifs/kiwifs/internal/versioning"
)

const (
	// journalPath holds the pre-images of a restructuring in progress. It
	// exists only between the first write and the end of ApplyRefactor.
	journalPath = ".kiwi/state/refactor-journal.json"
	// undoDir keeps, per restructuring commit, the comment and
	// personal-state files it replaced: they are not in git, and a revert
	// must put them back byte for byte.
	undoDir = ".kiwi/state/refactor-undo"

	journalApplying  = "applying"
	journalCommitted = "committed"
)

// image is one file's state, before or after.
type image struct {
	Path    string `json:"path"`
	Existed bool   `json:"existed"`
	Content []byte `json:"content,omitempty"`
}

type journal struct {
	State  string  `json:"state"`
	Digest string  `json:"digest"`
	Actor  string  `json:"actor"`
	Head   string  `json:"head,omitempty"`
	Pages  []image `json:"pages"`
	Side   []image `json:"side"`
}

// undoRecord is what a revert needs: every file the restructuring
// replaced, before and after, and the moves for reporting.
type undoRecord struct {
	Digest string                `json:"digest"`
	Moves  []refactor.PathChange `json:"moves"`
	Merges []refactor.PathChange `json:"merges"`
	// Pages before and after. Git has them too, but only for files it
	// tracked: a page that was never committed would look created.
	PagesBefore []image `json:"pages_before"`
	PagesAfter  []image `json:"pages_after"`
	SideBefore  []image `json:"side_before"`
	SideAfter   []image `json:"side_after"`
}

// refactorTx is one ApplyRefactor in flight: the pre-images it captured,
// what it has touched so far, and how to put it all back.
type refactorTx struct {
	p   *Pipeline
	ctx context.Context

	pages       []image
	side        []image
	seen        map[string]bool
	touched     []string
	touchedSide []string
}

func (t *refactorTx) capturePage(path string) {
	if t.seen == nil {
		t.seen = map[string]bool{}
	}
	if t.seen["p:"+path] {
		return
	}
	t.seen["p:"+path] = true
	c, err := t.p.Store.Read(t.ctx, path)
	t.pages = append(t.pages, image{Path: path, Existed: err == nil, Content: c})
}

func (t *refactorTx) captureSide(path string) {
	if t.seen == nil {
		t.seen = map[string]bool{}
	}
	if t.seen["s:"+path] {
		return
	}
	t.seen["s:"+path] = true
	c, ok := readSide(t.p.Root, path)
	t.side = append(t.side, image{Path: path, Existed: ok, Content: c})
}

func readSide(root, path string) ([]byte, bool) {
	if root == "" {
		return nil, false
	}
	c, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(path)))
	return c, err == nil
}

// applyPages runs the page deletes and writes. A delete whose path folds
// to the same key as a write (Foo.md → foo.md, or NFD → NFC) names the
// same file on case- or normalization-insensitive filesystems (APFS,
// NTFS); it goes first, or deleting the old spelling after writing the
// new one removes the page.
func (t *refactorTx) applyPages(ops refactor.Ops) ([]string, error) {
	p, ctx := t.p, t.ctx
	writeKeys := make(map[string]bool, len(ops.Writes))
	for _, w := range ops.Writes {
		writeKeys[refactor.FoldKey(w.Path)] = true
	}
	var early, late []refactor.FileDelete
	for _, d := range ops.Deletes {
		if writeKeys[refactor.FoldKey(d.Path)] {
			early = append(early, d)
		} else {
			late = append(late, d)
		}
	}
	var paths []string
	del := func(d refactor.FileDelete) error {
		t.touched = append(t.touched, d.Path)
		p.markInflight(d.Path)
		p.tryPreDelete(d.Path)
		if err := p.Store.Delete(ctx, d.Path); err != nil {
			return fmt.Errorf("delete %s: %w", d.Path, err)
		}
		paths = append(paths, d.Path)
		return nil
	}
	for _, d := range early {
		if err := del(d); err != nil {
			return nil, err
		}
	}
	for _, w := range ops.Writes {
		t.touched = append(t.touched, w.Path)
		p.markInflightEtag(w.Path, ETag(w.Content))
		if err := p.Store.Write(ctx, w.Path, w.Content); err != nil {
			return nil, fmt.Errorf("write %s: %w", w.Path, err)
		}
		paths = append(paths, w.Path)
	}
	for _, d := range late {
		if err := del(d); err != nil {
			return nil, err
		}
	}
	return paths, nil
}

// rollback restores every touched file to its pre-image, side files
// first, pages in reverse order, then drops the journal.
func (t *refactorTx) rollback() {
	touchedSide := map[string]bool{}
	for _, s := range t.touchedSide {
		touchedSide[s] = true
	}
	for _, img := range t.side {
		if !touchedSide[img.Path] {
			continue
		}
		if err := restoreSide(t.p.Root, img); err != nil {
			log.Printf("pipeline: refactor rollback %s: %v", img.Path, err)
		}
	}
	touched := map[string]bool{}
	for _, path := range t.touched {
		touched[path] = true
	}
	for i := len(t.pages) - 1; i >= 0; i-- {
		img := t.pages[i]
		if !touched[img.Path] {
			continue
		}
		if err := t.p.restorePage(t.ctx, img); err != nil {
			log.Printf("pipeline: refactor rollback %s: %v", img.Path, err)
		}
	}
	t.removeJournal()
}

func (p *Pipeline) restorePage(ctx context.Context, img image) error {
	p.markInflight(img.Path)
	if img.Existed {
		return p.Store.Write(ctx, img.Path, img.Content)
	}
	if err := p.Store.Delete(ctx, img.Path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

func restoreSide(root string, img image) error {
	if img.Existed {
		return applySideWrite(root, refactor.SideWrite{Path: img.Path, Content: img.Content})
	}
	return applySideWrite(root, refactor.SideWrite{Path: img.Path, Delete: true})
}

func (t *refactorTx) writeJournal(digest, actor, head, state string) error {
	if t.p.Root == "" {
		return nil
	}
	j := journal{State: state, Digest: digest, Actor: actor, Head: head, Pages: t.pages, Side: t.side}
	data, err := json.Marshal(j)
	if err != nil {
		return err
	}
	return writeAtomic(filepath.Join(t.p.Root, filepath.FromSlash(journalPath)), data)
}

func (t *refactorTx) removeJournal() {
	if t.p.Root == "" {
		return
	}
	if err := os.Remove(filepath.Join(t.p.Root, filepath.FromSlash(journalPath))); err != nil && !os.IsNotExist(err) {
		log.Printf("pipeline: remove refactor journal: %v", err)
	}
}

func (t *refactorTx) writeUndo(sha string, plan *refactor.Plan) error {
	if t.p.Root == "" || !versioning.ValidRev(sha) {
		return nil
	}
	rec := undoRecord{Digest: plan.Digest, Moves: plan.Moves, Merges: plan.Merges, PagesBefore: t.pages, SideBefore: t.side}
	for _, img := range t.pages {
		c, err := t.p.Store.Read(t.ctx, img.Path)
		rec.PagesAfter = append(rec.PagesAfter, image{Path: img.Path, Existed: err == nil, Content: c})
	}
	for _, img := range t.side {
		c, ok := readSide(t.p.Root, img.Path)
		rec.SideAfter = append(rec.SideAfter, image{Path: img.Path, Existed: ok, Content: c})
	}
	data, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	return writeAtomic(filepath.Join(t.p.Root, filepath.FromSlash(undoDir), sha+".json"), data)
}

func readUndo(root, sha string) (*undoRecord, error) {
	if root == "" || !versioning.ValidRev(sha) {
		return nil, os.ErrNotExist
	}
	data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(undoDir), sha+".json"))
	if err != nil {
		return nil, err
	}
	var rec undoRecord
	if err := json.Unmarshal(data, &rec); err != nil {
		return nil, err
	}
	return &rec, nil
}

// writeAtomic writes to a temp file, fsyncs it and renames it into place,
// so a reader (or a restart after a crash) never sees half a document.
func writeAtomic(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// RecoverRefactor finishes what a crash interrupted. A journal still
// "applying" means the process died between the first write and the
// commit: unless HEAD shows that commit landed anyway, every page and side
// file goes back to its pre-image. A "committed" journal only needs
// removing. Call it at startup, before the watcher and the indexes run.
func (p *Pipeline) RecoverRefactor(ctx context.Context) error {
	if p.Root == "" {
		return nil
	}
	abs := filepath.Join(p.Root, filepath.FromSlash(journalPath))
	data, err := os.ReadFile(abs)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var j journal
	if err := json.Unmarshal(data, &j); err != nil {
		return fmt.Errorf("refactor journal %s is unreadable; inspect it and remove it by hand: %w", abs, err)
	}
	t := &refactorTx{p: p, ctx: ctx}
	if j.State == journalApplying && !p.digestCommitted(ctx, j) {
		p.writeMu.Lock()
		for _, img := range j.Side {
			if err := restoreSide(p.Root, img); err != nil {
				log.Printf("pipeline: refactor recovery %s: %v", img.Path, err)
			}
		}
		for i := len(j.Pages) - 1; i >= 0; i-- {
			if err := p.restorePage(ctx, j.Pages[i]); err != nil {
				log.Printf("pipeline: refactor recovery %s: %v", j.Pages[i].Path, err)
			}
		}
		p.writeMu.Unlock()
		log.Printf("pipeline: rolled back an interrupted restructuring (digest %s, %d pages)", j.Digest, len(j.Pages))
	}
	t.removeJournal()
	return nil
}

// digestCommitted reports whether the commit for j's restructuring landed
// before the crash: HEAD moved and carries j's digest trailer.
func (p *Pipeline) digestCommitted(ctx context.Context, j journal) bool {
	rec, ok := versioning.AsRecorder(p.Versioner)
	if !ok {
		return false
	}
	head, err := rec.Head(ctx)
	if err != nil || head == "" || head == j.Head {
		return false
	}
	msg, err := rec.CommitMessage(ctx, head)
	if err != nil {
		return false
	}
	return strings.Contains(msg, trailerDigest+": "+j.Digest)
}

// ErrRevertUnsupported is returned when the versioner keeps no readable
// history, so there is nothing to revert from.
var ErrRevertUnsupported = errors.New("revert needs git versioning")

// PlanRevert builds the plan that undoes commit: every page it changed goes
// back to its previous bytes, comment and personal-state files back to
// what the restructuring replaced. Pages changed since make the plan
// invalid rather than being overwritten.
func (p *Pipeline) PlanRevert(ctx context.Context, commit string) (*refactor.Plan, error) {
	rec, ok := versioning.AsRecorder(p.Versioner)
	if !ok {
		return nil, ErrRevertUnsupported
	}
	if !versioning.ValidRev(commit) || strings.HasSuffix(commit, "^") {
		return nil, fmt.Errorf("invalid commit id %q", commit)
	}
	in := refactor.RevertInput{Commit: commit}
	if undo, err := readUndo(p.Root, commit); err == nil {
		after := map[string]image{}
		for _, img := range undo.PagesAfter {
			after[img.Path] = img
		}
		for _, b := range undo.PagesBefore {
			a := after[b.Path]
			in.Pages = append(in.Pages, refactor.FileChange{Path: b.Path, Before: b.Content, Existed: b.Existed, After: a.Content, Exists: a.Existed})
		}
		after = map[string]image{}
		for _, img := range undo.SideAfter {
			after[img.Path] = img
		}
		for _, b := range undo.SideBefore {
			a := after[b.Path]
			in.Side = append(in.Side, refactor.SideChange{
				Path:   b.Path,
				Before: refactor.SideImage{Existed: b.Existed, Content: b.Content},
				After:  refactor.SideImage{Existed: a.Existed, Content: a.Content},
			})
		}
		in.Moves, in.Merges = undo.Moves, undo.Merges
	} else {
		// No undo record (not a restructuring, or .kiwi/state was
		// cleared): git is the record, which only knows tracked files. In
		// a first commit every file looks created, so refuse that.
		if _, err := rec.CommitMessage(ctx, commit+"^"); err != nil {
			return nil, fmt.Errorf("%s has no parent commit and no undo record; nothing to revert to", commit)
		}
		paths, err := rec.ChangedFiles(ctx, commit)
		if err != nil {
			return nil, fmt.Errorf("read commit %s: %w", commit, err)
		}
		for _, path := range paths {
			before, existed, err := rec.FileAt(ctx, path, commit+"^")
			if err != nil {
				return nil, err
			}
			after, exists, err := rec.FileAt(ctx, path, commit)
			if err != nil {
				return nil, err
			}
			in.Pages = append(in.Pages, refactor.FileChange{Path: path, Before: before, Existed: existed, After: after, Exists: exists})
		}
	}
	plan, err := refactor.BuildRevert(ctx, p.RefactorWorkspace(), in)
	if err != nil {
		return nil, err
	}
	plan.Base, _ = rec.Head(ctx)
	return plan, nil
}

// Revert plans and applies the undo of commit, with the same digest
// contract as Refactor: a non-empty digest must match the reviewed plan.
func (p *Pipeline) Revert(ctx context.Context, commit, digest, client, actor string) (*refactor.Plan, RefactorResult, error) {
	plan, err := p.PlanRevert(ctx, commit)
	if err != nil {
		return nil, RefactorResult{}, err
	}
	plan.Client = client
	if len(plan.Errors) > 0 {
		return plan, RefactorResult{}, fmt.Errorf("%w: %s", ErrPlanInvalid, strings.Join(plan.Errors, "; "))
	}
	if digest != "" && digest != plan.Digest {
		return plan, RefactorResult{}, ErrDigestMismatch
	}
	res, err := p.ApplyRefactor(ctx, plan, actor)
	return plan, res, err
}
