package docexport

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

// HTMLExporter renders markdown to standalone HTML using Pandoc.
type HTMLExporter struct {
	provider FileProvider
	root     string
}

// NewHTMLExporter creates an HTML exporter backed by the given file provider.
func NewHTMLExporter(provider FileProvider, root string) *HTMLExporter {
	return &HTMLExporter{provider: provider, root: root}
}

// Formats returns the formats this exporter handles.
func (e *HTMLExporter) Formats() []Format { return []Format{FormatHTML} }

// Export renders markdown to standalone HTML via Pandoc.
func (e *HTMLExporter) Export(ctx context.Context, opts ExportOpts) (*ExportResult, error) {
	if err := RequireTool("Pandoc", "pandoc"); err != nil {
		return nil, err
	}

	// Create temp working directory.
	tmpDir, err := os.MkdirTemp("", "kiwi-html-*")
	if err != nil {
		return nil, fmt.Errorf("create temp dir: %w", err)
	}
	defer os.RemoveAll(tmpDir)

	// Prepare input (reuses PDF exporter's logic via shared helper).
	inputPath, metadata, err := prepareInputGeneric(ctx, e.provider, e.root, tmpDir, opts)
	if err != nil {
		return nil, fmt.Errorf("prepare input: %w", err)
	}

	outputPath := filepath.Join(tmpDir, "output.html")

	// Build Pandoc command.
	args := []string{
		inputPath,
		"-o", outputPath,
		"--standalone",
		"--toc",
		"--katex", // client-side math rendering
	}

	// Self-contained: embed all resources into a single file.
	// --embed-resources (Pandoc 2.19+) supersedes the deprecated --self-contained.
	if opts.SelfContained {
		args = append(args, "--embed-resources")
	}

	// Apply theme.
	if tmpl := resolveTemplate(opts.Theme, FormatHTML, ""); tmpl != "" {
		args = append(args, "--template="+tmpl)
	}
	if css := resolveThemeCSS(opts.Theme); css != "" {
		args = append(args, "--css="+css)
	}

	// Metadata.
	args = appendMetadataArgs(args, metadata, opts.Metadata)

	// Bibliography.
	args = appendBibliographyArgs(args, opts, e.root)

	// Cross-references.
	if opts.CrossRef && IsAvailable("pandoc-crossref") {
		args = append(args, "--filter", "pandoc-crossref")
	}

	// Resource path.
	resourcePath := e.root
	if opts.InputPath != "" {
		resourcePath = filepath.Join(e.root, filepath.Dir(opts.InputPath))
	}
	args = append(args, "--resource-path="+resourcePath+":"+e.root)

	// Execute Pandoc.
	cmd := exec.CommandContext(ctx, "pandoc", args...)
	cmd.Dir = tmpDir
	cmd.Env = append(os.Environ(), "HOME="+os.TempDir())

	output, err := cmd.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("pandoc failed: %w\noutput: %s", err, string(output))
	}

	data, err := os.ReadFile(outputPath)
	if err != nil {
		return nil, fmt.Errorf("read output: %w", err)
	}

	return &ExportResult{
		Data:        data,
		ContentType: "text/html; charset=utf-8",
		Filename:    suggestFilename(opts.InputPath, ".html"),
	}, nil
}

// prepareInputGeneric is a shared input preparation function that handles
// both single-file and multi-file inputs. It's used by HTML, and can be
// used by other Pandoc-based exporters.
func prepareInputGeneric(ctx context.Context, provider FileProvider, root, tmpDir string, opts ExportOpts) (string, map[string]string, error) {
	inputPath := opts.InputPath

	// Check if input is a directory.
	absInput := filepath.Join(root, inputPath)
	info, err := os.Stat(absInput)

	if err == nil && info.IsDir() {
		// Multi-file compilation.
		manifest, merr := LoadManifest(absInput, inputPath)
		if merr != nil {
			return "", nil, merr
		}

		var paths []string
		if manifest != nil && len(manifest.Parts) > 0 {
			paths = manifest.Parts
		} else {
			paths, err = provider.ListFiles(ctx, inputPath)
			if err != nil {
				return "", nil, err
			}
		}

		if len(paths) == 0 {
			return "", nil, fmt.Errorf("no markdown files found in %s", inputPath)
		}

		combined, metadata, err := StitchFiles(ctx, provider, paths, manifest)
		if err != nil {
			return "", nil, err
		}

		mdPath := filepath.Join(tmpDir, "input.md")
		if err := os.WriteFile(mdPath, combined, 0644); err != nil {
			return "", nil, fmt.Errorf("write combined: %w", err)
		}
		return mdPath, metadata, nil
	}

	// Single file.
	content, err := provider.ReadFile(ctx, inputPath)
	if err != nil {
		return "", nil, fmt.Errorf("read %s: %w", inputPath, err)
	}

	mdPath := filepath.Join(tmpDir, "input.md")
	if err := os.WriteFile(mdPath, RewriteWidgetFences(content), 0644); err != nil {
		return "", nil, fmt.Errorf("write input: %w", err)
	}

	return mdPath, nil, nil
}
