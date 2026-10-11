package docexport

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// SlidesExporter renders markdown to slide decks using Marp CLI.
type SlidesExporter struct {
	provider FileProvider
	root     string
}

// NewSlidesExporter creates a slides exporter backed by the given file provider.
func NewSlidesExporter(provider FileProvider, root string) *SlidesExporter {
	return &SlidesExporter{provider: provider, root: root}
}

// Formats returns the formats this exporter handles.
func (e *SlidesExporter) Formats() []Format { return []Format{FormatSlides} }

// Export renders markdown to a slide deck (HTML, PDF, or PPTX) via Marp CLI.
func (e *SlidesExporter) Export(ctx context.Context, opts ExportOpts) (*ExportResult, error) {
	if err := RequireTool("Marp CLI", "marp"); err != nil {
		return nil, err
	}

	// Create temp working directory.
	tmpDir, err := os.MkdirTemp("", "kiwi-slides-*")
	if err != nil {
		return nil, fmt.Errorf("create temp dir: %w", err)
	}
	defer os.RemoveAll(tmpDir)

	// Read input file.
	content, err := e.provider.ReadFile(ctx, opts.InputPath)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", opts.InputPath, err)
	}
	content = RewriteWidgetFences(content)

	// Ensure marp: true is in the frontmatter if not already present.
	content = ensureMarpFrontmatter(content)

	mdPath := filepath.Join(tmpDir, "input.md")
	if err := os.WriteFile(mdPath, content, 0644); err != nil {
		return nil, fmt.Errorf("write input: %w", err)
	}

	// Determine output format.
	slideFormat := opts.SlideFormat
	if slideFormat == "" {
		slideFormat = "html"
	}

	var ext, contentType string
	switch strings.ToLower(slideFormat) {
	case "pdf":
		ext = ".pdf"
		contentType = "application/pdf"
	case "pptx":
		ext = ".pptx"
		contentType = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
	default: // html
		ext = ".html"
		contentType = "text/html; charset=utf-8"
		slideFormat = "html"
	}

	outputPath := filepath.Join(tmpDir, "output"+ext)

	// Build Marp CLI command.
	args := []string{
		mdPath,
		"-o", outputPath,
	}

	// Output format flag.
	switch slideFormat {
	case "pdf":
		args = append(args, "--pdf")
	case "pptx":
		args = append(args, "--pptx")
	default:
		args = append(args, "--html")
	}

	// Theme.
	if opts.Theme != "" && opts.Theme != "default" && opts.Theme != "presentation" {
		// Check if it's a built-in Marp theme.
		switch opts.Theme {
		case "gaia", "uncover":
			args = append(args, "--theme", opts.Theme)
		default:
			// Try as a custom CSS file.
			themeCSS := resolveThemeCSS(opts.Theme)
			if themeCSS != "" {
				args = append(args, "--theme", themeCSS)
			}
		}
	}

	// Allow local file access for images.
	args = append(args, "--allow-local-files")

	// Execute Marp from the input file's directory so relative image paths work.
	marpDir := e.root
	if dir := filepath.Dir(opts.InputPath); dir != "." && dir != "" {
		candidate := filepath.Join(e.root, dir)
		if info, err := os.Stat(candidate); err == nil && info.IsDir() {
			marpDir = candidate
		}
	}
	cmd := exec.CommandContext(ctx, "marp", args...)
	cmd.Dir = marpDir
	cmd.Env = append(os.Environ(), "HOME="+os.TempDir())

	output, err := cmd.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("marp failed: %w\noutput: %s", err, string(output))
	}

	data, err := os.ReadFile(outputPath)
	if err != nil {
		return nil, fmt.Errorf("read output: %w", err)
	}

	return &ExportResult{
		Data:        data,
		ContentType: contentType,
		Filename:    suggestFilename(opts.InputPath, ext),
	}, nil
}

// ensureMarpFrontmatter adds `marp: true` to the frontmatter if it's
// not already present. Marp CLI requires this directive.
func ensureMarpFrontmatter(content []byte) []byte {
	s := string(content)

	// Check for existing frontmatter (exactly "---" + newline at start).
	var hasFM bool
	var fmStart int // index where frontmatter content begins (after opening ---)
	if strings.HasPrefix(s, "---\r\n") {
		hasFM = true
		fmStart = 5
	} else if strings.HasPrefix(s, "---\n") {
		hasFM = true
		fmStart = 4
	}

	if hasFM {
		// Find the closing delimiter.
		rest := s[fmStart:]
		closerIdx := strings.Index(rest, "\n---")
		if closerIdx < 0 {
			closerIdx = strings.Index(rest, "\r\n---")
		}
		if closerIdx >= 0 {
			fm := rest[:closerIdx]
			// Check if any line starts with "marp:" (not just a substring match).
			hasMarp := false
			for _, line := range strings.Split(fm, "\n") {
				line = strings.TrimRight(line, "\r")
				if strings.HasPrefix(strings.TrimSpace(line), "marp:") {
					hasMarp = true
					break
				}
			}
			if hasMarp {
				return content
			}
			// Inject marp: true as the first key in existing frontmatter.
			afterCloser := rest[closerIdx:]
			return []byte("---\nmarp: true\n" + fm + afterCloser)
		}
	}

	// No valid frontmatter — prepend one.
	return []byte("---\nmarp: true\n---\n\n" + s)
}
