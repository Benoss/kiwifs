package cmd

import (
	"os"

	"github.com/kiwifs/kiwifs/internal/refactor/script"
	"github.com/spf13/cobra"
)

// The child process refactor scripts run in. It reads the script and every
// answer from stdin and writes requests and the manifest to stdout; it
// never opens the workspace.
var refactorScriptWorkerCmd = &cobra.Command{
	Use:    "__refactor-script",
	Hidden: true,
	RunE: func(cmd *cobra.Command, _ []string) error {
		return script.Worker(os.Stdin, os.Stdout)
	},
}

func init() {
	rootCmd.AddCommand(refactorScriptWorkerCmd)
}
