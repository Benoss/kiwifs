package cmd

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/kiwifs/kiwifs/internal/config"
	"github.com/kiwifs/kiwifs/internal/markdown"
	"github.com/kiwifs/kiwifs/internal/schema"
	"github.com/spf13/cobra"
)

var lintCmd = &cobra.Command{
	Use:   "lint",
	Short: "Validate a knowledge directory against its SCHEMA.md",
	Long: `Validate the folder at --root against its SCHEMA.md.

Reports:
  - orphan     — SCHEMA.md references a [[page]] that doesn't exist
  - broken-link — a page contains a [[page]] that doesn't resolve
  - empty-file  — a .md file has no content
  - missing-schema — SCHEMA.md itself is missing

Exits 0 on a clean run, 1 if any issues are found. Info-level suggestions
are printed but never fail the run.`,
	Example: `  kiwifs lint --root ~/my-knowledge
  kiwifs lint --root /data/knowledge --json`,
	RunE: runLint,
}

func init() {
	lintCmd.Flags().StringP("root", "r", "./knowledge", "knowledge root directory")
	lintCmd.Flags().Bool("json", false, "emit JSON instead of the human summary")
	rootCmd.AddCommand(lintCmd)
}

func runLint(cmd *cobra.Command, args []string) error {
	root, _ := cmd.Flags().GetString("root")
	asJSON, _ := cmd.Flags().GetBool("json")

	// One process, one workspace: the process-wide default is safe here.
	if cfg, err := config.Load(root); err == nil {
		markdown.SetDefaultFenceOptions(fenceOptions(cfg))
	}

	result, err := schema.Lint(root)
	if err != nil {
		return fmt.Errorf("lint: %w", err)
	}

	if asJSON {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		if err := enc.Encode(result); err != nil {
			return err
		}
	} else {
		fmt.Print(result.Summary())
	}

	if lintFailed(result) {
		// Non-zero exit so CI can gate on lint; don't print the error
		// since we've already emitted a human-readable summary.
		os.Exit(1)
	}
	return nil
}

// lintFailed reports whether any issue should fail CI. Info-level findings
// are suggestions (a widget:live block that could be a typed fence), not
// defects.
func lintFailed(result *schema.Result) bool {
	for _, issue := range result.Issues {
		if issue.Severity != "info" {
			return true
		}
	}
	return false
}

// fenceOptions maps `[ui] typed_fences` / `typed_fence_tags` onto the
// linter, so a bare tag the UI renders as code is not checked as a widget.
func fenceOptions(cfg *config.Config) markdown.FenceOptions {
	return markdown.FenceOptions{
		DisableBare: !cfg.UI.TypedFencesEnabled(),
		BareTags:    cfg.UI.FenceAllow,
	}
}
