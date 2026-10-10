package cmd

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/kiwifs/kiwifs/internal/markdown"
	"github.com/spf13/cobra"
)

var widgetsCmd = &cobra.Command{
	Use:   "widgets",
	Short: "Inspect and migrate widget fences",
	Long: `Work with the widget fences a page can draw.

A widget fence is a fenced code block whose body is YAML describing a picture:
` + "```array" + `, ` + "```tree" + `, ` + "```table" + ` and the rest. They are validated on write
by ` + "`kiwifs check`" + ` and documented in docs/WIDGETS.md.`,
}

var widgetsListCmd = &cobra.Command{
	Use:   "list [fence]",
	Short: "List the widget fences, or describe one",
	Example: `  kiwifs widgets list
  kiwifs widgets list tree
  kiwifs widgets list --json`,
	Args: cobra.MaximumNArgs(1),
	RunE: runWidgetsList,
}

var widgetsSuggestCmd = &cobra.Command{
	Use:   "suggest [path]",
	Short: "Find widget:live blocks that could be typed fences",
	Long: `Scan markdown for ` + "`widget:live`" + ` blocks that are a static view call and
nothing else, and print the typed fence each would become.

Heuristic, and deliberately read-only: a block that computes anything is left
alone, and nothing is rewritten. The drafts are a starting point — run
` + "`kiwifs check`" + ` on the result.`,
	Example: `  kiwifs widgets suggest ~/knowledge
  kiwifs widgets suggest page.md
  kiwifs widgets suggest ~/knowledge --json`,
	Args: cobra.MaximumNArgs(1),
	RunE: runWidgetsSuggest,
}

func init() {
	widgetsListCmd.Flags().Bool("json", false, "emit JSON instead of the human summary")
	widgetsSuggestCmd.Flags().Bool("json", false, "emit JSON instead of the human summary")
	widgetsCmd.AddCommand(widgetsListCmd)
	widgetsCmd.AddCommand(widgetsSuggestCmd)
	rootCmd.AddCommand(widgetsCmd)
}

func runWidgetsList(cmd *cobra.Command, args []string) error {
	asJSON, _ := cmd.Flags().GetBool("json")

	fences, err := markdown.WidgetFences()
	if err != nil {
		return err
	}

	if len(args) == 1 {
		spec, ok := markdown.WidgetFence(args[0])
		if !ok {
			tags := make([]string, 0, len(fences))
			for _, f := range fences {
				tags = append(tags, f.Lang)
			}
			return fmt.Errorf("unknown widget fence %q; available: %s", args[0], strings.Join(tags, ", "))
		}
		if asJSON {
			return emitJSON(spec)
		}
		printFenceSpec(*spec)
		return nil
	}

	if asJSON {
		return emitJSON(fences)
	}
	fmt.Printf("%d widget fences:\n\n", len(fences))
	for _, f := range fences {
		fmt.Printf("  %-12s %s\n", f.Lang, f.Description)
	}
	fmt.Print("\nDescribe one with `kiwifs widgets list <fence>`; full reference in docs/WIDGETS.md.\n")
	return nil
}

func printFenceSpec(spec markdown.FenceSpec) {
	fmt.Printf("```%s\n\n%s\n\n", spec.Lang, spec.Description)
	if len(spec.Aliases) > 0 {
		fmt.Printf("Also spelled: %s\n\n", strings.Join(spec.Aliases, ", "))
	}
	if len(spec.Required) > 0 {
		fmt.Printf("A bare `%s` fence renders as a widget when its body carries %s.\n\n",
			spec.Lang, strings.Join(spec.Required, " or "))
	}

	keys := make([]string, 0, len(spec.Attributes))
	for key := range spec.Attributes {
		keys = append(keys, key)
	}
	// Required keys first: the top of the list should already render.
	sort.Slice(keys, func(i, j int) bool {
		ri, rj := spec.Attributes[keys[i]].Required, spec.Attributes[keys[j]].Required
		if ri != rj {
			return ri
		}
		return keys[i] < keys[j]
	})
	fmt.Println("Keys:")
	for _, key := range keys {
		attr := spec.Attributes[key]
		flags := ""
		if attr.Required {
			flags = " (required)"
		} else if !attr.CanStep() {
			flags = " (fixed across steps)"
		}
		fmt.Printf("  %-22s %s%s\n", key, attr.Type, flags)
		if attr.Description != "" {
			fmt.Printf("  %-22s   %s\n", "", attr.Description)
		}
	}
	fmt.Printf("\nExample:\n\n%s\n", spec.Example)
}

type fileSuggestions struct {
	Path        string                      `json:"path"`
	Suggestions []markdown.WidgetSuggestion `json:"suggestions"`
}

func runWidgetsSuggest(cmd *cobra.Command, args []string) error {
	asJSON, _ := cmd.Flags().GetBool("json")
	target := "./knowledge"
	if len(args) == 1 {
		target = args[0]
	}

	var out []fileSuggestions
	err := walkMarkdown(target, func(path string, content []byte) {
		if found := markdown.SuggestWidgetFences(content); len(found) > 0 {
			out = append(out, fileSuggestions{Path: path, Suggestions: found})
		}
	})
	if err != nil {
		return err
	}

	if asJSON {
		if out == nil {
			out = []fileSuggestions{}
		}
		return emitJSON(out)
	}

	total := 0
	for _, f := range out {
		total += len(f.Suggestions)
	}
	if total == 0 {
		fmt.Println("No widget:live blocks look mechanically convertible.")
		return nil
	}

	fmt.Printf("%d convertible block%s:\n", total, plural(total))
	for _, f := range out {
		for _, s := range f.Suggestions {
			fmt.Printf("\n%s:%d — %s\n\n", f.Path, s.Line, s.Reason)
			for _, line := range strings.Split(s.Draft, "\n") {
				fmt.Printf("    %s\n", line)
			}
		}
	}
	fmt.Print("\nDrafts, not rewrites. Check one with `kiwifs check` before committing it.\n")
	return nil
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

// walkMarkdown visits every .md file under target, or target itself when it
// names a file.
func walkMarkdown(target string, visit func(path string, content []byte)) error {
	info, err := os.Stat(target)
	if err != nil {
		return fmt.Errorf("%s: %w", target, err)
	}
	if !info.IsDir() {
		content, err := os.ReadFile(target)
		if err != nil {
			return err
		}
		visit(target, content)
		return nil
	}
	return filepath.WalkDir(target, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		name := d.Name()
		if d.IsDir() {
			// `.kiwi` holds derived state, not pages.
			if strings.HasPrefix(name, ".") && path != target {
				return fs.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(strings.ToLower(name), ".md") || strings.HasPrefix(name, ".") {
			return nil
		}
		content, readErr := os.ReadFile(path)
		if readErr != nil {
			return nil
		}
		visit(path, content)
		return nil
	})
}

func emitJSON(v any) error {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(v)
}
