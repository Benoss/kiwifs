package cmd

import (
	"context"
	"os"
	"path/filepath"

	"github.com/kiwifs/kiwifs/internal/config"
	"github.com/kiwifs/kiwifs/internal/lsp"
	"github.com/kiwifs/kiwifs/internal/refactor"
	"github.com/kiwifs/kiwifs/internal/storage"
	"github.com/spf13/cobra"
)

var lspCmd = &cobra.Command{
	Use:   "lsp",
	Short: "Language server that relinks when your editor renames pages",
	Long: `Speaks the Language Server Protocol on stdin/stdout. When the editor is about
to rename or move files (workspace/willRenameFiles), it answers with the edits
that keep every link pointing at them — computed by the same planner as
"kiwifs refactor", in each link's own style. Point your editor's generic LSP
client at "kiwifs lsp" for markdown files.

The editor performs the rename itself, so comments and personal state do not
follow the page; use "kiwifs refactor" or the web UI when they matter.`,
	RunE: func(cmd *cobra.Command, _ []string) error {
		root, _ := cmd.Flags().GetString("root")
		if root != "" {
			abs, err := filepath.Abs(root)
			if err != nil {
				return err
			}
			root = abs
		}
		srv := &lsp.Server{Root: root, Plan: planForLSP, Version: Version}
		return srv.Serve(cmd.Context(), os.Stdin, os.Stdout)
	},
}

func init() {
	lspCmd.Flags().StringP("root", "r", "", "knowledge root (default: the editor's workspace folder)")
	rootCmd.AddCommand(lspCmd)
}

func planForLSP(ctx context.Context, root string, m *refactor.Manifest) (*refactor.Plan, error) {
	store, err := storage.NewLocal(root)
	if err != nil {
		return nil, err
	}
	ws := refactor.Workspace{Root: root, Store: store}
	opts := refactor.Options{Client: "lsp"}
	if cfg, err := config.Load(root); err == nil {
		ws.TypedFields = cfg.Links.TypedLinkFields()
		opts.Policy = cfg.Refactor.Policy()
	}
	return refactor.BuildPlanWith(ctx, ws, m, opts)
}
