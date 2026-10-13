package mcpserver

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/kiwifs/kiwifs/internal/pipeline"
	"github.com/kiwifs/kiwifs/internal/refactor"
	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

const manifestHelp = `Restructuring manifest, as a YAML/JSON string or an object:
  moves:            [{from: guides/old.md, to: guides/new.md}, {from: drafts/, to: archive/drafts/}, {from: "notes/**/*-meeting.md", to: meetings/},
                     {from_regex: 'journal/(\d{4})-.*\.md', to: 'journal/$1/'}]
  merges:           [{from: faq/dup.md, into: faq/canonical.md}]
  delete_empty_dirs: true
  edits:            [{select: {query: 'status = "draft"', glob: "notes/**", paths: [a.md]},
                      set: {status: archived}, unset: [reviewer], add_tags: [x], remove_tags: [y],
                      replace: [{find: "Acme Corp", with: "Acme"}]}]
  rename_tags:      [{from: ml, to: machine-learning}]
Edits may also take when: (a boolean expression), compute: {key: expression}, and move_to: "archive/{{year}}/{{slug}}.md"
with on_conflict: suffix("-%d"). Expressions see path, dir, name, stem, title, tags, fm, links, date, modified, now and
slug(), year(), month(), day(), date(t, layout).
Selection sees the workspace before any change; select needs at least one criterion. Unknown keys are an error.`

func registerRefactorTools(s *server.MCPServer, b Backend) {
	s.AddTools(
		server.ServerTool{
			Tool: mcp.NewTool("kiwi_refactor_plan",
				mcp.WithDescription("Preview a restructuring (move/rename pages and folders, merge duplicates) without writing anything. "+
					"Every wiki and markdown link to a moved page is respelled in its original style and re-resolved to prove it still points at the same page; "+
					"comments and personal state follow the page. Returns the digest to pass to kiwi_refactor_apply, the errors that block it, counts, and a page of moves and link edits. "+
					"Prefer this over looping kiwi_rename: one plan, one review, one commit."),
				mcp.WithAny("manifest", mcp.Required(), mcp.Description(manifestHelp)),
				mcp.WithString("detail", mcp.Description("summary (default): moves and per-page link counts. full: every rewritten link with line numbers. diff: a unified diff per written page."), mcp.Enum("summary", "full", "diff")),
				mcp.WithNumber("offset", mcp.Description("Skip this many moves and edited pages (paging). Default 0.")),
				mcp.WithNumber("limit", mcp.Description("Moves and edited pages per page. Default 25, max 200.")),
				mcp.WithString("actor", mcp.Description("Who will apply it — pages claimed by anyone else cannot be moved. Defaults to mcp-agent")),
				mcp.WithReadOnlyHintAnnotation(true),
				mcp.WithDestructiveHintAnnotation(false),
				mcp.WithIdempotentHintAnnotation(true),
			),
			Handler: handleRefactorPlan(b),
		},
		server.ServerTool{
			Tool: mcp.NewTool("kiwi_refactor_apply",
				mcp.WithDescription("Apply a restructuring previewed with kiwi_refactor_plan, as one git commit. "+
					"digest must be the one from the reviewed plan: if any affected file changed since, nothing is written and the fresh plan comes back to review instead. "+
					"Show the plan to the user before applying anything large."),
				mcp.WithAny("manifest", mcp.Required(), mcp.Description("The same manifest that was planned.")),
				mcp.WithString("digest", mcp.Required(), mcp.Description("Digest from kiwi_refactor_plan."), mcp.MaxLength(64)),
				mcp.WithString("now", mcp.Description("The plan's now, when it reports one (manifests with when/compute/move_to expressions): applying recomputes with that clock so the digest still matches.")),
				mcp.WithString("actor", mcp.Description("Who is restructuring — defaults to mcp-agent")),
				mcp.WithDestructiveHintAnnotation(true),
				mcp.WithIdempotentHintAnnotation(false),
			),
			Handler: handleRefactorApply(b),
		},
		server.ServerTool{
			Tool: mcp.NewTool("kiwi_refactor_revert",
				mcp.WithDescription("Undo a commit (usually a kiwi_refactor_apply, whose result names it) as a new commit: pages go back to their previous bytes, comments and personal state to where they were. "+
					"Without digest it only previews; pass the preview's digest to apply. Refused if any affected page changed since — it never discards later work."),
				mcp.WithString("commit", mcp.Required(), mcp.Description("Commit id to revert"), mcp.MaxLength(64)),
				mcp.WithString("digest", mcp.Description("Digest of the reviewed revert preview; omit to preview"), mcp.MaxLength(64)),
				mcp.WithString("actor", mcp.Description("Who is reverting — defaults to mcp-agent")),
				mcp.WithDestructiveHintAnnotation(true),
				mcp.WithIdempotentHintAnnotation(false),
			),
			Handler: handleRefactorRevert(b),
		},
		server.ServerTool{
			Tool: mcp.NewTool("kiwi_patch_frontmatter",
				mcp.WithDescription("Set or remove frontmatter fields on one page without resending its body. A null value removes the key. "+
					"Pass if_match (the ETag from kiwi_read) to fail instead of overwriting someone else's edit."),
				mcp.WithString("path", mcp.Required(), mcp.Description("Relative path like pages/auth.md"), mcp.MaxLength(500)),
				mcp.WithObject("fields", mcp.Required(), mcp.Description(`Fields to set, e.g. {"status": "done", "tags": ["a", "b"], "draft": null}`)),
				mcp.WithString("if_match", mcp.Description("ETag the page must still have")),
				mcp.WithString("actor", mcp.Description("Who is editing — defaults to mcp-agent")),
				mcp.WithDestructiveHintAnnotation(false),
				mcp.WithIdempotentHintAnnotation(true),
			),
			Handler: handlePatchFrontmatter(b),
		},
	)
}

// manifestArg accepts the manifest as YAML/JSON text or as an object, and
// always goes through ParseManifest so unknown keys are rejected the same
// way the REST API rejects them.
func manifestArg(args map[string]any) (*refactor.Manifest, error) {
	raw, ok := args["manifest"]
	if !ok || raw == nil {
		return nil, fmt.Errorf("manifest is required")
	}
	var data []byte
	switch v := raw.(type) {
	case string:
		data = []byte(v)
	default:
		b, err := json.Marshal(v)
		if err != nil {
			return nil, fmt.Errorf("manifest: %w", err)
		}
		data = b
	}
	return refactor.ParseManifest(data)
}

// planView is a plan cut down to what an agent can read in one tool result:
// counts, errors, and one page of moves and edited pages.
type planView struct {
	Digest     string                 `json:"digest,omitempty"`
	Applicable bool                   `json:"applicable"`
	Errors     []string               `json:"errors,omitempty"`
	Warnings   []string               `json:"warnings,omitempty"`
	Now        *time.Time             `json:"now,omitempty"`
	Stats      refactor.Stats         `json:"stats"`
	Counts     planCounts             `json:"counts"`
	Moves      []refactor.PathChange  `json:"moves"`
	Merges     []refactor.PathChange  `json:"merges,omitempty"`
	Edits      []editView             `json:"edits"`
	Content    []refactor.ContentEdit `json:"content_edits,omitempty"`
	Diffs      []refactor.FileDiff    `json:"diffs,omitempty"`
	Removed    []string               `json:"removed_dirs,omitempty"`
	Offset     int                    `json:"offset"`
	NextOffset int                    `json:"next_offset,omitempty"`
}

type planCounts struct {
	Moves       int `json:"moves"`
	Merges      int `json:"merges"`
	EditedPages int `json:"edited_pages"`
	Comments    int `json:"comment_files"`
	StateFiles  int `json:"state_files"`
	RemovedDirs int `json:"removed_dirs"`
	// ContentEdits counts pages whose content (not just links) changes.
	ContentEdits int `json:"content_edits"`
	// Writes counts every file the plan writes.
	Writes int `json:"writes"`
}

type editView struct {
	Path  string              `json:"path"`
	From  string              `json:"from,omitempty"`
	Count int                 `json:"links"`
	Links []refactor.LinkEdit `json:"changes,omitempty"`
}

func pageOf[T any](items []T, offset, limit int) []T {
	if offset >= len(items) {
		return []T{}
	}
	end := offset + limit
	if end > len(items) {
		end = len(items)
	}
	return items[offset:end]
}

func viewPlan(plan *refactor.Plan, full bool, offset, limit int) planView {
	return viewPlanDetail(plan, map[bool]string{true: "full", false: "summary"}[full], offset, limit)
}

func viewPlanDetail(plan *refactor.Plan, detail string, offset, limit int) planView {
	full := detail == "full" || detail == "diff"
	v := planView{
		Digest:     plan.Digest,
		Applicable: len(plan.Errors) == 0,
		Errors:     plan.Errors,
		Warnings:   plan.Warnings,
		Now:        plan.Now,
		Stats:      plan.Stats,
		Counts: planCounts{
			Moves:        len(plan.Moves),
			Merges:       len(plan.Merges),
			EditedPages:  len(plan.Edits),
			Comments:     len(plan.Comments),
			StateFiles:   len(plan.State),
			RemovedDirs:  len(plan.RemovedDirs),
			ContentEdits: len(plan.ContentEdits),
			Writes:       len(plan.Ops.Writes),
		},
		Moves:   pageOf(plan.Moves, offset, limit),
		Merges:  plan.Merges,
		Removed: plan.RemovedDirs,
		Offset:  offset,
	}
	for _, e := range pageOf(plan.Edits, offset, limit) {
		ev := editView{Path: e.Path, From: e.From, Count: len(e.Links)}
		if full {
			ev.Links = e.Links
		}
		v.Edits = append(v.Edits, ev)
	}
	if v.Edits == nil {
		v.Edits = []editView{}
	}
	v.Content = pageOf(plan.ContentEdits, offset, limit)
	if detail == "diff" {
		v.Diffs = pageOf(plan.FileDiffs(), offset, limit)
	}
	next := offset + limit
	if next < len(plan.Moves) || next < len(plan.Edits) || next < len(plan.ContentEdits) || detail == "diff" && next < len(plan.Ops.Writes) {
		v.NextOffset = next
	}
	return v
}

// clientName is the MCP client on the other end ("claude-code 2.1"), for
// the commit trailers of a restructuring.
func clientName(ctx context.Context) string {
	if s, ok := server.ClientSessionFromContext(ctx).(server.SessionWithClientInfo); ok {
		info := s.GetClientInfo()
		return strings.TrimSpace("mcp/" + info.Name + " " + info.Version)
	}
	return "mcp"
}

func structured(v any) *mcp.CallToolResult {
	data, _ := json.MarshalIndent(v, "", "  ")
	return mcp.NewToolResultStructured(v, string(data))
}

func handleRefactorPlan(b Backend) server.ToolHandlerFunc {
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		args := req.GetArguments()
		m, err := manifestArg(args)
		if err != nil {
			return mcp.NewToolResultError(err.Error()), nil
		}
		offset := intArg(args, "offset", 0)
		if offset < 0 {
			offset = 0
		}
		limit := intArg(args, "limit", 25)
		if limit <= 0 || limit > 200 {
			limit = 25
		}
		detail, _ := args["detail"].(string)
		actor, _ := args["actor"].(string)
		if actor == "" {
			actor = "mcp-agent"
		}
		plan, err := b.RefactorPlan(ctx, m, actor)
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("Plan failed: %v", err)), nil
		}
		return structured(viewPlanDetail(plan, detail, offset, limit)), nil
	}
}

func handleRefactorApply(b Backend) server.ToolHandlerFunc {
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		args := req.GetArguments()
		m, err := manifestArg(args)
		if err != nil {
			return mcp.NewToolResultError(err.Error()), nil
		}
		digest, _ := args["digest"].(string)
		if digest == "" {
			return mcp.NewToolResultError("digest is required: run kiwi_refactor_plan first and pass its digest"), nil
		}
		if raw, _ := args["now"].(string); raw != "" && m.Now == nil {
			now, err := time.Parse(time.RFC3339Nano, raw)
			if err != nil {
				return mcp.NewToolResultError("now: " + err.Error()), nil
			}
			m.Now = &now
		}
		actor, _ := args["actor"].(string)
		if actor == "" {
			actor = "mcp-agent"
		}
		res, err := b.RefactorApply(ctx, m, digest, actor)
		return refactorResult(res, err, false)
	}
}

func handleRefactorRevert(b Backend) server.ToolHandlerFunc {
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		args := req.GetArguments()
		commit, _ := args["commit"].(string)
		if commit == "" {
			return mcp.NewToolResultError("commit is required"), nil
		}
		digest, _ := args["digest"].(string)
		actor, _ := args["actor"].(string)
		if actor == "" {
			actor = "mcp-agent"
		}
		res, err := b.RefactorRevert(ctx, commit, digest, actor, digest != "")
		return refactorResult(res, err, digest == "")
	}
}

// refactorResult turns an apply or revert outcome into a tool result. An
// invalid or drifted plan is an error result that still carries the plan.
func refactorResult(res *RefactorApplyResult, err error, preview bool) (*mcp.CallToolResult, error) {
	var plan *refactor.Plan
	if res != nil {
		plan = res.Plan
	}
	withPlan := func(msg string) *mcp.CallToolResult {
		r := structured(map[string]any{"error": msg, "plan": viewPlan(plan, false, 0, 25)})
		r.IsError = true
		return r
	}
	switch {
	case errors.Is(err, pipeline.ErrDigestMismatch) && plan != nil:
		return withPlan("the workspace changed since this plan was reviewed; nothing was applied. Review the fresh plan and apply with its digest."), nil
	case errors.Is(err, pipeline.ErrPlanInvalid) && plan != nil:
		return withPlan("the plan has errors; nothing was applied"), nil
	case err != nil:
		return mcp.NewToolResultError(fmt.Sprintf("Failed: %v", err)), nil
	case preview:
		return structured(viewPlan(plan, true, 0, 200)), nil
	}
	return structured(map[string]any{
		"applied": res.Applied,
		"digest":  plan.Digest,
		"counts":  viewPlan(plan, false, 0, 0).Counts,
	}), nil
}

func handlePatchFrontmatter(b Backend) server.ToolHandlerFunc {
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		args := req.GetArguments()
		path, err := mutationPathArg(args, "path")
		if err != nil {
			return mcp.NewToolResultError(err.Error()), nil
		}
		fields, ok := args["fields"].(map[string]any)
		if !ok || len(fields) == 0 {
			return mcp.NewToolResultError("fields is required — an object of frontmatter keys to set (null removes)"), nil
		}
		ifMatch, _ := args["if_match"].(string)
		actor, _ := args["actor"].(string)
		if actor == "" {
			actor = "mcp-agent"
		}
		etag, err := b.PatchFrontmatter(ctx, path, fields, ifMatch, actor)
		if err != nil {
			if errors.Is(err, pipeline.ErrConflict) {
				return mcp.NewToolResultError(fmt.Sprintf("%s changed since you read it (if_match did not match). Re-read it and retry.", path)), nil
			}
			if isNotFound(err) {
				return mcp.NewToolResultError(fmt.Sprintf("File not found at %s. Use kiwi_tree to see available files.", path)), nil
			}
			return mcp.NewToolResultError(fmt.Sprintf("Failed to patch %s: %v", path, err)), nil
		}
		return mcp.NewToolResultText(fmt.Sprintf("Patched %s (ETag: %s)", path, etag)), nil
	}
}
