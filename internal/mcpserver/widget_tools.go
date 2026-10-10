package mcpserver

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/kiwifs/kiwifs/internal/markdown"
	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

// widgetReferenceTool is the piece that makes an agent write a correct widget
// on the first try: a fixed, schema-validated vocabulary it can ask about,
// rather than a React API it has to guess at.
func widgetReferenceTool() server.ServerTool {
	return server.ServerTool{
		Tool: mcp.NewTool("kiwi_widget_reference",
			mcp.WithDescription("List the widget fences a page can draw, or describe one in full. Each fence is a fenced code block with a YAML body: ```array, ```matrix, ```table, ```tree, ```graph, ```plot, ```timeline, and more. Call this before writing one, then verify with kiwi_lint."),
			mcp.WithString("name", mcp.Description("A fence tag (array, tree, table, …). Omit for the full list with one line each.")),
			mcp.WithBoolean("examples", mcp.Description("With no name: include each fence's worked example. Default false.")),
			mcp.WithReadOnlyHintAnnotation(true),
			mcp.WithDestructiveHintAnnotation(false),
		),
		Handler: handleWidgetReference(),
	}
}

type widgetAttributeDoc struct {
	Name        string `json:"name"`
	Type        string `json:"type"`
	Required    bool   `json:"required,omitempty"`
	Items       string `json:"items,omitempty"`
	OneOf       []any  `json:"one_of,omitempty"`
	Description string `json:"description,omitempty"`
	FixedAcross bool   `json:"fixed_across_steps,omitempty"`
}

type widgetFenceDoc struct {
	Fence       string               `json:"fence"`
	Aliases     []string             `json:"aliases"`
	Description string               `json:"description"`
	ClaimedBy   []string             `json:"claimed_by_any_of,omitempty"`
	Attributes  []widgetAttributeDoc `json:"attributes,omitempty"`
	Example     string               `json:"example,omitempty"`
}

type widgetReferenceDoc struct {
	Grammar          string           `json:"grammar"`
	MetaString       string           `json:"meta_string"`
	ReservedTopLevel []string         `json:"reserved_top_level_keys"`
	ReservedStep     []string         `json:"reserved_step_keys"`
	Fences           []widgetFenceDoc `json:"fences"`
}

const widgetGrammar = `Top-level keys are the widget's properties. An optional ` + "`steps:`" + ` list holds ` +
	`one shallow patch per step, each over the previous step, so you write only what changes; ` +
	"`frames:`" + ` is the same list with each entry over the base instead. A step may also carry ` +
	"`note`" + ` (prose under the picture), ` + "`line`" + ` (1-based line of ` + "`code:`" + ` to highlight), ` +
	"`why`" + ` (key → explanation the reader can click for), ` + "`breakpoint`" + `, and ` + "`duration`" + `. ` +
	"`code:`" + ` plus ` + "`lang:`" + ` render a listing that steps in lockstep. Use ` + "`props:`" + ` for a widget ` +
	`property whose name collides with a reserved key.`

const widgetMetaString = "Written after the language on the opening line: `id=` names the widget (and its clock), " +
	"`clock=` shares a step counter with another fence, `caption=\"…\"`, `title=\"…\"`, `width=wide|full`, " +
	"`autoplay`, `loop`. A reader can link to a step as `#?step.<id>=N`."

func attributeDocs(spec *markdown.FenceSpec) []widgetAttributeDoc {
	names := make([]string, 0, len(spec.Attributes))
	for name := range spec.Attributes {
		names = append(names, name)
	}
	// Required keys first, then alphabetical: an agent reads the top of the
	// list and already has a fence that renders.
	sort.Slice(names, func(i, j int) bool {
		ri, rj := spec.Attributes[names[i]].Required, spec.Attributes[names[j]].Required
		if ri != rj {
			return ri
		}
		return names[i] < names[j]
	})
	out := make([]widgetAttributeDoc, 0, len(names))
	for _, name := range names {
		attr := spec.Attributes[name]
		out = append(out, widgetAttributeDoc{
			Name:        name,
			Type:        attr.Type,
			Required:    attr.Required,
			Items:       attr.Items,
			OneOf:       attr.Matches,
			Description: attr.Description,
			FixedAcross: !attr.CanStep(),
		})
	}
	return out
}

func handleWidgetReference() server.ToolHandlerFunc {
	return func(_ context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		args := req.GetArguments()
		name, _ := args["name"].(string)
		withExamples, _ := args["examples"].(bool)

		fences, err := markdown.WidgetFences()
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("widget reference unavailable: %v", err)), nil
		}
		topLevel, step := markdown.WidgetFenceReserved()

		doc := widgetReferenceDoc{
			Grammar:          widgetGrammar,
			MetaString:       widgetMetaString,
			ReservedTopLevel: topLevel,
			ReservedStep:     step,
		}

		if trimmed := strings.TrimSpace(name); trimmed != "" {
			spec, ok := markdown.WidgetFence(trimmed)
			if !ok {
				tags := make([]string, 0, len(fences))
				for _, f := range fences {
					tags = append(tags, f.Lang)
				}
				return mcp.NewToolResultError(fmt.Sprintf(
					"unknown widget fence %q. Available: %s", trimmed, strings.Join(tags, ", "))), nil
			}
			doc.Fences = []widgetFenceDoc{{
				Fence:       spec.Lang,
				Aliases:     spec.Aliases,
				Description: spec.Description,
				ClaimedBy:   spec.Required,
				Attributes:  attributeDocs(spec),
				Example:     spec.Example,
			}}
			out, _ := json.MarshalIndent(doc, "", "  ")
			return mcp.NewToolResultText(string(out)), nil
		}

		for i := range fences {
			spec := &fences[i]
			entry := widgetFenceDoc{
				Fence:       spec.Lang,
				Aliases:     spec.Aliases,
				Description: spec.Description,
				ClaimedBy:   spec.Required,
			}
			if withExamples {
				entry.Example = spec.Example
			}
			doc.Fences = append(doc.Fences, entry)
		}
		out, _ := json.MarshalIndent(doc, "", "  ")
		return mcp.NewToolResultText(string(out)), nil
	}
}
