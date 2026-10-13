package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/kiwifs/kiwifs/internal/pipeline"
	"github.com/kiwifs/kiwifs/internal/refactor"
	"github.com/labstack/echo/v4"
)

const maxManifestBytes = 1 << 20

// RefactorApplyRequest is the body of POST /api/kiwi/refactor/apply.
type RefactorApplyRequest struct {
	Manifest refactor.Manifest `json:"manifest"`
	// Digest, when set, must equal the digest of the plan the caller
	// reviewed. If the workspace changed since, the request fails with 409
	// and returns the new plan instead of applying something unreviewed.
	Digest string `json:"digest,omitempty"`
}

func (h *Handlers) buildRefactorPlan(c echo.Context, m *refactor.Manifest) (*refactor.Plan, error) {
	actor := sanitizeActor(c.Request().Header.Get("X-Actor"))
	plan, err := h.pipe.PlanRefactor(c.Request().Context(), m, refactor.Options{Actor: actor, Client: requestClient(c)})
	if err != nil {
		return nil, echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	return plan, nil
}

// RefactorPlan godoc
//
//	@Summary		Preview a restructuring
//	@Description	Takes a manifest of moves and merges (YAML or JSON) and returns the plan: every page that moves, every link rewritten, comment and personal-state files migrated, and folders removed. Nothing is written. A plan with errors cannot be applied.
//	@Tags			refactor
//	@Security		BearerAuth
//	@Accept			json
//	@Param			body	body		refactor.Manifest	true	"Manifest"
//	@Success		200		{object}	refactor.Plan
//	@Failure		400		{object}	map[string]string
//	@Router			/api/kiwi/refactor/plan [post]
func (h *Handlers) RefactorPlan(c echo.Context) error {
	body, err := io.ReadAll(io.LimitReader(c.Request().Body, maxManifestBytes))
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "failed to read body")
	}
	m, err := refactor.ParseManifest(body)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, err.Error())
	}
	plan, err := h.buildRefactorPlan(c, m)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, plan)
}

// RefactorApply godoc
//
//	@Summary		Apply a restructuring
//	@Description	Rebuilds the plan for the manifest and applies it as one commit. Fails with 422 if the plan has errors, and with 409 if the digest of the reviewed plan no longer matches or a file changed while applying.
//	@Tags			refactor
//	@Security		BearerAuth
//	@Accept			json
//	@Param			body	body		RefactorApplyRequest	true	"Manifest and the digest of the reviewed plan"
//	@Param			X-Actor	header		string					false	"Actor identity performing the restructuring"
//	@Success		200		{object}	map[string]any
//	@Failure		409		{object}	map[string]any
//	@Failure		422		{object}	map[string]any
//	@Router			/api/kiwi/refactor/apply [post]
func (h *Handlers) RefactorApply(c echo.Context) error {
	body, err := io.ReadAll(io.LimitReader(c.Request().Body, maxManifestBytes))
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "failed to read body")
	}
	var req RefactorApplyRequest
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid body: "+err.Error())
	}
	if len(req.Manifest.Moves) == 0 && len(req.Manifest.Merges) == 0 {
		return echo.NewHTTPError(http.StatusBadRequest, "manifest has no moves or merges")
	}
	plan, res, err := h.pipe.Refactor(c.Request().Context(), &req.Manifest, refactor.Options{Client: requestClient(c)}, req.Digest, sanitizeActor(c.Request().Header.Get("X-Actor")))
	switch {
	case errors.Is(err, pipeline.ErrPlanInvalid):
		return c.JSON(http.StatusUnprocessableEntity, map[string]any{"error": "plan has errors", "plan": plan})
	case errors.Is(err, pipeline.ErrDigestMismatch):
		return c.JSON(http.StatusConflict, map[string]any{"error": err.Error(), "plan": plan})
	case errors.Is(err, pipeline.ErrPlanStale):
		return c.JSON(http.StatusConflict, map[string]any{"error": err.Error()})
	case err != nil:
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	return c.JSON(http.StatusOK, map[string]any{"applied": res, "plan": plan})
}

// requestClient names the tool behind a request for the commit trailers:
// X-Kiwi-Client when the caller says (the MCP remote backend, the web UI),
// else "rest". Sanitized like an actor, since it lands in a commit message.
func requestClient(c echo.Context) string {
	if v := c.Request().Header.Get("X-Kiwi-Client"); v != "" {
		return sanitizeActor(v)
	}
	return "rest"
}

// RefactorRevertRequest is the body of POST /api/kiwi/refactor/revert.
type RefactorRevertRequest struct {
	Commit string `json:"commit"`
	// Digest, when set, must equal the digest of the revert plan the
	// caller reviewed (from a dry run).
	Digest string `json:"digest,omitempty"`
	// DryRun returns the revert plan without applying it.
	DryRun bool `json:"dry_run,omitempty"`
}

// RefactorRevert godoc
//
//	@Summary		Undo a commit as a plan
//	@Description	Puts every page the commit changed back to its previous bytes, and the comment and personal-state files a restructuring rewrote back to what they were, as one new commit. Refused (422) if any of those files changed since. dry_run returns the plan; a digest pins the reviewed plan (409 with the fresh plan on drift).
//	@Tags			refactor
//	@Security		BearerAuth
//	@Accept			json
//	@Param			body	body		RefactorRevertRequest	true	"Commit to revert"
//	@Param			X-Actor	header		string					false	"Actor identity performing the revert"
//	@Success		200		{object}	map[string]any
//	@Failure		409		{object}	map[string]any
//	@Failure		422		{object}	map[string]any
//	@Router			/api/kiwi/refactor/revert [post]
func (h *Handlers) RefactorRevert(c echo.Context) error {
	var req RefactorRevertRequest
	if err := bindJSON(c, &req); err != nil {
		return err
	}
	if req.Commit == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "commit is required")
	}
	ctx := c.Request().Context()
	if req.DryRun {
		plan, err := h.pipe.PlanRevert(ctx, req.Commit)
		if err != nil {
			return revertError(err)
		}
		return c.JSON(http.StatusOK, plan)
	}
	plan, res, err := h.pipe.Revert(ctx, req.Commit, req.Digest, requestClient(c), sanitizeActor(c.Request().Header.Get("X-Actor")))
	switch {
	case errors.Is(err, pipeline.ErrPlanInvalid):
		return c.JSON(http.StatusUnprocessableEntity, map[string]any{"error": "the revert plan has errors", "plan": plan})
	case errors.Is(err, pipeline.ErrDigestMismatch):
		return c.JSON(http.StatusConflict, map[string]any{"error": err.Error(), "plan": plan})
	case errors.Is(err, pipeline.ErrPlanStale):
		return c.JSON(http.StatusConflict, map[string]any{"error": err.Error()})
	case err != nil:
		return revertError(err)
	}
	return c.JSON(http.StatusOK, map[string]any{"applied": res, "plan": plan})
}

func revertError(err error) error {
	if errors.Is(err, pipeline.ErrRevertUnsupported) {
		return echo.NewHTTPError(http.StatusNotImplemented, err.Error())
	}
	if strings.Contains(err.Error(), "invalid commit id") {
		return echo.NewHTTPError(http.StatusBadRequest, err.Error())
	}
	return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
}
