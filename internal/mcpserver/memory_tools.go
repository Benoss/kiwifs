package mcpserver

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/kiwifs/kiwifs/internal/memory"
	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

func registerMemoryTools(s *server.MCPServer, b Backend) {
	s.AddTools(
		server.ServerTool{
			Tool: mcp.NewTool("kiwi_remember",
				mcp.WithDescription("Write an episodic memory with conventional path and frontmatter. Creates episodes/{YYYY-MM-DD}/{episode_id}.md with memory_kind episodic, created timestamp, and optional scope/tags."),
				mcp.WithString("content", mcp.Required(), mcp.Description("Markdown body for the episode (required)")),
				mcp.WithString("scope", mcp.Description("Optional scope label, e.g. user:alice")),
				mcp.WithString("episode_id", mcp.Description("Episode identifier; auto-generated UUID when omitted")),
				mcp.WithArray("tags", mcp.Description("Optional tags"), mcp.WithStringItems()),
				mcp.WithDestructiveHintAnnotation(false),
			),
			Handler: handleRemember(b),
		},
		server.ServerTool{
			Tool: mcp.NewTool("kiwi_forget",
				mcp.WithDescription("Mark a memory page as superseded without deleting it. Sets memory_status superseded, valid_until, and optional superseded_reason while preserving the body."),
				mcp.WithString("path", mcp.Required(), mcp.Description("Relative path like episodes/2026-06-05/abc.md")),
				mcp.WithString("reason", mcp.Description("Optional reason the memory was superseded")),
				mcp.WithDestructiveHintAnnotation(false),
			),
			Handler: handleForget(b),
		},
	)
}

func handleRemember(b Backend) server.ToolHandlerFunc {
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		args := req.GetArguments()
		content, _ := args["content"].(string)
		if strings.TrimSpace(content) == "" {
			return mcp.NewToolResultError("content is required"), nil
		}

		episodeID, _ := args["episode_id"].(string)
		episodeID = strings.TrimSpace(episodeID)
		if episodeID == "" {
			episodeID = uuid.New().String()
		}

		scope, _ := args["scope"].(string)
		scope = strings.TrimSpace(scope)

		var tags []string
		if tagsRaw, ok := args["tags"].([]any); ok {
			for _, t := range tagsRaw {
				if s, ok := t.(string); ok && strings.TrimSpace(s) != "" {
					tags = append(tags, strings.TrimSpace(s))
				}
			}
		}

		now := time.Now().UTC()
		dateDir := now.Format("2006-01-02")
		path := fmt.Sprintf("episodes/%s/%s.md", dateDir, episodeID)

		body, err := buildRememberMarkdown(episodeID, scope, tags, now, content)
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("build episode: %v", err)), nil
		}

		etag, err := b.WriteFile(ctx, path, body, "mcp-agent", "")
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("Failed to write %s: %v", path, err)), nil
		}
		return mcp.NewToolResultText(fmt.Sprintf("Remembered %s (episode_id: %s, ETag: %s)", path, episodeID, etag)), nil
	}
}

func buildRememberMarkdown(episodeID, scope string, tags []string, created time.Time, content string) (string, error) {
	fm := map[string]any{
		"memory_kind": memory.KindEpisodic,
		"episode_id":  episodeID,
		"created":     created.Format(time.RFC3339),
	}
	if scope != "" {
		fm["scope"] = scope
	}
	if len(tags) > 0 {
		fm["tags"] = tags
	} else {
		fm["tags"] = []string{}
	}

	yamlBytes, err := yamlMarshal(fm)
	if err != nil {
		return "", err
	}

	var buf strings.Builder
	buf.WriteString("---\n")
	buf.Write(yamlBytes)
	buf.WriteString("---\n\n")
	buf.WriteString(strings.TrimRight(content, "\n"))
	buf.WriteByte('\n')
	return buf.String(), nil
}

func handleForget(b Backend) server.ToolHandlerFunc {
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		args := req.GetArguments()
		path, err := mutationPathArg(args, "path")
		if err != nil {
			return mcp.NewToolResultError(err.Error()), nil
		}

		_, readETag, err := b.ReadFile(ctx, path)
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("Failed to read %s: %v", path, err)), nil
		}

		now := time.Now().UTC()
		reason, _ := args["reason"].(string)
		reason = strings.TrimSpace(reason)

		fields := map[string]any{"memory_status": memory.StatusSuperseded, "valid_until": now}
		if reason != "" {
			fields["superseded_reason"] = reason
		}
		etag, err := b.PatchFrontmatter(ctx, path, fields, readETag, "mcp-agent", true)
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("Failed to write %s: %v", path, err)), nil
		}
		msg := fmt.Sprintf("Forgot %s (memory_status: superseded, ETag: %s)", path, etag)
		if reason != "" {
			msg += fmt.Sprintf(" reason: %s", reason)
		}
		return mcp.NewToolResultText(msg), nil
	}
}
