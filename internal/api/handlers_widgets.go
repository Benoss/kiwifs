package api

import (
	"net/http"
	"strings"

	"github.com/kiwifs/kiwifs/internal/markdown"
	"github.com/labstack/echo/v4"
)

type widgetReferenceResponse struct {
	Version          int                  `json:"version"`
	ReservedTopLevel []string             `json:"reserved_top_level_keys"`
	ReservedStep     []string             `json:"reserved_step_keys"`
	Fences           []markdown.FenceSpec `json:"fences"`
}

// WidgetReference godoc
//
//	@Summary		Get the widget fence reference
//	@Description	Returns the schema, description and example for every widget fence (```array, ```tree, ```table, …). The same generated catalogue backs the kiwi_widget_reference MCP tool, the markdown linter and docs/WIDGETS.md, so the editor's slash menu cannot drift from what the linter accepts.
//	@Tags			widgets
//	@Security		BearerAuth
//	@Param			name	query		string	false	"Return only this fence (tag or alias)"
//	@Success		200		{object}	widgetReferenceResponse
//	@Failure		404		{object}	map[string]string
//	@Router			/api/kiwi/widgets/reference [get]
func (h *Handlers) WidgetReference(c echo.Context) error {
	fences, err := markdown.WidgetFences()
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": err.Error()})
	}
	topLevel, step := markdown.WidgetFenceReserved()

	if name := strings.TrimSpace(c.QueryParam("name")); name != "" {
		spec, ok := markdown.WidgetFence(name)
		if !ok {
			return c.JSON(http.StatusNotFound, map[string]string{"error": "unknown widget fence: " + name})
		}
		fences = []markdown.FenceSpec{*spec}
	}

	return c.JSON(http.StatusOK, widgetReferenceResponse{
		Version:          1,
		ReservedTopLevel: topLevel,
		ReservedStep:     step,
		Fences:           fences,
	})
}
