package refactor

import (
	"fmt"
	"sort"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/cases"
	"golang.org/x/text/unicode/norm"
)

// ConflictCode is the closed vocabulary of reasons a destination cannot be
// used, after f2's conflict detection. A plan with any conflict has errors
// and cannot be applied; nothing is renamed automatically unless the
// manifest opts in.
type ConflictCode string

const (
	// ConflictExists: the destination is an existing file that stays.
	ConflictExists ConflictCode = "exists"
	// ConflictManyToOne: two sources resolve to the same destination.
	ConflictManyToOne ConflictCode = "many_to_one"
	// ConflictCaseOrNormalization: the destination differs from another
	// path only by letter case or Unicode normalization, which is the same
	// file on macOS (APFS) and Windows and two files elsewhere.
	ConflictCaseOrNormalization ConflictCode = "case_or_normalization"
	// ConflictForbiddenChars: a control character, NUL, backslash or
	// invalid UTF-8 in the destination.
	ConflictForbiddenChars ConflictCode = "forbidden_chars"
	// ConflictTooLong: a path segment longer than 255 bytes.
	ConflictTooLong ConflictCode = "too_long"
	// ConflictTrailingDotOrSpace: a segment ending in "." or " ", which
	// Windows and SMB shares silently strip.
	ConflictTrailingDotOrSpace ConflictCode = "trailing_dot_or_space"
	// ConflictEmptyName: an empty segment or a bare extension (".md").
	ConflictEmptyName ConflictCode = "empty_name"
	// ConflictDirCycle: a folder moved inside itself.
	ConflictDirCycle ConflictCode = "dir_cycle"
	// ConflictParentIsFile: a parent folder of the destination is a file.
	ConflictParentIsFile ConflictCode = "parent_is_file"
	// ConflictIsFolder: the destination is an existing folder.
	ConflictIsFolder ConflictCode = "is_folder"
)

// Conflict is one blocked destination.
type Conflict struct {
	Code ConflictCode `json:"code"`
	// Path is the destination; From the source that wanted it.
	Path string `json:"path"`
	From string `json:"from,omitempty"`
	// With is the other path involved, when there is one.
	With   string `json:"with,omitempty"`
	Detail string `json:"detail"`
}

var folder = cases.Fold()

// FoldKey is the identity a path has on the most forgiving filesystem
// KiwiFS runs on: Unicode NFC and full case folding. Two paths with the
// same key must never coexist.
func FoldKey(p string) string {
	return folder.String(norm.NFC.String(p))
}

// nameProblems checks one destination path for names that are invalid or
// non-portable, independent of what else exists.
func nameProblems(to string) []Conflict {
	var out []Conflict
	add := func(code ConflictCode, detail string) {
		out = append(out, Conflict{Code: code, Path: to, Detail: detail})
	}
	if !utf8.ValidString(to) {
		add(ConflictForbiddenChars, "not valid UTF-8")
		return out
	}
	for _, r := range to {
		if r == 0 || r < 0x20 || r == 0x7f || r == '\\' {
			add(ConflictForbiddenChars, fmt.Sprintf("contains %U", r))
			return out
		}
	}
	for _, seg := range strings.Split(to, "/") {
		switch {
		case seg == "" || seg == "." || strings.EqualFold(seg, ".md"):
			add(ConflictEmptyName, fmt.Sprintf("empty name in %q", to))
		case len(seg) > 255:
			add(ConflictTooLong, fmt.Sprintf("segment is %d bytes (max 255)", len(seg)))
		case strings.HasSuffix(seg, ".") || strings.HasSuffix(seg, " "):
			add(ConflictTrailingDotOrSpace, fmt.Sprintf("%q ends in a dot or space", seg))
		}
	}
	return out
}

// checkDestinations builds the file list after the refactor and records a
// conflict for every destination that cannot be used.
func (p *planner) checkDestinations() []string {
	post := map[string]string{} // path → why it exists
	for _, f := range p.files {
		if _, ok := p.moved[f]; ok {
			continue
		}
		if _, ok := p.merged[f]; ok {
			continue
		}
		post[f] = ""
	}
	froms := make([]string, 0, len(p.moved))
	for from := range p.moved {
		froms = append(froms, from)
	}
	sort.Strings(froms)

	conflict := func(c Conflict) {
		p.plan.Conflicts = append(p.plan.Conflicts, c)
		msg := fmt.Sprintf("%s: %s", c.Code, c.Detail)
		if c.From != "" {
			msg = fmt.Sprintf("%s cannot move to %s: %s", c.From, c.Path, msg)
		}
		p.errorf("%s", msg)
	}

	for _, from := range froms {
		to := p.moved[from]
		for _, c := range nameProblems(to) {
			c.From = from
			conflict(c)
		}
		if why, ok := post[to]; ok {
			if why == "" {
				conflict(Conflict{Code: ConflictExists, Path: to, From: from, With: to, Detail: "destination is an existing file"})
			} else {
				conflict(Conflict{Code: ConflictManyToOne, Path: to, From: from, With: why, Detail: "also the destination of " + why})
			}
			continue
		}
		post[to] = from
	}

	out := make([]string, 0, len(post))
	for f := range post {
		out = append(out, f)
	}
	sort.Strings(out)

	byKey := map[string]string{}
	dirs := map[string]bool{}
	for _, f := range out {
		k := FoldKey(f)
		if other, ok := byKey[k]; ok {
			c := Conflict{Code: ConflictCaseOrNormalization, Path: f, With: other,
				Detail: fmt.Sprintf("%s and %s differ only by case or Unicode normalization", other, f)}
			if src := post[f]; src != "" {
				c.From = src
			} else if src := post[other]; src != "" {
				c.Path, c.With, c.From = other, f, src
			}
			conflict(c)
		}
		byKey[k] = f
		for d := dirOf(f); d != ""; d = dirOf(d) {
			dirs[d] = true
		}
	}
	for _, from := range froms {
		to := p.moved[from]
		if dirs[to] {
			conflict(Conflict{Code: ConflictIsFolder, Path: to, From: from, Detail: "destination is a folder"})
		}
		for d := dirOf(to); d != ""; d = dirOf(d) {
			if _, ok := post[d]; ok {
				conflict(Conflict{Code: ConflictParentIsFile, Path: to, From: from, With: d, Detail: d + " is a file"})
				break
			}
		}
	}

	for from, into := range p.merged {
		if _, ok := post[into]; !ok {
			p.errorf("merge %s into %s: target does not exist after the moves", from, into)
		}
	}
	for _, from := range froms {
		p.plan.Moves = append(p.plan.Moves, PathChange{From: from, To: p.moved[from]})
	}
	mfroms := make([]string, 0, len(p.merged))
	for from := range p.merged {
		mfroms = append(mfroms, from)
	}
	sort.Strings(mfroms)
	for _, from := range mfroms {
		p.plan.Merges = append(p.plan.Merges, PathChange{From: from, To: p.merged[from]})
	}
	return out
}

// checkFolderMove flags a folder moved inside itself (a → a/b): every file
// would land one level deeper under its own old folder, which is never
// what a reorganization means.
func (p *planner) checkFolderMove(from, to string) {
	if to != from && strings.HasPrefix(to+"/", from+"/") {
		c := Conflict{Code: ConflictDirCycle, Path: to, From: from, Detail: "a folder cannot move inside itself"}
		p.plan.Conflicts = append(p.plan.Conflicts, c)
		p.errorf("%s cannot move to %s: %s: %s", from, to, c.Code, c.Detail)
	}
}
