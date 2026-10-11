package cmd

import (
	"testing"

	"github.com/kiwifs/kiwifs/internal/config"
	"github.com/kiwifs/kiwifs/internal/schema"
)

func TestLintFailedIgnoresInfoIssues(t *testing.T) {
	info := schema.Issue{Kind: "widget-live-convertible", Severity: "info"}
	if lintFailed(&schema.Result{Issues: []schema.Issue{info}}) {
		t.Error("info-only results must exit 0")
	}
	for _, issue := range []schema.Issue{
		{Kind: "fence-widget-invalid", Severity: "warning"},
		{Kind: "fence-widget-invalid", Severity: "error"},
		{Kind: "broken-link"},
	} {
		if !lintFailed(&schema.Result{Issues: []schema.Issue{info, issue}}) {
			t.Errorf("%+v should fail the run", issue)
		}
	}
}

func TestFenceOptionsFromConfig(t *testing.T) {
	off := false
	cfg := &config.Config{}
	cfg.UI.TypedFences = &off
	cfg.UI.FenceAllow = []string{"tree"}
	opts := fenceOptions(cfg)
	if !opts.DisableBare || len(opts.BareTags) != 1 || opts.BareTags[0] != "tree" {
		t.Errorf("unexpected options %+v", opts)
	}
	if fenceOptions(&config.Config{}).DisableBare {
		t.Error("unset typed_fences means on")
	}
}
