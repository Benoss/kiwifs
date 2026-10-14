package api

import (
	"errors"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/kiwifs/kiwifs/internal/pipeline"
	"github.com/kiwifs/kiwifs/internal/rbac"
	"github.com/kiwifs/kiwifs/internal/refactor"
	"github.com/kiwifs/kiwifs/internal/storage"
	"github.com/labstack/echo/v4"
)

type publishRequest struct {
	Path string `json:"path"`
}

type publishBulkRequest struct {
	Paths []string `json:"paths"`
}

type publishResponse struct {
	Path        string `json:"path"`
	Published   bool   `json:"published"`
	PublishedAt string `json:"published_at,omitempty"`
	PublicURL   string `json:"public_url,omitempty"`
}

type publishBulkError struct {
	Path  string `json:"path"`
	Error string `json:"error"`
}

type publishBulkResponse struct {
	Published bool               `json:"published"`
	Requested int                `json:"requested"`
	Changed   int                `json:"changed"`
	Skipped   int                `json:"skipped"`
	Paths     []publishResponse  `json:"paths"`
	Errors    []publishBulkError `json:"errors,omitempty"`
}

type publishStatusResponse struct {
	Path        string `json:"path"`
	Published   bool   `json:"published"`
	PublishedAt string `json:"published_at,omitempty"`
	PublicURL   string `json:"public_url,omitempty"`
	ViewCount   int    `json:"view_count"`
}

type publishedPage struct {
	Path        string `json:"path"`
	PublishedAt string `json:"published_at,omitempty"`
	PublicURL   string `json:"public_url"`
}

type publishedPagesResponse struct {
	Count int             `json:"count"`
	Pages []publishedPage `json:"pages"`
}

// Publish godoc
//
//	@Summary		Publish a page
//	@Description	Sets published: true and sets/updates published_at in the page's markdown frontmatter. Writes changes to git repository.
//	@Tags			publish
//	@Security		BearerAuth
//	@Param			X-Actor	header		string			false	"Actor identity performing the operation"
//	@Param			body	body		publishRequest	true	"Page path to publish"
//	@Success		200		{object}	publishResponse
//	@Failure		400		{object}	map[string]string
//	@Failure		404		{object}	map[string]string
//	@Failure		500		{object}	map[string]string
//	@Router			/api/kiwi/publish [post]
func (h *Handlers) Publish(c echo.Context) error {
	var req publishRequest
	if err := bindJSON(c, &req); err != nil {
		return err
	}
	if req.Path == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "path is required")
	}

	ctx := c.Request().Context()
	content, err := readFileOr404(ctx, h.store, req.Path)
	if err != nil {
		return err
	}

	fields := map[string]any{"published": true}
	// published_at is set only once, so republishing keeps the original
	// date.
	now := time.Now().UTC()
	if existingAt := rbac.PagePublishedAt(content); existingAt != nil {
		now = *existingAt
	} else {
		fields["published_at"] = now
	}
	actor := sanitizeActor(c.Request().Header.Get("X-Actor"))
	if _, err := h.pipe.PatchFrontmatter(ctx, req.Path, fields, pipeline.ETag(content), actor); err != nil {
		return publishWriteError(err)
	}

	return c.JSON(http.StatusOK, publishResponse{
		Path:        req.Path,
		Published:   true,
		PublishedAt: now.Format(time.RFC3339),
		PublicURL:   "/p/" + req.Path,
	})
}

// Unpublish godoc
//
//	@Summary		Unpublish a page
//	@Description	Sets published: false in the page's markdown frontmatter. Preserves existing published_at if present. Writes changes to git repository.
//	@Tags			publish
//	@Security		BearerAuth
//	@Param			X-Actor	header		string			false	"Actor identity performing the operation"
//	@Param			body	body		publishRequest	true	"Page path to unpublish"
//	@Success		200		{object}	publishResponse
//	@Failure		400		{object}	map[string]string
//	@Failure		404		{object}	map[string]string
//	@Failure		500		{object}	map[string]string
//	@Router			/api/kiwi/unpublish [post]
func (h *Handlers) Unpublish(c echo.Context) error {
	var req publishRequest
	if err := bindJSON(c, &req); err != nil {
		return err
	}
	if req.Path == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "path is required")
	}

	ctx := c.Request().Context()
	content, err := readFileOr404(ctx, h.store, req.Path)
	if err != nil {
		return err
	}

	actor := sanitizeActor(c.Request().Header.Get("X-Actor"))
	if _, err := h.pipe.PatchFrontmatter(ctx, req.Path, map[string]any{"published": false}, pipeline.ETag(content), actor); err != nil {
		return publishWriteError(err)
	}

	return c.JSON(http.StatusOK, publishResponse{
		Path:      req.Path,
		Published: false,
	})
}

// publishWriteError maps a failed publish write: a page edited between
// the read and the write is a conflict to retry, not a server error.
func publishWriteError(err error) error {
	if errors.Is(err, pipeline.ErrConflict) {
		return echo.NewHTTPError(http.StatusConflict, "page changed while publishing; retry")
	}
	return echo.NewHTTPError(http.StatusInternalServerError, "write failed: "+err.Error())
}

// PublishBulk godoc
//
//	@Summary		Bulk publish pages
//	@Description	Bulk-publishes multiple markdown pages in a single transaction/commit.
//	@Tags			publish
//	@Security		BearerAuth
//	@Param			X-Actor	header		string				false	"Actor identity performing the operation"
//	@Param			body	body		publishBulkRequest	true	"List of page paths to publish"
//	@Success		200		{object}	publishBulkResponse
//	@Failure		400		{object}	map[string]string
//	@Failure		500		{object}	map[string]string
//	@Router			/api/kiwi/publish/bulk [post]
func (h *Handlers) PublishBulk(c echo.Context) error {
	return h.publishBulk(c, true)
}

// UnpublishBulk godoc
//
//	@Summary		Bulk unpublish pages
//	@Description	Bulk-unpublishes multiple markdown pages in a single transaction/commit.
//	@Tags			publish
//	@Security		BearerAuth
//	@Param			X-Actor	header		string				false	"Actor identity performing the operation"
//	@Param			body	body		publishBulkRequest	true	"List of page paths to unpublish"
//	@Success		200		{object}	publishBulkResponse
//	@Failure		400		{object}	map[string]string
//	@Failure		500		{object}	map[string]string
//	@Router			/api/kiwi/unpublish/bulk [post]
func (h *Handlers) UnpublishBulk(c echo.Context) error {
	return h.publishBulk(c, false)
}

func (h *Handlers) publishBulk(c echo.Context, publish bool) error {
	var req publishBulkRequest
	if err := bindJSON(c, &req); err != nil {
		return err
	}
	if len(req.Paths) == 0 {
		return echo.NewHTTPError(http.StatusBadRequest, "paths is required")
	}

	ctx := c.Request().Context()
	actor := sanitizeActor(c.Request().Header.Get("X-Actor"))
	now := time.Now().UTC()
	seen := make(map[string]struct{}, len(req.Paths))
	responses := make([]publishResponse, 0, len(req.Paths))
	errors := make([]publishBulkError, 0)
	// The pages that change, grouped by what changes, become one
	// restructuring manifest: one commit, each file pinned to the bytes
	// it was read with, and frontmatter edited line by line.
	var stamp, republish, unpublish []string

	for _, path := range req.Paths {
		path = strings.TrimPrefix(strings.TrimSpace(path), "/")
		if path == "" {
			return echo.NewHTTPError(http.StatusBadRequest, "paths contains an empty path")
		}
		if _, ok := seen[path]; ok {
			continue
		}
		seen[path] = struct{}{}

		content, err := readFileOr404(ctx, h.store, path)
		if err != nil {
			errors = append(errors, publishBulkError{Path: path, Error: err.Error()})
			continue
		}
		currentlyPublished := rbac.PagePublished(content)
		if publish {
			publishedAt := rbac.PagePublishedAt(content)
			switch {
			case currentlyPublished && publishedAt != nil:
				responses = append(responses, publishResponse{Path: path, Published: true, PublishedAt: publishedAt.Format(time.RFC3339), PublicURL: "/p/" + path})
				continue
			case publishedAt != nil:
				republish = append(republish, path)
				responses = append(responses, publishResponse{Path: path, Published: true, PublishedAt: publishedAt.Format(time.RFC3339), PublicURL: "/p/" + path})
			default:
				stamp = append(stamp, path)
				responses = append(responses, publishResponse{Path: path, Published: true, PublishedAt: now.Format(time.RFC3339), PublicURL: "/p/" + path})
			}
			continue
		}
		if !currentlyPublished {
			responses = append(responses, publishResponse{Path: path, Published: false})
			continue
		}
		unpublish = append(unpublish, path)
		responses = append(responses, publishResponse{Path: path, Published: false})
	}

	m := &refactor.Manifest{}
	addEdit := func(paths []string, set map[string]any) {
		if len(paths) > 0 {
			m.Edits = append(m.Edits, refactor.Edit{Select: refactor.Selector{Paths: paths}, Set: set})
		}
	}
	addEdit(stamp, map[string]any{"published": true, "published_at": now})
	addEdit(republish, map[string]any{"published": true})
	addEdit(unpublish, map[string]any{"published": false})
	changed := len(stamp) + len(republish) + len(unpublish)

	if !m.Empty() {
		_, _, failed, err := h.pipe.RefactorDropping(ctx, m, refactor.Options{Client: requestClient(c)}, actor)
		if err != nil {
			return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
		}
		if len(failed) > 0 {
			for path, msg := range failed {
				errors = append(errors, publishBulkError{Path: path, Error: msg})
			}
			sort.Slice(errors, func(i, j int) bool { return errors[i].Path < errors[j].Path })
			changed -= len(failed)
			// A path is either reported as done or as failed, never both.
			cleaned := responses[:0]
			for _, r := range responses {
				if _, ok := failed[r.Path]; !ok {
					cleaned = append(cleaned, r)
				}
			}
			responses = cleaned
		}
	}

	return c.JSON(http.StatusOK, publishBulkResponse{
		Published: publish,
		Requested: len(req.Paths),
		Changed:   changed,
		Skipped:   len(seen) - changed,
		Paths:     responses,
		Errors:    errors,
	})
}

// PublishStatus godoc
//
//	@Summary		Get publish status of a page
//	@Description	Returns the publishing metadata (is published, published time, public URL, views count) for a specific page.
//	@Tags			publish
//	@Security		BearerAuth
//	@Param			path	query		string	true	"Path of the page to check"
//	@Success		200		{object}	publishStatusResponse
//	@Failure		400		{object}	map[string]string
//	@Failure		404		{object}	map[string]string
//	@Router			/api/kiwi/publish/status [get]
func (h *Handlers) PublishStatus(c echo.Context) error {
	path, err := requirePath(c)
	if err != nil {
		return err
	}

	ctx := c.Request().Context()
	content, err := readFileOr404(ctx, h.store, path)
	if err != nil {
		return err
	}

	published := rbac.PagePublished(content)
	publishedAt := rbac.PagePublishedAt(content)

	resp := publishStatusResponse{
		Path:      path,
		Published: published,
	}

	if publishedAt != nil {
		resp.PublishedAt = publishedAt.Format(time.RFC3339)
	}

	if published {
		resp.PublicURL = "/p/" + path
	}

	// Include view count from metrics store if available.
	if h.publishMetrics != nil {
		if m := h.publishMetrics.Get(path); m != nil {
			resp.ViewCount = m.Views
		}
	}

	return c.JSON(http.StatusOK, resp)
}

// PublishedPages godoc
//
//	@Summary		List all published pages
//	@Description	Lists every page in the workspace that is currently published.
//	@Tags			publish
//	@Security		BearerAuth
//	@Success		200		{object}	publishedPagesResponse
//	@Failure		500		{object}	map[string]string
//	@Router			/api/kiwi/publish/list [get]
func (h *Handlers) PublishedPages(c echo.Context) error {
	ctx := c.Request().Context()
	tree, err := storage.BuildTree(ctx, h.store, "/", maxTreeDepth)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	pages := make([]publishedPage, 0)
	var walk func(entries []*storage.TreeEntry) error
	walk = func(entries []*storage.TreeEntry) error {
		for _, entry := range entries {
			if entry == nil {
				continue
			}
			if entry.IsDir {
				if err := walk(entry.Children); err != nil {
					return err
				}
				continue
			}
			lower := strings.ToLower(entry.Path)
			if !strings.HasSuffix(lower, ".md") && !strings.HasSuffix(lower, ".markdown") {
				continue
			}
			content, err := readFileOr404(ctx, h.store, entry.Path)
			if err != nil {
				return err
			}
			if !rbac.PagePublished(content) {
				continue
			}
			page := publishedPage{
				Path:      entry.Path,
				PublicURL: "/p/" + entry.Path,
			}
			if publishedAt := rbac.PagePublishedAt(content); publishedAt != nil {
				page.PublishedAt = publishedAt.Format(time.RFC3339)
			}
			pages = append(pages, page)
		}
		return nil
	}

	if err := walk(tree.Children); err != nil {
		return err
	}

	sort.SliceStable(pages, func(i, j int) bool {
		if pages[i].PublishedAt == pages[j].PublishedAt {
			return pages[i].Path < pages[j].Path
		}
		return pages[i].PublishedAt > pages[j].PublishedAt
	})

	return c.JSON(http.StatusOK, publishedPagesResponse{
		Count: len(pages),
		Pages: pages,
	})
}
