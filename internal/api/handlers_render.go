package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/kiwifs/kiwifs/internal/d2render"
	"github.com/labstack/echo/v4"
)

type renderD2Request struct {
	Source string `json:"source"`
	Theme  string `json:"theme"`
}

func (h *Handlers) d2Renderer() *d2render.Renderer {
	h.d2Once.Do(func() {
		dir := ""
		if h.root != "" {
			dir = d2render.CacheDir(h.root)
		}
		h.d2 = d2render.New(dir)
	})
	return h.d2
}

// RenderD2 godoc
//
//	@Summary		Render a D2 diagram to SVG
//	@Description	Renders D2 source server-side with the dagre or ELK layout and returns an SVG. GET takes `source` and `theme` as query parameters so read-only viewers can render; POST takes the same fields as JSON for sources too long for a URL. Imports are disabled. Results are cached by content hash.
//	@Tags			render
//	@Security		BearerAuth
//	@Accept			json
//	@Produce		image/svg+xml
//	@Param			source	query		string				false	"D2 source (GET)"
//	@Param			theme	query		string				false	"light (default) or dark (GET)"
//	@Param			request	body		renderD2Request		false	"D2 source and theme (POST)"
//	@Success		200		{string}	string				"SVG document"
//	@Failure		400		{object}	map[string]string	"Missing or oversized source"
//	@Failure		422		{object}	map[string]string	"The diagram has an error"
//	@Failure		503		{object}	map[string]string	"Render timed out"
//	@Failure		501		{object}	map[string]string	"Built without D2 (-tags nod2)"
//	@Router			/api/kiwi/render/d2 [get]
//	@Router			/api/kiwi/render/d2 [post]
func (h *Handlers) RenderD2(c echo.Context) error {
	req := renderD2Request{Source: c.QueryParam("source"), Theme: c.QueryParam("theme")}
	if c.Request().Method == http.MethodPost {
		body, err := io.ReadAll(io.LimitReader(c.Request().Body, 2*d2render.MaxSourceBytes))
		if err != nil {
			return echo.NewHTTPError(http.StatusBadRequest, "failed to read body")
		}
		if err := json.Unmarshal(body, &req); err != nil {
			return echo.NewHTTPError(http.StatusBadRequest, "invalid JSON body")
		}
	}

	r := h.d2Renderer()
	opts := d2render.Options{Dark: req.Theme == "dark"}
	etag := `"` + r.Key(req.Source, opts) + `"`
	if c.Request().Header.Get("If-None-Match") == etag {
		return c.NoContent(http.StatusNotModified)
	}

	svg, err := r.Render(c.Request().Context(), req.Source, opts)
	if err != nil {
		var se *d2render.SourceError
		switch {
		case errors.As(err, &se):
			return echo.NewHTTPError(http.StatusUnprocessableEntity, se.Msg)
		case errors.Is(err, d2render.ErrTooLarge), errors.Is(err, d2render.ErrEmpty):
			return echo.NewHTTPError(http.StatusBadRequest, err.Error())
		case errors.Is(err, d2render.ErrTimeout):
			return echo.NewHTTPError(http.StatusServiceUnavailable, err.Error())
		case errors.Is(err, d2render.ErrUnavailable):
			return echo.NewHTTPError(http.StatusNotImplemented, err.Error())
		}
		return err
	}
	c.Response().Header().Set("ETag", etag)
	c.Response().Header().Set("Cache-Control", "private, max-age=86400")
	c.Response().Header().Set("X-Content-Type-Options", "nosniff")
	return c.Blob(http.StatusOK, "image/svg+xml", svg)
}
