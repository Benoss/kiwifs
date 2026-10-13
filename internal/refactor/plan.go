package refactor

import (
	"context"
	"crypto/sha1"
	"crypto/sha256"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/bmatcuk/doublestar/v4"
	"github.com/kiwifs/kiwifs/internal/links"
	"github.com/kiwifs/kiwifs/internal/storage"
)

// Workspace is what a plan reads: pages through Store, and the comment and
// personal-state files under Root that are keyed by page path.
type Workspace struct {
	Root  string
	Store storage.Storage
	// TypedFields are the frontmatter keys whose values are page references
	// ([links] typed_fields). Nil means links.DefaultTypedLinkFields.
	TypedFields []string
}

func (ws Workspace) typedFields() []string {
	if ws.TypedFields == nil {
		return links.DefaultTypedLinkFields()
	}
	return ws.TypedFields
}

// PathChange is one path that changes, for reports.
type PathChange struct {
	From string `json:"from"`
	To   string `json:"to"`
}

// LinkEdit is one rewritten reference. Old and New are the path text only;
// labels, anchors and brackets are untouched.
type LinkEdit struct {
	Line int    `json:"line"`
	Old  string `json:"old"`
	New  string `json:"new"`
}

// FileEdit lists the references rewritten in one page. Path is where the
// page lives after the refactor; From is set when the page moves.
type FileEdit struct {
	Path  string     `json:"path"`
	From  string     `json:"from,omitempty"`
	Links []LinkEdit `json:"links"`
}

// StateEdit summarizes the changes to one personal-state file.
type StateEdit struct {
	File      string   `json:"file"`
	Changes   int      `json:"changes"`
	Conflicts []string `json:"conflicts,omitempty"`
}

// Stats counts what the plan looked at.
type Stats struct {
	Pages     int `json:"pages"`
	Links     int `json:"links"`
	Rewritten int `json:"rewritten"`
	// Unresolved counts references that already pointed nowhere. They are
	// left exactly as written.
	Unresolved int `json:"unresolved"`
}

// Plan is a complete, unapplied restructuring. Errors non-empty means the
// plan must not be applied; Ops is then empty.
type Plan struct {
	Digest      string       `json:"digest"`
	Moves       []PathChange `json:"moves"`
	Merges      []PathChange `json:"merges"`
	Edits       []FileEdit   `json:"edits"`
	Comments    []PathChange `json:"comments,omitempty"`
	State       []StateEdit  `json:"state,omitempty"`
	RemovedDirs []string     `json:"removed_dirs,omitempty"`
	Errors      []string     `json:"errors,omitempty"`
	// Conflicts explains, by code, the destinations that cannot be used.
	// Each one is also in Errors.
	Conflicts []Conflict `json:"conflicts,omitempty"`
	// Warnings do not block the plan but deserve a look before applying.
	Warnings []string `json:"warnings,omitempty"`
	Stats    Stats    `json:"stats"`

	Ops Ops `json:"-"`
}

// Ops is everything applying the plan does, fully materialized.
type Ops struct {
	// Writes are pages and assets written through storage, so they are
	// committed and reindexed. Source is the path read at plan time (the old
	// path for a move) and SourceETag its content hash then; apply refuses to
	// run if that file changed since.
	Writes []FileWrite
	// Deletes are pages and assets removed through storage.
	Deletes []FileDelete
	// Side are comment and personal-state files, relative to Root. They are
	// not pages: no commit, no index.
	Side []SideWrite
	// Dirs are folders to remove after the moves, deepest first.
	Dirs []string
}

type FileWrite struct {
	Path       string
	Content    []byte
	Source     string
	SourceETag string
}

type FileDelete struct {
	Path string
	ETag string
}

type SideWrite struct {
	Path    string
	Content []byte
	Delete  bool
}

// ETag is the git blob hash of content. It matches pipeline.ETag, which is
// what apply compares against.
func ETag(content []byte) string {
	h := sha1.New()
	fmt.Fprintf(h, "blob %d\x00", len(content))
	h.Write(content)
	return fmt.Sprintf("%x", h.Sum(nil))
}

// Options adjust how a plan is built. The zero value is what every caller
// that restructures content wants.
type Options struct {
	// LeaveLinks moves files without respelling any reference to them. It
	// exists for the legacy rename endpoints' update_links=false; the plan
	// still carries ETags, side-file migration and a single commit.
	LeaveLinks bool
	// Actor is who will apply the plan. Claims held by anyone else block
	// moving or merging the claimed page and warn when only its links change.
	Actor string
	// Claims maps a page path to the actor holding an active claim on it.
	Claims map[string]string
}

type planner struct {
	ws      Workspace
	opts    Options
	plan    *Plan
	files   []string
	exists  map[string]bool
	moved   map[string]string // old path → new path
	merged  map[string]string // merged-away path → the page it went into, after moves
	pre     *links.PathIndex
	post    *links.PathIndex
	content map[string][]byte
}

func (p *planner) errorf(format string, args ...any) {
	p.plan.Errors = append(p.plan.Errors, fmt.Sprintf(format, args...))
}

// final is where a page's references should point after the refactor.
func (p *planner) final(path string) string {
	if to, ok := p.moved[path]; ok {
		return to
	}
	if to, ok := p.merged[path]; ok {
		return to
	}
	return path
}

// BuildPlan computes the restructuring m describes, without writing.
func BuildPlan(ctx context.Context, ws Workspace, m *Manifest) (*Plan, error) {
	return BuildPlanWith(ctx, ws, m, Options{})
}

// BuildPlanWith is BuildPlan with options.
func BuildPlanWith(ctx context.Context, ws Workspace, m *Manifest, opts Options) (*Plan, error) {
	files, err := listFiles(ctx, ws.Store)
	if err != nil {
		return nil, err
	}
	p := &planner{
		ws:      ws,
		opts:    opts,
		plan:    &Plan{Moves: []PathChange{}, Merges: []PathChange{}, Edits: []FileEdit{}},
		files:   files,
		exists:  make(map[string]bool, len(files)),
		moved:   map[string]string{},
		merged:  map[string]string{},
		content: map[string][]byte{},
	}
	for _, f := range files {
		p.exists[f] = true
	}

	p.expandMoves(m.Moves)
	p.expandMerges(m.Merges)
	postFiles := p.checkDestinations()
	p.checkClaims()
	if len(p.plan.Errors) > 0 {
		return p.plan, nil
	}

	p.pre = links.BuildPathIndex(files)
	p.post = links.BuildPathIndex(postFiles)
	if err := p.rewritePages(ctx); err != nil {
		return nil, err
	}
	if len(p.plan.Errors) > 0 {
		p.plan.Ops = Ops{}
		return p.plan, nil
	}
	p.dropOverwrittenDeletes()
	if err := p.migrateSideFiles(); err != nil {
		return nil, err
	}
	if m.DeleteEmptyDirs {
		p.planEmptyDirs(postFiles)
	}
	p.warnClaimedEdits()
	if len(p.plan.Errors) > 0 {
		p.plan.Ops = Ops{}
		return p.plan, nil
	}
	p.plan.Digest = p.digest()
	return p.plan, nil
}

// listFiles returns every non-hidden file in the workspace, sorted.
func listFiles(ctx context.Context, store storage.Storage) ([]string, error) {
	var out []string
	err := storage.WalkAll(ctx, store, "/", func(e storage.Entry) error {
		out = append(out, strings.TrimPrefix(e.Path, "/"))
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("list workspace: %w", err)
	}
	sort.Strings(out)
	return out, nil
}

func joinDir(dir, rest string) string {
	if dir == "" {
		return rest
	}
	return dir + "/" + rest
}

func (p *planner) addMove(from, to string) {
	if from == to {
		return
	}
	if prev, ok := p.moved[from]; ok && prev != to {
		p.errorf("%s is moved twice (to %s and %s)", from, prev, to)
		return
	}
	p.moved[from] = to
}

func (p *planner) expandMoves(moves []Move) {
	for _, mv := range moves {
		if mv.FromRegex != "" {
			if mv.From != "" {
				p.errorf("move %q: give from or from_regex, not both", mv.From)
				continue
			}
			p.expandRegexMove(mv)
			continue
		}
		from, _, err := cleanPath(mv.From)
		if err != nil || from == "" {
			p.errorf("move from %q: invalid path", mv.From)
			continue
		}
		to, toDir, err := cleanPath(mv.To)
		if err != nil {
			p.errorf("move to %q: %v", mv.To, err)
			continue
		}
		switch {
		case strings.ContainsAny(from, "*?[{"):
			if !toDir {
				p.errorf("move %s: a glob needs a destination folder ending in /", from)
				continue
			}
			if !doublestar.ValidatePattern(from) {
				p.errorf("move %s: invalid glob", from)
				continue
			}
			// Each match keeps its path below the glob's fixed prefix, so
			// notes/**/*.md → archive/ keeps subfolders instead of
			// flattening them into collisions.
			base, _ := doublestar.SplitPattern(from)
			if base == "." {
				base = ""
			}
			n := 0
			for _, f := range p.files {
				if ok, _ := doublestar.Match(from, f); ok {
					rel := f
					if base != "" {
						rel = strings.TrimPrefix(f, base+"/")
					}
					p.addMove(f, joinDir(to, rel))
					n++
				}
			}
			if n == 0 {
				p.errorf("move %s: no file matches", from)
			}
		case p.exists[from]:
			dest := to
			if toDir || to == "" {
				dest = joinDir(to, path.Base(from))
			}
			p.addMove(from, dest)
		default:
			p.checkFolderMove(from, to)
			prefix := from + "/"
			n := 0
			for _, f := range p.files {
				if strings.HasPrefix(f, prefix) {
					p.addMove(f, joinDir(to, strings.TrimPrefix(f, prefix)))
					n++
				}
			}
			if n == 0 {
				p.errorf("move %s: no such file or folder", from)
			}
		}
	}
}

// regexMaxLen bounds a from_regex. Go's RE2 engine is linear-time, so the
// limit only keeps manifests readable and compile cost trivial.
const regexMaxLen = 1024

func (p *planner) expandRegexMove(mv Move) {
	if len(mv.FromRegex) > regexMaxLen {
		p.errorf("move from_regex: longer than %d bytes", regexMaxLen)
		return
	}
	re, err := regexp.Compile(`^(?:` + mv.FromRegex + `)$`)
	if err != nil {
		p.errorf("move from_regex %q: %v", mv.FromRegex, err)
		return
	}
	n := 0
	for _, f := range p.files {
		m := re.FindStringSubmatchIndex(f)
		if m == nil {
			continue
		}
		n++
		expanded := string(re.ExpandString(nil, mv.To, f, m))
		to, toDir, err := cleanPath(expanded)
		if err != nil {
			p.errorf("move %s: destination %q: %v", f, expanded, err)
			continue
		}
		if toDir || to == "" {
			to = joinDir(to, path.Base(f))
		}
		p.addMove(f, to)
	}
	if n == 0 {
		p.errorf("move from_regex %q: no file matches", mv.FromRegex)
	}
}

func (p *planner) expandMerges(merges []Merge) {
	for _, mg := range merges {
		from, _, err := cleanPath(mg.From)
		if err != nil || from == "" || !p.exists[from] {
			p.errorf("merge from %q: no such file", mg.From)
			continue
		}
		into, _, err := cleanPath(mg.Into)
		if err != nil || into == "" {
			p.errorf("merge into %q: invalid path", mg.Into)
			continue
		}
		if _, ok := p.moved[from]; ok {
			p.errorf("%s is both moved and merged", from)
			continue
		}
		if to, ok := p.moved[into]; ok {
			into = to
		}
		if into == from {
			p.errorf("%s is merged into itself", from)
			continue
		}
		p.merged[from] = into
	}
}

func isMarkdown(p string) bool {
	return strings.HasSuffix(strings.ToLower(p), ".md")
}

func dirOf(p string) string {
	if i := strings.LastIndex(p, "/"); i >= 0 {
		return p[:i]
	}
	return ""
}

func cleanRel(p string) string {
	var out []string
	for _, seg := range strings.Split(p, "/") {
		switch seg {
		case "", ".":
		case "..":
			if len(out) > 0 {
				out = out[:len(out)-1]
			}
		default:
			out = append(out, seg)
		}
	}
	return strings.Join(out, "/")
}

// relPath spells target relative to the folder fromDir.
func relPath(fromDir, target string) string {
	var fp []string
	if fromDir != "" {
		fp = strings.Split(fromDir, "/")
	}
	tp := strings.Split(target, "/")
	i := 0
	for i < len(fp) && i < len(tp)-1 && fp[i] == tp[i] {
		i++
	}
	parts := make([]string, 0, len(fp)-i+len(tp)-i)
	for j := i; j < len(fp); j++ {
		parts = append(parts, "..")
	}
	parts = append(parts, tp[i:]...)
	return strings.Join(parts, "/")
}

// resolve finds the file a reference points to, the way the reader does.
func resolve(idx *links.PathIndex, kind linkKind, ref, from string) string {
	p, _ := resolveFirm(idx, kind, ref, from)
	return p
}

// resolveFirm is resolve plus whether the match is firm (see
// links.PathIndex.ResolveLinkFirm). Markdown links name a path outright, so
// they are always firm.
func resolveFirm(idx *links.PathIndex, kind linkKind, ref, from string) (string, bool) {
	if kind == kindWiki {
		return idx.ResolveLinkFirm(ref, from)
	}
	p := resolveMarkdown(idx, ref, from)
	return p, p != ""
}

func resolveMarkdown(idx *links.PathIndex, ref, from string) string {
	p := decodeHref(ref)
	switch {
	case strings.HasPrefix(p, "/page/"):
		return idx.LookupExact(strings.TrimPrefix(p, "/page/"))
	case strings.HasPrefix(p, "/"):
		return idx.LookupExact(strings.TrimLeft(p, "/"))
	default:
		return idx.LookupExact(cleanRel(joinDir(dirOf(from), p)))
	}
}

func trimMD(p string) string {
	if isMarkdown(p) {
		return p[:len(p)-3]
	}
	return p
}

// respell writes a reference to target in the same style as the original,
// as short as the original was, falling back to the full path.
func (p *planner) respell(r linkRef, oldTarget, target, from string) (string, bool) {
	ok := func(c string) bool { return resolve(p.post, r.Kind, c, from) == target }
	orig := r.Path

	if r.Kind == kindMarkdown {
		dec := decodeHref(orig)
		var c string
		switch {
		case strings.HasPrefix(dec, "/page/"):
			c = "/page/" + target
		case strings.HasPrefix(dec, "/"):
			c = "/" + target
		default:
			c = relPath(dirOf(from), target)
			if strings.HasPrefix(dec, "./") && !strings.HasPrefix(c, "../") {
				c = "./" + c
			}
		}
		c = encodeHref(c)
		return c, ok(c)
	}

	spell := func(c string) string {
		if !isMarkdown(orig) {
			return trimMD(c)
		}
		return c
	}
	switch {
	case strings.HasPrefix(orig, "./") || strings.HasPrefix(orig, "../"):
		c := relPath(dirOf(from), target)
		if !strings.HasPrefix(c, "../") {
			c = "./" + c
		}
		c = spell(c)
		return c, ok(c)
	case strings.HasPrefix(orig, "/"):
		c := "/" + spell(target)
		return c, ok(c)
	}
	// A bare name stays bare while it is unambiguous (or the target sits next
	// to the linking page, which wins every tie); a partial path stays
	// relative to the page's folder while the target is still inside it.
	// Anything else becomes the full path: a bare name that only resolves by
	// tie-break, or a suffix guess like "sorting/x", breaks as soon as
	// another folder gains the same name.
	wasFull := strings.EqualFold(trimMD(orig), trimMD(oldTarget))
	if !wasFull {
		var c string
		if !strings.Contains(orig, "/") {
			if p.post.BasenameMatches(target) == 1 || dirOf(target) == dirOf(from) {
				c = spell(target[strings.LastIndex(target, "/")+1:])
			}
		} else if dir := dirOf(from); dir == "" || strings.HasPrefix(target, dir+"/") {
			c = spell(strings.TrimPrefix(target, dir+"/"))
		}
		if c != "" && ok(c) {
			return c, true
		}
	}
	c := spell(target)
	return c, ok(c)
}

type splice struct {
	start, end int
	text       string
}

func applySplices(content []byte, edits []splice) []byte {
	sort.Slice(edits, func(i, j int) bool { return edits[i].start > edits[j].start })
	out := append([]byte(nil), content...)
	for _, e := range edits {
		out = append(out[:e.start], append([]byte(e.text), out[e.end:]...)...)
	}
	return out
}

func (p *planner) read(ctx context.Context, f string) ([]byte, error) {
	if c, ok := p.content[f]; ok {
		return c, nil
	}
	c, err := p.ws.Store.Read(ctx, f)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", f, err)
	}
	p.content[f] = c
	return c, nil
}

// rewritePages respells every reference whose target moves, plans the page
// writes and deletes, then checks the result: each reference that resolved
// before must resolve to the same page (after moves and merges) afterwards.
func (p *planner) rewritePages(ctx context.Context) error {
	for _, f := range p.files {
		if _, ok := p.merged[f]; ok {
			c, err := p.read(ctx, f)
			if err != nil {
				return err
			}
			p.plan.Ops.Deletes = append(p.plan.Ops.Deletes, FileDelete{Path: f, ETag: ETag(c)})
			continue
		}
		to, moving := p.moved[f]
		if !isMarkdown(f) {
			if moving {
				c, err := p.read(ctx, f)
				if err != nil {
					return err
				}
				p.plan.Ops.Writes = append(p.plan.Ops.Writes, FileWrite{Path: to, Content: c, Source: f, SourceETag: ETag(c)})
				p.plan.Ops.Deletes = append(p.plan.Ops.Deletes, FileDelete{Path: f, ETag: ETag(c)})
			}
			continue
		}

		p.plan.Stats.Pages++
		content, err := p.read(ctx, f)
		if err != nil {
			return err
		}
		if p.opts.LeaveLinks {
			if moving {
				p.plan.Ops.Writes = append(p.plan.Ops.Writes, FileWrite{Path: to, Content: content, Source: f, SourceETag: ETag(content)})
				p.plan.Ops.Deletes = append(p.plan.Ops.Deletes, FileDelete{Path: f, ETag: ETag(content)})
			}
			continue
		}
		from := p.final(f)
		refs := scanAll(content, p.ws.typedFields())
		expected := make([]string, len(refs))
		var edits []splice
		var report []LinkEdit
		for i, r := range refs {
			p.plan.Stats.Links++
			before, wasFirm := resolveFirm(p.pre, r.Kind, r.Path, f)
			if before == "" {
				p.plan.Stats.Unresolved++
				continue
			}
			want := p.final(before)
			expected[i] = want
			// A link that still lands on the right page is left alone, unless
			// it named the page outright before and now only finds it by a
			// suffix or tie-break guess.
			if got, firm := resolveFirm(p.post, r.Kind, r.Path, from); got == want && (firm || !wasFirm) {
				continue
			}
			if r.Unsplicable {
				p.errorf("%s:%d: frontmatter reference %q to %s is written in a YAML style that cannot be rewritten in place; quote it plainly or edit it first", f, r.Line, r.Path, before)
				continue
			}
			text, ok := p.respell(r, before, want, from)
			if !ok {
				p.errorf("%s:%d: no way to write a link to %s from %s", f, r.Line, want, from)
				continue
			}
			edits = append(edits, splice{start: r.Start, end: r.End, text: text})
			report = append(report, LinkEdit{Line: r.Line, Old: r.Path, New: text})
		}
		updated := content
		if len(edits) > 0 {
			updated = applySplices(content, edits)
			p.plan.Stats.Rewritten += len(edits)
		}

		after := scanAll(updated, p.ws.typedFields())
		if len(after) != len(refs) {
			p.errorf("%s: rewriting changed the number of links (%d → %d)", f, len(refs), len(after))
		} else {
			for i, r := range after {
				if expected[i] == "" {
					continue
				}
				if got := resolve(p.post, r.Kind, r.Path, from); got != expected[i] {
					p.errorf("%s:%d: %q would point to %q instead of %q", f, r.Line, r.Path, got, expected[i])
				}
			}
		}

		switch {
		case moving:
			p.plan.Ops.Writes = append(p.plan.Ops.Writes, FileWrite{Path: to, Content: updated, Source: f, SourceETag: ETag(content)})
			p.plan.Ops.Deletes = append(p.plan.Ops.Deletes, FileDelete{Path: f, ETag: ETag(content)})
		case len(edits) > 0:
			p.plan.Ops.Writes = append(p.plan.Ops.Writes, FileWrite{Path: f, Content: updated, Source: f, SourceETag: ETag(content)})
		}
		if len(report) > 0 {
			fe := FileEdit{Path: from, Links: report}
			if moving {
				fe.From = f
			}
			p.plan.Edits = append(p.plan.Edits, fe)
		}
	}
	return nil
}

// dropOverwrittenDeletes removes the delete of a moved-away source that
// another move writes into (a swap, or a chain a→b→c): the write replaces
// it, and deleting it after the writes would destroy the incoming page.
func (p *planner) dropOverwrittenDeletes() {
	written := make(map[string]bool, len(p.plan.Ops.Writes))
	for _, w := range p.plan.Ops.Writes {
		written[w.Path] = true
	}
	kept := p.plan.Ops.Deletes[:0]
	for _, d := range p.plan.Ops.Deletes {
		if !written[d.Path] {
			kept = append(kept, d)
		}
	}
	p.plan.Ops.Deletes = kept
}

// planEmptyDirs removes the folders that held moved or merged files and
// have nothing left in them.
func (p *planner) planEmptyDirs(postFiles []string) {
	occupied := map[string]bool{}
	for _, f := range postFiles {
		for d := dirOf(f); d != ""; d = dirOf(d) {
			occupied[d] = true
		}
	}
	candidates := map[string]bool{}
	for from := range p.moved {
		for d := dirOf(from); d != ""; d = dirOf(d) {
			candidates[d] = true
		}
	}
	for from := range p.merged {
		for d := dirOf(from); d != ""; d = dirOf(d) {
			candidates[d] = true
		}
	}
	var dirs []string
	for d := range candidates {
		if occupied[d] || !p.onlyJunkLeft(d, candidates) {
			continue
		}
		dirs = append(dirs, d)
	}
	sort.Slice(dirs, func(i, j int) bool {
		if a, b := strings.Count(dirs[i], "/"), strings.Count(dirs[j], "/"); a != b {
			return a > b
		}
		return dirs[i] < dirs[j]
	})
	p.plan.RemovedDirs = dirs
	p.plan.Ops.Dirs = dirs
}

// onlyJunkLeft reports whether a folder holds nothing but files the
// workspace never shows (.DS_Store) and folders that are also going away.
// Any other hidden file means someone keeps data there, so the folder stays.
func (p *planner) onlyJunkLeft(d string, going map[string]bool) bool {
	entries, err := os.ReadDir(filepath.Join(p.ws.Root, filepath.FromSlash(d)))
	if err != nil {
		return false
	}
	for _, e := range entries {
		name := e.Name()
		switch {
		case name == ".DS_Store":
		case e.IsDir() && going[d+"/"+name]:
		case !strings.HasPrefix(name, ".") && p.exists[d+"/"+name]:
			// A visible file; occupancy already says whether it stays.
		default:
			return false
		}
	}
	return true
}

// claimedByOther returns who else holds path, or "".
func (p *planner) claimedByOther(path string) string {
	if holder, ok := p.opts.Claims[path]; ok && holder != p.opts.Actor {
		return holder
	}
	return ""
}

// checkClaims refuses to move or merge a page someone else has claimed:
// their next write would land at a path that no longer exists.
func (p *planner) checkClaims() {
	if len(p.opts.Claims) == 0 {
		return
	}
	for _, mv := range p.plan.Moves {
		if who := p.claimedByOther(mv.From); who != "" {
			p.errorf("%s is claimed by %s; release the claim or wait for it to expire", mv.From, who)
		}
	}
	for _, mg := range p.plan.Merges {
		if who := p.claimedByOther(mg.From); who != "" {
			p.errorf("%s is claimed by %s; release the claim or wait for it to expire", mg.From, who)
		}
	}
}

// warnClaimedEdits flags claimed pages whose links the plan rewrites. The
// holder's next If-Match write fails and re-reads, so nothing is lost, but
// they should know.
func (p *planner) warnClaimedEdits() {
	if len(p.opts.Claims) == 0 {
		return
	}
	for _, e := range p.plan.Edits {
		if e.From != "" {
			continue
		}
		if who := p.claimedByOther(e.Path); who != "" {
			p.plan.Warnings = append(p.plan.Warnings, fmt.Sprintf("%s is claimed by %s; its links will change under them", e.Path, who))
		}
	}
}

func (p *planner) digest() string {
	h := sha256.New()
	for _, w := range p.plan.Ops.Writes {
		fmt.Fprintf(h, "W %s %s %s %s\n", w.Path, ETag(w.Content), w.Source, w.SourceETag)
	}
	for _, d := range p.plan.Ops.Deletes {
		fmt.Fprintf(h, "D %s %s\n", d.Path, d.ETag)
	}
	for _, s := range p.plan.Ops.Side {
		fmt.Fprintf(h, "S %s %t %s\n", s.Path, s.Delete, ETag(s.Content))
	}
	for _, d := range p.plan.Ops.Dirs {
		fmt.Fprintf(h, "R %s\n", d)
	}
	return fmt.Sprintf("%x", h.Sum(nil))[:16]
}
