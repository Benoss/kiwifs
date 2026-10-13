package refactor

import (
	"fmt"
	"net/url"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	udiff "github.com/aymanbagabas/go-udiff"
)

// The subset of the Language Server Protocol's WorkspaceEdit a plan maps
// to (LSP 3.17, documentChanges form). A plan is exported as one, so an
// editor can show or apply it; and an editor's file renames can come back
// in as a manifest.

type Position struct {
	Line      int `json:"line"`
	Character int `json:"character"` // UTF-16 code units, per LSP
}

type Range struct {
	Start Position `json:"start"`
	End   Position `json:"end"`
}

type TextEdit struct {
	Range        Range  `json:"range"`
	NewText      string `json:"newText"`
	AnnotationID string `json:"annotationId,omitempty"`
}

type VersionedTextDocumentIdentifier struct {
	URI     string `json:"uri"`
	Version *int   `json:"version"`
}

type TextDocumentEdit struct {
	TextDocument VersionedTextDocumentIdentifier `json:"textDocument"`
	Edits        []TextEdit                      `json:"edits"`
}

// DocumentChange is one entry of documentChanges: a TextDocumentEdit, or a
// create/rename/delete file operation (Kind set).
type DocumentChange struct {
	Kind         string                           `json:"kind,omitempty"`
	URI          string                           `json:"uri,omitempty"`
	OldURI       string                           `json:"oldUri,omitempty"`
	NewURI       string                           `json:"newUri,omitempty"`
	Options      *FileOptions                     `json:"options,omitempty"`
	AnnotationID string                           `json:"annotationId,omitempty"`
	TextDocument *VersionedTextDocumentIdentifier `json:"textDocument,omitempty"`
	Edits        []TextEdit                       `json:"edits,omitempty"`
}

type FileOptions struct {
	Overwrite      bool `json:"overwrite,omitempty"`
	IgnoreIfExists bool `json:"ignoreIfExists,omitempty"`
}

type ChangeAnnotation struct {
	Label             string `json:"label"`
	NeedsConfirmation bool   `json:"needsConfirmation,omitempty"`
	Description       string `json:"description,omitempty"`
}

type WorkspaceEdit struct {
	DocumentChanges   []DocumentChange            `json:"documentChanges,omitempty"`
	Changes           map[string][]TextEdit       `json:"changes,omitempty"`
	ChangeAnnotations map[string]ChangeAnnotation `json:"changeAnnotations,omitempty"`
	// KiwiDigest names the plan this edit came from. An editor that applies
	// the edit itself bypasses the plan's ETag checks, journal and single
	// commit; applying through KiwiFS with this digest keeps them.
	KiwiDigest string `json:"kiwiDigest,omitempty"`
}

const annotationID = "kiwi-refactor"

// FileURI spells a workspace path as a file:// URI under root.
func FileURI(root, rel string) string {
	if a, err := filepath.Abs(root); err == nil {
		root = a
	}
	abs := filepath.ToSlash(filepath.Join(root, filepath.FromSlash(rel)))
	if !strings.HasPrefix(abs, "/") {
		abs = "/" + abs // Windows drive paths: file:///C:/...
	}
	return (&url.URL{Scheme: "file", Path: abs}).String()
}

// RelPath turns a file:// URI back into a workspace path, or "" when the
// URI is not under root.
func RelPath(root, uri string) string {
	u, err := url.Parse(uri)
	if err != nil || u.Scheme != "file" {
		return ""
	}
	if a, err := filepath.Abs(root); err == nil {
		root = a
	}
	p := filepath.FromSlash(u.Path)
	if len(p) > 2 && p[0] == '\\' && p[2] == ':' {
		p = p[1:]
	}
	rel, err := filepath.Rel(root, p)
	if err != nil || rel == "." || strings.HasPrefix(rel, "..") {
		return ""
	}
	return filepath.ToSlash(rel)
}

// textEdits is the minimal set of LSP edits turning before into after.
func textEdits(before, after []byte) []TextEdit {
	edits := udiff.Bytes(before, after)
	pos := newPositioner(before)
	out := make([]TextEdit, 0, len(edits))
	for _, e := range edits {
		out = append(out, TextEdit{
			Range:        Range{Start: pos.at(e.Start), End: pos.at(e.End)},
			NewText:      e.New,
			AnnotationID: annotationID,
		})
	}
	return out
}

// positioner converts byte offsets into LSP positions (line, UTF-16 column).
type positioner struct {
	src    []byte
	starts []int
}

func newPositioner(src []byte) *positioner {
	starts := []int{0}
	for i, b := range src {
		if b == '\n' {
			starts = append(starts, i+1)
		}
	}
	return &positioner{src: src, starts: starts}
}

func (p *positioner) at(off int) Position {
	line := sort.Search(len(p.starts), func(i int) bool { return p.starts[i] > off }) - 1
	col := 0
	for i := p.starts[line]; i < off && i < len(p.src); {
		r, size := utf8.DecodeRune(p.src[i:])
		col += len(utf16.Encode([]rune{r}))
		i += size
	}
	return Position{Line: line, Character: col}
}

// WorkspaceEdit renders the plan as LSP documentChanges, in an order an
// editor can apply one after another: renames (each followed by the edits
// of the moved page, against its new URI), creations, edits of pages that
// stay, deletions. Comment and personal-state files are not documents and
// are left out: only applying through KiwiFS migrates them.
func (p *Plan) WorkspaceEdit(root string) WorkspaceEdit {
	we := WorkspaceEdit{
		ChangeAnnotations: map[string]ChangeAnnotation{annotationID: {
			Label:             "KiwiFS restructuring",
			NeedsConfirmation: true,
			Description:       fmt.Sprintf("plan %s: %d moves, %d merges, %d pages relinked", p.Digest, len(p.Moves), len(p.Merges), len(p.Edits)),
		}},
		KiwiDigest: p.Digest,
	}
	var renames, creates, edits []DocumentChange
	for _, w := range p.Ops.Writes {
		uri := FileURI(root, w.Path)
		switch {
		case w.Source != "" && w.Source != w.Path:
			renames = append(renames, DocumentChange{Kind: "rename", OldURI: FileURI(root, w.Source), NewURI: uri, AnnotationID: annotationID})
			if string(w.Prior) != string(w.Content) {
				renames = append(renames, docEdit(uri, w.Prior, w.Content))
			}
		case w.Source == "":
			creates = append(creates, DocumentChange{Kind: "create", URI: uri, AnnotationID: annotationID}, docEdit(uri, nil, w.Content))
		default:
			edits = append(edits, docEdit(uri, w.Prior, w.Content))
		}
	}
	we.DocumentChanges = append(append(renames, creates...), edits...)
	moved := map[string]bool{}
	for _, w := range p.Ops.Writes {
		moved[w.Source] = true
	}
	for _, d := range p.Ops.Deletes {
		if !moved[d.Path] {
			we.DocumentChanges = append(we.DocumentChanges, DocumentChange{Kind: "delete", URI: FileURI(root, d.Path), AnnotationID: annotationID})
		}
	}
	return we
}

// PreRenameEdits is what an editor asks for in workspace/willRenameFiles:
// the text edits to make before it renames the files itself, so every
// document is addressed by its current (old) URI.
func (p *Plan) PreRenameEdits(root string) WorkspaceEdit {
	we := WorkspaceEdit{Changes: map[string][]TextEdit{}, KiwiDigest: p.Digest}
	for _, w := range p.Ops.Writes {
		if w.Source == "" || string(w.Prior) == string(w.Content) {
			continue
		}
		edits := textEdits(w.Prior, w.Content)
		for i := range edits {
			edits[i].AnnotationID = ""
		}
		we.Changes[FileURI(root, w.Source)] = edits
	}
	return we
}

func docEdit(uri string, before, after []byte) DocumentChange {
	return DocumentChange{TextDocument: &VersionedTextDocumentIdentifier{URI: uri}, Edits: textEdits(before, after)}
}

// ManifestFromWorkspaceEdit takes the file renames out of a WorkspaceEdit
// (an editor's rename refactoring, say) as a manifest. Its text edits are
// ignored on purpose: the planner recomputes every link from the files,
// in the files' own styles, and checks them.
func ManifestFromWorkspaceEdit(root string, we WorkspaceEdit) (*Manifest, []string, error) {
	m := &Manifest{}
	var ignored []string
	for _, c := range we.DocumentChanges {
		switch c.Kind {
		case "rename":
			from, to := RelPath(root, c.OldURI), RelPath(root, c.NewURI)
			if from == "" || to == "" {
				return nil, nil, fmt.Errorf("rename %s → %s is outside the workspace", c.OldURI, c.NewURI)
			}
			m.Moves = append(m.Moves, Move{From: from, To: to})
		case "create", "delete":
			ignored = append(ignored, fmt.Sprintf("%s %s: not a move; do it as a write or delete", c.Kind, c.URI))
		case "":
			if c.TextDocument != nil {
				ignored = append(ignored, "text edits to "+c.TextDocument.URI+": links are recomputed by the planner")
			}
		}
	}
	if len(we.Changes) > 0 {
		ignored = append(ignored, "text edits: links are recomputed by the planner")
	}
	if len(m.Moves) == 0 {
		return nil, ignored, fmt.Errorf("the workspace edit renames no files")
	}
	return m, ignored, nil
}

// URIPath is the local path a file:// URI names, or "".
func URIPath(uri string) string {
	u, err := url.Parse(uri)
	if err != nil || u.Scheme != "file" {
		return ""
	}
	p := filepath.FromSlash(u.Path)
	if len(p) > 2 && p[0] == '\\' && p[2] == ':' {
		p = p[1:]
	}
	return p
}
