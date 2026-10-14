package versioning

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
)

// Recorder is implemented by versioners that can commit synchronously and
// say which commit they made, and read a commit back. A restructuring needs
// both: a commit that fails must fail the restructuring (not be logged),
// and undoing one means reading the exact bytes it replaced.
type Recorder interface {
	// CommitRecorded stages paths and commits them now. sha is "" when
	// nothing changed.
	CommitRecorded(ctx context.Context, paths []string, actor, message string) (sha string, err error)
	// Head returns the current commit, or "" before the first one.
	Head(ctx context.Context) (string, error)
	// ChangedFiles lists the workspace paths a commit touched.
	ChangedFiles(ctx context.Context, sha string) ([]string, error)
	// FileAt returns path's bytes at a commit, and false when it did not
	// exist there. rev may be a sha or sha^.
	FileAt(ctx context.Context, path, rev string) ([]byte, bool, error)
	// CommitMessage returns a commit's full message.
	CommitMessage(ctx context.Context, sha string) (string, error)
}

// ErrNotRecording is returned when the configured versioner keeps no
// history that can be read back (versioning "none" or copy-on-write).
var ErrNotRecording = errors.New("versioning keeps no commit history to read back")

var revRe = regexp.MustCompile(`^[0-9a-fA-F]{4,64}\^?$`)

// ValidRev reports whether rev is a plain commit id (optionally with ^).
// Anything else is refused before it reaches git's argv, where a value
// like --output=… would be read as an option.
func ValidRev(rev string) bool {
	return revRe.MatchString(rev)
}

// AsRecorder returns the Recorder behind v, looking through AsyncGit.
func AsRecorder(v Versioner) (Recorder, bool) {
	switch x := v.(type) {
	case *AsyncGit:
		if _, ok := x.inner.(Recorder); ok {
			return asyncRecorder{x}, true
		}
		return nil, false
	case Recorder:
		return x, true
	}
	return nil, false
}

func (g *Git) Head(ctx context.Context) (string, error) {
	out, err := g.output(ctx, "git", "rev-parse", "--verify", "-q", "HEAD")
	if err != nil {
		// No commits yet.
		return "", nil
	}
	return strings.TrimSpace(out), nil
}

func (g *Git) CommitRecorded(ctx context.Context, paths []string, actor, message string) (string, error) {
	before, _ := g.Head(ctx)
	if err := g.BulkCommit(ctx, paths, actor, message); err != nil {
		return "", err
	}
	after, err := g.Head(ctx)
	if err != nil || after == before {
		return "", err
	}
	return after, nil
}

func (g *Git) ChangedFiles(ctx context.Context, sha string) ([]string, error) {
	if !ValidRev(sha) {
		return nil, fmt.Errorf("invalid commit id %q", sha)
	}
	out, err := g.output(ctx, "git", "diff-tree", "--no-commit-id", "--name-only", "--no-renames", "-r", "-z", "--root", sha)
	if err != nil {
		return nil, err
	}
	var paths []string
	for _, p := range strings.Split(out, "\x00") {
		if p != "" {
			paths = append(paths, p)
		}
	}
	return paths, nil
}

func (g *Git) FileAt(ctx context.Context, path, rev string) ([]byte, bool, error) {
	if !ValidRev(rev) {
		return nil, false, fmt.Errorf("invalid commit id %q", rev)
	}
	if strings.ContainsAny(path, "\n\r") || strings.HasPrefix(path, "-") {
		return nil, false, fmt.Errorf("invalid path %q", path)
	}
	if strings.HasSuffix(rev, "^") {
		// The root commit has no parent: everything in it was created.
		if _, err := g.output(ctx, "git", "rev-parse", "--verify", "-q", rev); err != nil {
			return nil, false, nil
		}
	}
	// ls-tree tells "absent" (empty output) apart from a git failure (an
	// error); cat-file -e cannot, and guessing "absent" would turn a broken
	// repository into deletes.
	listing, err := g.output(ctx, "git", "ls-tree", "-z", "--full-tree", rev, "--", path)
	if err != nil {
		return nil, false, err
	}
	var blob string
	for _, entry := range strings.Split(listing, "\x00") {
		meta, name, ok := strings.Cut(entry, "\t")
		if !ok || name != path {
			continue
		}
		if f := strings.Fields(meta); len(f) == 3 && f[1] == "blob" {
			blob = f[2]
		}
	}
	if blob == "" {
		return nil, false, nil
	}
	// cat-file gives the stored blob byte for byte; show could apply
	// textconv.
	out, err := g.output(ctx, "git", "cat-file", "blob", blob)
	if err != nil {
		return nil, false, err
	}
	return []byte(out), true, nil
}

func (g *Git) CommitMessage(ctx context.Context, sha string) (string, error) {
	if !ValidRev(sha) {
		return "", fmt.Errorf("invalid commit id %q", sha)
	}
	return g.output(ctx, "git", "log", "-1", "--format=%B", sha)
}

// asyncRecorder commits through AsyncGit's loop, so a synchronous commit
// is still serialized with the batched ones and lands after them.
type asyncRecorder struct{ a *AsyncGit }

func (r asyncRecorder) inner() Recorder { return r.a.inner.(Recorder) }

func (r asyncRecorder) CommitRecorded(ctx context.Context, paths []string, actor, message string) (string, error) {
	done := make(chan syncResult, 1)
	select {
	case r.a.pending <- commitReq{paths: paths, actor: actor, message: message, done: done}:
	case <-r.a.stop:
		return "", fmt.Errorf("versioning is shutting down")
	case <-ctx.Done():
		return "", ctx.Err()
	}
	select {
	case res := <-done:
		return res.sha, res.err
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

func (r asyncRecorder) Head(ctx context.Context) (string, error) { return r.inner().Head(ctx) }
func (r asyncRecorder) ChangedFiles(ctx context.Context, sha string) ([]string, error) {
	return r.inner().ChangedFiles(ctx, sha)
}
func (r asyncRecorder) FileAt(ctx context.Context, path, rev string) ([]byte, bool, error) {
	return r.inner().FileAt(ctx, path, rev)
}
func (r asyncRecorder) CommitMessage(ctx context.Context, sha string) (string, error) {
	return r.inner().CommitMessage(ctx, sha)
}
