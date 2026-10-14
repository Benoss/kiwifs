package script

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	if os.Getenv("KIWI_SCRIPT_WORKER") == "1" {
		if err := Worker(os.Stdin, os.Stdout); err != nil {
			os.Exit(1)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

type fakeHost struct{ reads int }

func (h *fakeHost) Query(_ context.Context, q string) ([]string, error) {
	if q != `type = "meeting"` {
		return nil, nil
	}
	return []string{"notes/a.md", "notes/b.md"}, nil
}
func (h *fakeHost) Files(context.Context, string) ([]string, error) {
	return []string{"notes/a.md", "notes/b.md", "index.md"}, nil
}
func (h *fakeHost) Read(_ context.Context, p string) (string, error) {
	h.reads++
	return "# " + p + "\n", nil
}
func (h *fakeHost) Frontmatter(_ context.Context, p string) (map[string]any, error) {
	if p == "notes/a.md" {
		return map[string]any{"date": "2024-03-01", "tags": []any{"x"}}, nil
	}
	return map[string]any{"date": "2025-01-01"}, nil
}
func (h *fakeHost) Links(context.Context, string) ([]string, error) { return []string{"index.md"}, nil }

func limits() Limits {
	l := DefaultLimits
	l.Command = []string{os.Args[0], "-test.run=^$"}
	l.Env = []string{"KIWI_SCRIPT_WORKER=1"}
	l.Timeout = 10 * time.Second
	return l
}

func TestScriptReturnsAManifestFromReads(t *testing.T) {
	src := `
def main():
    moves = []
    for p in query('type = "meeting"'):
        if frontmatter(p).get("date", "").startswith("2024") and "index.md" in links(p):
            moves.append({"from": p, "to": "archive/2024/" + slug(read(p)[2:]) + ".md"})
    print("moving", len(moves))
    return {"moves": moves, "delete_empty_dirs": True}
`
	res, err := Run(context.Background(), src, &fakeHost{}, limits())
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Manifest.Moves) != 1 || res.Manifest.Moves[0].From != "notes/a.md" || res.Manifest.Moves[0].To != "archive/2024/notes-a-md.md" || !res.Manifest.DeleteEmptyDirs {
		t.Fatalf("manifest = %+v", res.Manifest)
	}
	if res.Output != "moving 1\n" {
		t.Fatalf("output = %q", res.Output)
	}
	res, err = Run(context.Background(), `manifest = {"moves": [{"from": f, "to": "x/"} for f in files() if f != "index.md"]}`, &fakeHost{}, limits())
	if err != nil || len(res.Manifest.Moves) != 2 {
		t.Fatalf("global manifest = %+v, %v", res, err)
	}
}

func TestScriptsAreBounded(t *testing.T) {
	cases := map[string]string{
		"steps":        "def main():\n    n = 0\n    for i in range(1000000000):\n        n += i\n    return {}\n",
		"memory":       "def main():\n    x = []\n    for i in range(100000000):\n        x.append('abcdefghij' * 10)\n    return {}\n",
		"load":         `load("x.star", "y")`,
		"no result":    "x = 1\n",
		"bad manifest": `manifest = {"moves": [{"from": "a", "to": "b", "bogus": 1}]}`,
		"calls":        "def main():\n    for i in range(100000):\n        read('a.md')\n    return {}\n",
	}
	for name, src := range cases {
		lim := limits()
		lim.Steps = 5_000_000
		lim.MemoryMB = 64
		lim.Calls = 1000
		if _, err := Run(context.Background(), src, &fakeHost{}, lim); err == nil {
			t.Errorf("%s: want an error", name)
		} else {
			t.Logf("%s: %v", name, err)
		}
	}
}

func TestScriptTimeoutKillsTheWorker(t *testing.T) {
	lim := limits()
	lim.Steps = 1 << 62
	lim.Timeout = 500 * time.Millisecond
	start := time.Now()
	_, err := Run(context.Background(), "def main():\n    for i in range(1 << 62):\n        pass\n", &fakeHost{}, lim)
	if err == nil || !strings.Contains(err.Error(), "ran past") || time.Since(start) > 5*time.Second {
		t.Fatalf("err = %v after %s", err, time.Since(start))
	}
}

func TestScriptMemoryIsBounded(t *testing.T) {
	lim := limits()
	lim.Steps = 1 << 62
	lim.MemoryMB = 64
	_, err := Run(context.Background(), "def main():\n    x = []\n    for i in range(100000):\n        x.append(str(i) * 1000)\n    return {}\n", &fakeHost{}, lim)
	if err == nil || !strings.Contains(err.Error(), "more than 64 MB") {
		t.Fatalf("err = %v", err)
	}
}
