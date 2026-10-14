package mcpserver

import (
	"os"
	"testing"

	"github.com/kiwifs/kiwifs/internal/pipeline"
	"github.com/kiwifs/kiwifs/internal/refactor/script"
)

// The test binary doubles as the refactor script worker, the way the
// kiwifs binary does with its hidden __refactor-script command.
func TestMain(m *testing.M) {
	if os.Getenv("KIWI_SCRIPT_WORKER") == "1" {
		if err := script.Worker(os.Stdin, os.Stdout); err != nil {
			os.Exit(1)
		}
		os.Exit(0)
	}
	pipeline.ScriptLimits.Command = []string{os.Args[0], "-test.run=^$"}
	pipeline.ScriptLimits.Env = []string{"KIWI_SCRIPT_WORKER=1"}
	os.Exit(m.Run())
}
