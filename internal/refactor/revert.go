package refactor

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// FileChange is one page a commit touched: its bytes before and after.
type FileChange struct {
	Path    string
	Before  []byte
	Existed bool // before the commit
	After   []byte
	Exists  bool // after the commit
}

// SideChange is a comment or personal-state file a restructuring rewrote,
// from its undo record (side files are not in git).
type SideChange struct {
	Path   string
	Before SideImage
	After  SideImage
}

// RevertInput is everything a revert plan is built from.
type RevertInput struct {
	Commit string
	Pages  []FileChange
	Side   []SideChange
	// Moves and Merges of the original restructuring, for the report.
	Moves  []PathChange
	Merges []PathChange
}

// BuildRevert plans undoing a commit, f2-style: every file the commit
// changed goes back to its bytes before it, but only if it still holds
// exactly what the commit left there. A page edited since is an error, not
// something to overwrite: the revert is refused until that edit is dealt
// with. Applying goes through ApplyRefactor like any plan: one commit,
// indexes and SSE updated.
func BuildRevert(ctx context.Context, ws Workspace, in RevertInput) (*Plan, error) {
	files, err := listFiles(ctx, ws.Store)
	if err != nil {
		return nil, err
	}
	p := &planner{
		ws:      ws,
		plan:    &Plan{Moves: []PathChange{}, Merges: []PathChange{}, Edits: []FileEdit{}, Reverts: in.Commit},
		files:   files,
		exists:  make(map[string]bool, len(files)),
		moved:   map[string]string{},
		merged:  map[string]string{},
		content: map[string][]byte{},
	}
	for _, f := range files {
		p.exists[f] = true
	}
	short := in.Commit
	if len(short) > 12 {
		short = short[:12]
	}

	for _, c := range in.Pages {
		if hiddenPath(c.Path) {
			p.plan.Warnings = append(p.plan.Warnings, fmt.Sprintf("%s is not a page; left as it is", c.Path))
			continue
		}
		cur, err := ws.Store.Read(ctx, c.Path)
		present := err == nil
		switch {
		case c.Exists && (!present || !bytes.Equal(cur, c.After)):
			p.errorf("%s has changed since %s; reverting would discard that change", c.Path, short)
			continue
		case !c.Exists && present:
			p.errorf("%s was created again since %s; reverting would overwrite it", c.Path, short)
			continue
		}
		switch {
		case c.Existed && c.Exists:
			if bytes.Equal(c.Before, c.After) {
				continue
			}
			p.plan.Ops.Writes = append(p.plan.Ops.Writes, FileWrite{Path: c.Path, Content: c.Before, Source: c.Path, SourceETag: ETag(c.After)})
			p.plan.Edits = append(p.plan.Edits, FileEdit{Path: c.Path, Links: []LinkEdit{}})
		case c.Existed:
			p.plan.Ops.Writes = append(p.plan.Ops.Writes, FileWrite{Path: c.Path, Content: c.Before})
		case c.Exists:
			p.plan.Ops.Deletes = append(p.plan.Ops.Deletes, FileDelete{Path: c.Path, ETag: ETag(c.After)})
			p.moved[c.Path] = ""
		}
	}

	for _, s := range in.Side {
		after := s.After
		w := SideWrite{Path: s.Path, Precondition: &after}
		if s.Before.Existed {
			w.Content = s.Before.Content
		} else {
			w.Delete = true
		}
		if s.Before.Existed == s.After.Existed && bytes.Equal(s.Before.Content, s.After.Content) {
			continue
		}
		cur, existed := readSideFile(ws.Root, s.Path)
		if existed != after.Existed || existed && !bytes.Equal(cur, after.Content) {
			p.errorf("%s has changed since %s; reverting would discard that change", s.Path, short)
			continue
		}
		p.plan.Ops.Side = append(p.plan.Ops.Side, w)
	}

	for _, mv := range in.Moves {
		p.plan.Moves = append(p.plan.Moves, PathChange{From: mv.To, To: mv.From})
	}
	for _, mg := range in.Merges {
		p.plan.Merges = append(p.plan.Merges, PathChange{From: mg.To, To: mg.From})
	}
	if len(p.plan.Errors) > 0 {
		p.plan.Ops = Ops{}
		return p.plan, nil
	}
	if len(p.plan.Ops.Writes)+len(p.plan.Ops.Deletes)+len(p.plan.Ops.Side) == 0 {
		p.errorf("%s changed nothing that can be reverted", short)
		return p.plan, nil
	}

	// Folders the reverted commit created and that are now empty go too.
	var post []string
	deleted := map[string]bool{}
	for _, d := range p.plan.Ops.Deletes {
		deleted[d.Path] = true
	}
	for _, f := range files {
		if !deleted[f] {
			post = append(post, f)
		}
	}
	for _, w := range p.plan.Ops.Writes {
		if !p.exists[w.Path] {
			post = append(post, w.Path)
		}
	}
	p.planEmptyDirs(post)
	p.plan.Digest = p.digest()
	return p.plan, nil
}

func readSideFile(root, path string) ([]byte, bool) {
	if root == "" {
		return nil, false
	}
	c, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(path)))
	return c, err == nil
}

func hiddenPath(path string) bool {
	for _, seg := range strings.Split(path, "/") {
		if strings.HasPrefix(seg, ".") {
			return true
		}
	}
	return false
}
