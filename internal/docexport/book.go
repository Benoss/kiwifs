package docexport

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	yaml "go.yaml.in/yaml/v3"
)

// BookManifest describes a multi-file document compilation order.
// It is read from _book.yaml or _index.md frontmatter at a directory root.
type BookManifest struct {
	Title    string   `yaml:"title"`
	Author   string   `yaml:"author"`
	Date     string   `yaml:"date"`
	Lang     string   `yaml:"lang"`
	Parts    []string `yaml:"parts"`    // ordered list of .md files
	Template string   `yaml:"template"` // optional Pandoc/Typst template
	Theme    string   `yaml:"theme"`
}

// LoadManifest looks for a _book.yaml or _book.yml in the given directory.
// absDir is the absolute filesystem path (for reading the file).
// storageDir is the storage-relative path (for resolving part paths that will
// be passed to the FileProvider). If not found, it returns nil (no error) —
// callers fall back to auto-ordering.
func LoadManifest(absDir, storageDir string) (*BookManifest, error) {
	for _, name := range []string{"_book.yaml", "_book.yml"} {
		path := filepath.Join(absDir, name)
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var m BookManifest
		if err := yaml.Unmarshal(data, &m); err != nil {
			return nil, fmt.Errorf("parse %s: %w", name, err)
		}
		// Resolve relative paths in parts list to storage-relative paths.
		for i, p := range m.Parts {
			if !filepath.IsAbs(p) {
				m.Parts[i] = filepath.Join(storageDir, p)
			}
		}
		return &m, nil
	}
	return nil, nil
}

// StitchFiles reads multiple markdown files and concatenates them with
// page break markers between chapters. Returns the combined markdown and
// the merged metadata from the first file (or manifest).
func StitchFiles(ctx context.Context, provider FileProvider, paths []string, manifest *BookManifest) ([]byte, map[string]string, error) {
	if len(paths) == 0 {
		return nil, nil, fmt.Errorf("no files to stitch")
	}

	metadata := make(map[string]string)
	if manifest != nil {
		if manifest.Title != "" {
			metadata["title"] = manifest.Title
		}
		if manifest.Author != "" {
			metadata["author"] = manifest.Author
		}
		if manifest.Date != "" {
			metadata["date"] = manifest.Date
		}
		if manifest.Lang != "" {
			metadata["lang"] = manifest.Lang
		}
	}

	var buf strings.Builder
	for i, p := range paths {
		content, err := provider.ReadFile(ctx, p)
		if err != nil {
			return nil, nil, fmt.Errorf("read %s: %w", p, err)
		}

		body := RewriteWidgetFences(stripFrontmatter(content))

		if i > 0 {
			// Pandoc page break (works for PDF via LaTeX/Typst and HTML).
			buf.WriteString("\n\n\\newpage\n\n")
		}
		buf.Write(body)
		buf.WriteString("\n")
	}

	return []byte(buf.String()), metadata, nil
}

// stripFrontmatter removes YAML frontmatter from markdown content,
// returning only the body. Frontmatter must start at the very beginning
// with exactly three dashes on the first line, followed by a newline.
func stripFrontmatter(content []byte) []byte {
	s := string(content)

	// Must start with exactly "---" followed by a newline (LF or CRLF).
	// Four or more dashes is a thematic break, not frontmatter.
	if !strings.HasPrefix(s, "---") {
		return content
	}
	after := s[3:]
	if len(after) == 0 {
		return content
	}
	if after[0] == '\r' {
		after = after[1:]
	}
	if len(after) == 0 || after[0] != '\n' {
		return content // "----" or "---x" — not frontmatter
	}
	after = after[1:] // skip past the newline

	// Find the closing "---" on its own line. It could be:
	// - At the very start of `after` (empty frontmatter: "---\n---\n")
	// - After a "\n" or "\r\n"
	closerIdx := -1
	if strings.HasPrefix(after, "---") {
		closerIdx = 0
	} else {
		idx := strings.Index(after, "\n---")
		if idx >= 0 {
			closerIdx = idx + 1 // point to the first '-'
		} else {
			idx = strings.Index(after, "\r\n---")
			if idx >= 0 {
				closerIdx = idx + 2
			}
		}
	}

	if closerIdx < 0 {
		return content // no closing delimiter
	}

	// Skip past "---" and any trailing newline.
	body := after[closerIdx+3:]
	if len(body) > 0 {
		if body[0] == '\r' {
			body = body[1:]
		}
		if len(body) > 0 && body[0] == '\n' {
			body = body[1:]
		} else if len(body) > 0 {
			return content // "---x" — not a valid closer
		}
	}

	return []byte(body)
}
