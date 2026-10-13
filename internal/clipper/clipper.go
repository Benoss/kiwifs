package clipper

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	htmltomd "github.com/JohannesKaufmann/html-to-markdown/v2"
	"github.com/go-shiori/go-readability"
	yaml "go.yaml.in/yaml/v3"
)

// ClipRequest holds parameters for clipping a web page.
type ClipRequest struct {
	URL    string
	Title  string   // optional override
	Tags   []string // optional
	Folder string   // target folder, default "clips/"
}

// ClipResult is the result of a successful clip operation.
type ClipResult struct {
	Path    string
	Title   string
	Excerpt string
}

// Clip fetches a URL, extracts article content using go-readability,
// converts to markdown using html-to-markdown, builds frontmatter, and
// returns the constructed page content and target path.
//
// Returns (result, markdownContent, error).
func Clip(ctx context.Context, req ClipRequest, httpClient *http.Client) (ClipResult, string, error) {
	if httpClient == nil {
		httpClient = &http.Client{
			Timeout: 30 * time.Second,
		}
	}

	// Parse and validate URL
	parsedURL, err := url.Parse(req.URL)
	if err != nil {
		return ClipResult{}, "", fmt.Errorf("invalid URL: %w", err)
	}
	if parsedURL.Scheme == "" {
		parsedURL.Scheme = "https"
	}

	// Fetch the page
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, parsedURL.String(), nil)
	if err != nil {
		return ClipResult{}, "", fmt.Errorf("create request: %w", err)
	}
	httpReq.Header.Set("User-Agent", "KiwiFS-Clipper/1.0")

	resp, err := httpClient.Do(httpReq)
	if err != nil {
		return ClipResult{}, "", fmt.Errorf("fetch URL: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return ClipResult{}, "", fmt.Errorf("HTTP %d: %s", resp.StatusCode, resp.Status)
	}

	// Extract article content using readability
	article, err := readability.FromReader(resp.Body, parsedURL)
	if err != nil {
		return ClipResult{}, "", fmt.Errorf("extract article: %w", err)
	}

	// Use provided title or fall back to extracted title
	title := req.Title
	if title == "" {
		title = article.Title
	}
	if title == "" {
		title = "Untitled Clip"
	}

	// Convert HTML to markdown
	markdownBody, err := htmltomd.ConvertString(article.Content)
	if err != nil {
		return ClipResult{}, "", fmt.Errorf("convert to markdown: %w", err)
	}

	// Build frontmatter
	frontmatter := map[string]any{
		"title":      title,
		"source_url": req.URL,
		"clipped_at": time.Now().Format(time.RFC3339),
	}
	if article.Byline != "" {
		frontmatter["author"] = article.Byline
	}
	if len(req.Tags) > 0 {
		frontmatter["tags"] = req.Tags
	}

	// Serialize frontmatter to YAML
	yamlBytes, err := yaml.Marshal(frontmatter)
	if err != nil {
		return ClipResult{}, "", fmt.Errorf("marshal frontmatter: %w", err)
	}

	// Construct full markdown content
	var content strings.Builder
	content.WriteString("---\n")
	content.Write(yamlBytes)
	content.WriteString("---\n\n")
	content.WriteString(markdownBody)

	// Generate target path
	folder := req.Folder
	if folder == "" {
		folder = "clips/"
	}
	// Ensure folder ends with /
	if !strings.HasSuffix(folder, "/") {
		folder += "/"
	}

	filename := slugify(title) + ".md"
	path := folder + filename

	// Extract excerpt
	excerpt := article.Excerpt
	if excerpt == "" && article.TextContent != "" {
		// Generate excerpt from text content (first 200 chars)
		excerpt = article.TextContent
		if len(excerpt) > 200 {
			excerpt = excerpt[:200] + "..."
		}
	}

	result := ClipResult{
		Path:    path,
		Title:   title,
		Excerpt: excerpt,
	}

	return result, content.String(), nil
}

// slugify converts a title to a URL-safe filename slug.
func slugify(s string) string {
	// Convert to lowercase
	s = strings.ToLower(s)

	// Replace non-alphanumeric characters with hyphens
	reg := regexp.MustCompile(`[^a-z0-9]+`)
	s = reg.ReplaceAllString(s, "-")

	// Remove leading/trailing hyphens
	s = strings.Trim(s, "-")

	// Limit length
	if len(s) > 100 {
		s = s[:100]
	}

	if s == "" {
		s = "untitled"
	}

	return s
}
