// Package refactor restructures a workspace in one reviewable step: move
// pages and folders, merge pages, and drop the folders that end up empty,
// while every reference to a moved page keeps pointing at it.
//
// A Manifest says what should move. BuildPlan turns it into a Plan without
// touching the disk: the new content of every affected file, the comment
// and personal-state files to migrate, and a check that every link which
// resolved before still resolves to the same page afterwards. Applying the
// plan is the pipeline's job (pipeline.ApplyRefactor), so writes, commits
// and reindexing go through the same path as any other edit.
package refactor

import (
	"bytes"
	"fmt"
	"path"
	"strings"
	"time"

	yaml "go.yaml.in/yaml/v3"
)

// Manifest is the requested restructuring, usually written as YAML:
//
//	moves:
//	  - from: guides/old-name.md          # one file
//	    to:   guides/new-name.md
//	  - from: drafts/                     # a folder and everything in it
//	    to:   archive/drafts/
//	  - from: notes/*-meeting.md          # a glob, into a folder; ** spans
//	    to:   meetings/                   # folders, {a,b} alternates, and
//	                                      # paths below the glob's fixed
//	                                      # prefix (notes/) are kept
//	  - from_regex: ^journal/(\d{4})-(\d{2})-.*\.md$ # every path the regex
//	    to: journal/$1/$2/                # matches; $1, ${name} expand
//	merges:
//	  - from: faq/duplicate.md            # deleted; its links, comments and
//	    into: faq/canonical.md            # state now belong to the target
//	delete_empty_dirs: true
//
// Content edits select pages and change them; selection always sees the
// workspace as it was before this manifest (paths are pre-move paths):
//
//	edits:
//	  - select: {query: 'status = "draft"', glob: 'notes/**'}
//	    set: {status: archived}
//	    unset: [reviewer]
//	    add_tags: [archived]
//	    remove_tags: [wip]
//	    replace: [{find: 'Acme Corp', with: 'Acme'}]
//	rename_tags:
//	  - {from: ml, to: machine-learning}
type Manifest struct {
	Moves           []Move      `json:"moves,omitempty" yaml:"moves"`
	Merges          []Merge     `json:"merges,omitempty" yaml:"merges"`
	DeleteEmptyDirs bool        `json:"delete_empty_dirs,omitempty" yaml:"delete_empty_dirs"`
	Edits           []Edit      `json:"edits,omitempty" yaml:"edits"`
	RenameTags      []TagRename `json:"rename_tags,omitempty" yaml:"rename_tags"`
	// Relinks repair references after a move that happened outside the
	// engine (a WebDAV or NFS rename, an mv in a shell): every reference
	// that meant From, which no longer exists, is respelled to reach To,
	// which does. Folders work too: From/x.md → To/x.md for every file
	// now under To.
	Relinks []Move `json:"relinks,omitempty" yaml:"relinks"`
	// Split breaks pages into a page per heading (see Split).
	Split []Split `json:"split,omitempty" yaml:"split"`
	// Now pins the clock expressions see. A plan records the time it used;
	// pass it back to apply exactly what was reviewed.
	Now *time.Time `json:"now,omitempty" yaml:"now"`
}

// Selector picks pages. Every criterion given narrows the selection; at
// least one is required, so an edit never reaches the whole workspace by
// accident (use glob: "**" to mean that).
type Selector struct {
	// Paths lists pages by their current path.
	Paths []string `json:"paths,omitempty" yaml:"paths"`
	// Glob matches current paths (** spans folders).
	Glob string `json:"glob,omitempty" yaml:"glob"`
	// Query is a DQL query or WHERE expression over frontmatter.
	Query string `json:"query,omitempty" yaml:"query"`
}

// Edit changes every selected page. Operations run in the order listed
// here: set, compute, unset, add_tags, remove_tags, replace; move_to then
// relocates the page. Every expression sees the page as it was before the
// manifest, so one edit's result never feeds another's condition.
type Edit struct {
	Select Selector `json:"select" yaml:"select"`
	// When keeps only the selected pages for which this expression is
	// true, e.g. `year(date) < "2024" and "draft" in tags`.
	When string         `json:"when,omitempty" yaml:"when"`
	Set  map[string]any `json:"set,omitempty" yaml:"set"`
	// Compute sets keys to the value of an expression per page, e.g.
	// {slug: "slug(title)", archived_on: "date(now)"}.
	Compute map[string]string `json:"compute,omitempty" yaml:"compute"`
	// MoveTo is a destination template: literal text with {{expressions}},
	// and {{slug}}, {{year}}, {{month}}, {{day}} as shorthands, e.g.
	// "archive/{{year}}/{{slug}}.md". Ending in "/" keeps the file name.
	MoveTo string `json:"move_to,omitempty" yaml:"move_to"`
	// OnConflict is what a computed destination that is taken does:
	// "error" (default) or suffix("-%d"), which tries name-2.md, name-3.md…
	// in source-path order, so the same workspace always gets the same
	// names.
	OnConflict string    `json:"on_conflict,omitempty" yaml:"on_conflict"`
	Unset      []string  `json:"unset,omitempty" yaml:"unset"`
	AddTags    []string  `json:"add_tags,omitempty" yaml:"add_tags"`
	RemoveTags []string  `json:"remove_tags,omitempty" yaml:"remove_tags"`
	Replace    []Replace `json:"replace,omitempty" yaml:"replace"`
}

// Replace rewrites body text outside frontmatter and code. With Regex,
// Find is an RE2 expression and With may use $1 or ${name}.
type Replace struct {
	Find  string `json:"find" yaml:"find"`
	With  string `json:"with" yaml:"with"`
	Regex bool   `json:"regex,omitempty" yaml:"regex"`
}

// TagRename renames a tag on every page: the frontmatter tags list and
// inline #tags in the body.
type TagRename struct {
	From string `json:"from" yaml:"from"`
	To   string `json:"to" yaml:"to"`
}

// Empty reports whether the manifest asks for nothing.
func (m *Manifest) Empty() bool {
	return len(m.Moves) == 0 && len(m.Merges) == 0 && len(m.Edits) == 0 && len(m.RenameTags) == 0 && len(m.Relinks) == 0 && len(m.Split) == 0
}

// Move relocates a file, a folder, or the files matching a glob. A To that
// ends in "/" names a destination folder that keeps each file's name (for
// a glob, its path below the pattern's fixed prefix).
//
// FromRegex instead selects every path the regular expression matches in
// full and builds each destination from To, where $1 or ${name} expand to
// the captured groups (Dendron's "refactor hierarchy"). A To that expands
// to a folder (ends in "/") keeps the file's name.
type Move struct {
	From      string `json:"from,omitempty" yaml:"from"`
	FromRegex string `json:"from_regex,omitempty" yaml:"from_regex"`
	To        string `json:"to" yaml:"to"`
}

// Merge deletes From and sends everything that pointed at it to Into.
// Combining the two bodies is an editorial decision, so Into's content is
// left as it is: write the merged page first, then run the merge. Into may
// name a page by its current path or by the path a move in the same
// manifest gives it.
type Merge struct {
	From string `json:"from" yaml:"from"`
	Into string `json:"into" yaml:"into"`
}

// ParseManifest reads a manifest from YAML or JSON. Unknown keys are an
// error, so a typo cannot silently drop part of a restructuring.
func ParseManifest(data []byte) (*Manifest, error) {
	dec := yaml.NewDecoder(bytes.NewReader(data))
	dec.KnownFields(true)
	var m Manifest
	if err := dec.Decode(&m); err != nil {
		return nil, fmt.Errorf("parse manifest: %w", err)
	}
	if m.Empty() {
		return nil, fmt.Errorf("manifest has no moves, merges, edits, tag renames, relinks or splits")
	}
	return &m, nil
}

// cleanPath normalizes a workspace-relative path from a manifest. dir keeps
// a trailing slash, which marks a destination folder.
func cleanPath(p string) (clean string, dir bool, err error) {
	raw := strings.TrimSpace(p)
	if raw == "" {
		return "", false, fmt.Errorf("empty path")
	}
	dir = strings.HasSuffix(raw, "/")
	raw = strings.TrimLeft(raw, "/")
	for _, seg := range strings.Split(strings.TrimSuffix(raw, "/"), "/") {
		if seg == ".." {
			return "", false, fmt.Errorf("%q leaves the workspace", p)
		}
		if strings.HasPrefix(seg, ".") && seg != "." {
			return "", false, fmt.Errorf("%q is inside a hidden folder", p)
		}
	}
	clean = path.Clean(raw)
	if clean == "." {
		return "", dir, nil
	}
	return clean, dir, nil
}
