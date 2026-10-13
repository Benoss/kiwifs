package docexport

import (
	"archive/zip"
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/kiwifs/kiwifs/internal/markdown"
	"github.com/kiwifs/kiwifs/internal/storage"
	yaml "go.yaml.in/yaml/v3"
)

// SiteExporter generates a static documentation site using MkDocs.
type SiteExporter struct {
	provider FileProvider
	store    storage.Storage
	root     string
}

// NewSiteExporter creates a site exporter backed by the given file provider.
func NewSiteExporter(provider FileProvider, store storage.Storage, root string) *SiteExporter {
	return &SiteExporter{provider: provider, store: store, root: root}
}

// Formats returns the formats this exporter handles.
func (e *SiteExporter) Formats() []Format { return []Format{FormatSite} }

// Export generates a static site via MkDocs and returns it as a zip archive.
func (e *SiteExporter) Export(ctx context.Context, opts ExportOpts) (*ExportResult, error) {
	if err := RequireTool("MkDocs", "mkdocs"); err != nil {
		return nil, err
	}

	// Create temp working directory.
	tmpDir, err := os.MkdirTemp("", "kiwi-site-*")
	if err != nil {
		return nil, fmt.Errorf("create temp dir: %w", err)
	}
	defer os.RemoveAll(tmpDir)

	docsDir := filepath.Join(tmpDir, "docs")
	if err := os.MkdirAll(docsDir, 0755); err != nil {
		return nil, fmt.Errorf("create docs dir: %w", err)
	}

	// Walk the knowledge base and copy markdown files.
	inputDir := opts.InputPath
	if inputDir == "" {
		inputDir = "/"
	}

	nav, err := e.copyDocsTree(ctx, inputDir, docsDir)
	if err != nil {
		return nil, fmt.Errorf("copy docs: %w", err)
	}

	// Generate mkdocs.yml.
	mkdocsYml, err := e.generateMkdocsConfig(opts, nav)
	if err != nil {
		return nil, fmt.Errorf("generate mkdocs config: %w", err)
	}

	mkdocsPath := filepath.Join(tmpDir, "mkdocs.yml")
	if err := os.WriteFile(mkdocsPath, mkdocsYml, 0644); err != nil {
		return nil, fmt.Errorf("write mkdocs.yml: %w", err)
	}

	// Run mkdocs build.
	cmd := exec.CommandContext(ctx, "mkdocs", "build", "--site-dir", filepath.Join(tmpDir, "site"))
	cmd.Dir = tmpDir
	cmd.Env = append(os.Environ(), "HOME="+os.TempDir())

	output, err := cmd.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("mkdocs build failed: %w\noutput: %s", err, string(output))
	}

	// Zip the site directory.
	zipData, err := zipDirectory(filepath.Join(tmpDir, "site"))
	if err != nil {
		return nil, fmt.Errorf("zip site: %w", err)
	}

	return &ExportResult{
		Data:        zipData,
		ContentType: "application/zip",
		Filename:    suggestFilename(opts.InputPath, "-site.zip"),
	}, nil
}

// navEntry represents a navigation item in mkdocs.yml.
type navEntry struct {
	Title    string
	Path     string // relative to docs/
	Children []navEntry
	Order    int
}

// copyDocsTree walks the KiwiFS storage, copies markdown files to the
// MkDocs docs/ directory, and builds the navigation tree.
func (e *SiteExporter) copyDocsTree(ctx context.Context, inputDir, docsDir string) ([]navEntry, error) {
	type fileInfo struct {
		path  string // storage path
		rel   string // relative path for docs/
		title string
		order int
	}

	var files []fileInfo

	err := storage.Walk(ctx, e.store, inputDir, func(entry storage.Entry) error {
		if !strings.HasSuffix(strings.ToLower(entry.Path), ".md") {
			return nil
		}
		base := filepath.Base(entry.Path)
		if strings.HasPrefix(base, ".") || strings.Contains(entry.Path, "/.kiwi/") {
			return nil
		}

		content, err := e.store.Read(ctx, entry.Path)
		if err != nil {
			return nil
		}

		// Extract title and order from frontmatter.
		parsed, _ := markdown.Parse(content)
		title := strings.TrimSuffix(base, ".md")
		order := 9999
		if parsed.Frontmatter != nil {
			if t, ok := parsed.Frontmatter["title"].(string); ok && t != "" {
				title = t
			}
			if o := extractOrder(parsed.Frontmatter); o >= 0 {
				order = o
			}
		}

		// Compute relative path.
		rel := entry.Path
		if inputDir != "/" && inputDir != "" {
			rel = strings.TrimPrefix(entry.Path, strings.TrimPrefix(inputDir, "/"))
			rel = strings.TrimPrefix(rel, "/")
		}
		if rel == "" {
			rel = base
		}

		files = append(files, fileInfo{
			path:  entry.Path,
			rel:   rel,
			title: title,
			order: order,
		})

		// Copy file to docs directory.
		destPath := filepath.Join(docsDir, rel)
		destDir := filepath.Dir(destPath)
		if err := os.MkdirAll(destDir, 0755); err != nil {
			return fmt.Errorf("mkdir %s: %w", destDir, err)
		}

		// Strip frontmatter type/order fields that MkDocs doesn't understand,
		// but keep title for MkDocs's use.
		if err := os.WriteFile(destPath, RewriteWidgetFences(content), 0644); err != nil {
			return fmt.Errorf("write %s: %w", destPath, err)
		}

		return nil
	})

	if err != nil {
		return nil, err
	}

	// Build flat navigation sorted by order then name.
	nav := make([]navEntry, len(files))
	for i, f := range files {
		nav[i] = navEntry{
			Title: f.title,
			Path:  f.rel,
			Order: f.order,
		}
	}

	sortNavEntries(nav)
	return nav, nil
}

func sortNavEntries(entries []navEntry) {
	for i := 0; i < len(entries); i++ {
		for j := i + 1; j < len(entries); j++ {
			if entries[j].Order < entries[i].Order ||
				(entries[j].Order == entries[i].Order && entries[j].Title < entries[i].Title) {
				entries[i], entries[j] = entries[j], entries[i]
			}
		}
	}
}

func extractOrder(fm map[string]any) int {
	for _, key := range []string{"nav_order", "order"} {
		if v, ok := fm[key]; ok {
			switch n := v.(type) {
			case int:
				return n
			case float64:
				return int(n)
			}
		}
	}
	return -1
}

// generateMkdocsConfig creates a mkdocs.yml configuration file.
func (e *SiteExporter) generateMkdocsConfig(opts ExportOpts, nav []navEntry) ([]byte, error) {
	siteName := opts.SiteName
	if siteName == "" {
		siteName = "Knowledge Base"
	}

	config := map[string]any{
		"site_name": siteName,
		"theme": map[string]any{
			"name":    "material",
			"palette": map[string]string{"scheme": "default"},
			"features": []string{
				"navigation.tabs",
				"navigation.sections",
				"navigation.expand",
				"search.suggest",
				"search.highlight",
				"content.code.copy",
			},
		},
		"plugins": []string{"search"},
		"markdown_extensions": []string{
			"tables",
			"fenced_code",
			"footnotes",
			"attr_list",
			"def_list",
			"admonition",
			"toc",
		},
	}

	if opts.SiteURL != "" {
		config["site_url"] = opts.SiteURL
	}
	if opts.RepoURL != "" {
		config["repo_url"] = opts.RepoURL
	}

	// Build navigation structure.
	if len(nav) > 0 {
		navYaml := make([]map[string]string, len(nav))
		for i, n := range nav {
			navYaml[i] = map[string]string{n.Title: n.Path}
		}
		config["nav"] = navYaml
	}

	// Apply theme selection.
	switch opts.Theme {
	case "dark":
		config["theme"].(map[string]any)["palette"] = map[string]string{"scheme": "slate"}
	case "minimal":
		config["theme"].(map[string]any)["palette"] = map[string]string{"scheme": "default"}
		config["theme"].(map[string]any)["features"] = []string{}
	}

	data, err := yaml.Marshal(config)
	if err != nil {
		return nil, fmt.Errorf("marshal mkdocs config: %w", err)
	}
	return data, nil
}

// zipDirectory creates a zip archive of the given directory.
func zipDirectory(dir string) ([]byte, error) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)

	err := filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			return nil
		}

		rel, err := filepath.Rel(dir, path)
		if err != nil {
			return err
		}

		header, err := zip.FileInfoHeader(info)
		if err != nil {
			return err
		}
		header.Name = rel
		header.Method = zip.Deflate

		w, err := zw.CreateHeader(header)
		if err != nil {
			return err
		}

		f, err := os.Open(path)
		if err != nil {
			return err
		}
		defer f.Close()

		_, err = io.Copy(w, f)
		return err
	})

	if err != nil {
		return nil, err
	}

	if err := zw.Close(); err != nil {
		return nil, err
	}

	return buf.Bytes(), nil
}
