// Package script runs a Starlark program that computes a restructuring
// manifest from the workspace — selection logic too irregular for globs,
// DQL and expressions — without being able to change anything.
//
// The program runs in a child process (kiwifs __refactor-script) that has
// no access to the workspace at all: every read goes back to the parent
// over the child's stdin/stdout, through a Host that can only read. The
// child is bounded by Starlark's step counter, a memory watchdog, and the
// parent's deadline (which kills it); the parent bounds how many calls and
// bytes it serves. Its only output is a manifest, which is then planned
// and reviewed like any other.
//
// A script returns its manifest from main(), or sets a global manifest:
//
//	def main():
//	    moves = []
//	    for p in query('type = "meeting"'):
//	        fm = frontmatter(p)
//	        if fm.get("date", "").startswith("2024"):
//	            moves.append({"from": p, "to": "archive/2024/"})
//	    return {"moves": moves}
//
// Bindings: query(dql) → paths; files(glob="**") → paths; read(path) →
// text; frontmatter(path) → dict; links(path) → paths it links to;
// slug(text); json.encode/decode; print (captured).
package script

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"runtime/debug"
	"strings"
	"time"

	"github.com/kiwifs/kiwifs/internal/refactor"
	starjson "go.starlark.net/lib/json"
	"go.starlark.net/starlark"
	"go.starlark.net/syntax"
)

// Host is what a script may read.
type Host interface {
	Query(ctx context.Context, dql string) ([]string, error)
	Files(ctx context.Context, glob string) ([]string, error)
	Read(ctx context.Context, path string) (string, error)
	Frontmatter(ctx context.Context, path string) (map[string]any, error)
	Links(ctx context.Context, path string) ([]string, error)
}

// Limits bound one run.
type Limits struct {
	// Steps is Starlark's execution step budget.
	Steps uint64
	// MemoryMB caps the child's heap.
	MemoryMB int
	// Timeout kills the child.
	Timeout time.Duration
	// Calls and ReadBytes cap what the parent serves.
	Calls     int
	ReadBytes int64
	// Command starts the child; default: this executable with
	// "__refactor-script".
	Command []string
	// Env is added to the child's (otherwise minimal) environment.
	Env []string
}

// DefaultLimits are generous for real restructurings and small enough
// that a runaway script costs seconds, not the server.
var DefaultLimits = Limits{Steps: 50_000_000, MemoryMB: 256, Timeout: 30 * time.Second, Calls: 20_000, ReadBytes: 256 << 20}

// Result is a script's manifest and what it printed.
type Result struct {
	Manifest *refactor.Manifest
	Raw      json.RawMessage
	Output   string
}

const maxScriptBytes = 256 << 10

type startMsg struct {
	Script   string `json:"script"`
	Steps    uint64 `json:"steps"`
	MemoryMB int    `json:"memory_mb"`
}

type callMsg struct {
	Call   string          `json:"call,omitempty"`
	Args   []string        `json:"args,omitempty"`
	Done   json.RawMessage `json:"done,omitempty"`
	Output string          `json:"output,omitempty"`
	Error  string          `json:"error,omitempty"`
}

type replyMsg struct {
	Result any    `json:"result,omitempty"`
	Error  string `json:"error,omitempty"`
}

// Run executes script in a child process and returns the manifest it
// produced, parsed and validated like any manifest.
func Run(ctx context.Context, script string, host Host, lim Limits) (*Result, error) {
	if len(script) > maxScriptBytes {
		return nil, fmt.Errorf("script longer than %d bytes", maxScriptBytes)
	}
	if lim.Steps == 0 {
		lim = DefaultLimits
	}
	ctx, cancel := context.WithTimeout(ctx, lim.Timeout)
	defer cancel()

	command := lim.Command
	if len(command) == 0 {
		exe, err := os.Executable()
		if err != nil {
			return nil, err
		}
		command = []string{exe, "__refactor-script"}
	}
	cmd := exec.CommandContext(ctx, command[0], command[1:]...)
	// The child needs nothing from the parent's environment: no
	// credentials, no config paths.
	cmd.Env = append([]string{"GOMAXPROCS=1"}, lim.Env...)
	cmd.Stderr = io.Discard
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start script runner: %w", err)
	}
	defer func() {
		_ = stdin.Close()
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	}()

	enc := json.NewEncoder(stdin)
	if err := enc.Encode(startMsg{Script: script, Steps: lim.Steps, MemoryMB: lim.MemoryMB}); err != nil {
		return nil, err
	}
	dec := json.NewDecoder(bufio.NewReader(stdout))
	calls := 0
	var served int64
	for {
		var msg callMsg
		if err := dec.Decode(&msg); err != nil {
			if ctx.Err() != nil {
				return nil, fmt.Errorf("script ran past %s", lim.Timeout)
			}
			return nil, fmt.Errorf("script runner stopped: %w", err)
		}
		switch {
		case msg.Error != "":
			return nil, errors.New(msg.Error)
		case msg.Done != nil:
			m, err := refactor.ParseManifest(msg.Done)
			if err != nil {
				return nil, fmt.Errorf("the script's manifest: %w", err)
			}
			return &Result{Manifest: m, Raw: msg.Done, Output: msg.Output}, nil
		}
		calls++
		if calls > lim.Calls {
			return nil, fmt.Errorf("script made more than %d calls", lim.Calls)
		}
		result, err := serve(ctx, host, msg)
		reply := replyMsg{Result: result}
		if err != nil {
			reply.Error = err.Error()
		}
		if s, ok := result.(string); ok {
			served += int64(len(s))
			if served > lim.ReadBytes {
				return nil, fmt.Errorf("script read more than %d bytes", lim.ReadBytes)
			}
		}
		if err := enc.Encode(reply); err != nil {
			return nil, err
		}
	}
}

func serve(ctx context.Context, host Host, msg callMsg) (any, error) {
	arg := func(i int) string {
		if i < len(msg.Args) {
			return msg.Args[i]
		}
		return ""
	}
	switch msg.Call {
	case "query":
		return host.Query(ctx, arg(0))
	case "files":
		return host.Files(ctx, arg(0))
	case "read":
		return host.Read(ctx, arg(0))
	case "frontmatter":
		return host.Frontmatter(ctx, arg(0))
	case "links":
		return host.Links(ctx, arg(0))
	}
	return nil, fmt.Errorf("unknown call %q", msg.Call)
}

// Worker is the child side: read the script, run it, ask the parent for
// every read, and answer with the manifest. It never touches the disk.
func Worker(in io.Reader, out io.Writer) error {
	dec := json.NewDecoder(bufio.NewReader(in))
	enc := json.NewEncoder(out)
	var start startMsg
	if err := dec.Decode(&start); err != nil {
		return err
	}
	fail := func(err error) error {
		return enc.Encode(callMsg{Error: err.Error()})
	}

	var output strings.Builder
	thread := &starlark.Thread{
		Name: "refactor-script",
		Print: func(_ *starlark.Thread, msg string) {
			if output.Len() < 64<<10 {
				output.WriteString(msg)
				output.WriteByte('\n')
			}
		},
		Load: func(*starlark.Thread, string) (starlark.StringDict, error) {
			return nil, errors.New("load() is not available")
		},
	}
	thread.SetMaxExecutionSteps(start.Steps)
	if start.MemoryMB > 0 {
		limit := int64(start.MemoryMB) << 20
		debug.SetMemoryLimit(limit)
		stop := make(chan struct{})
		defer close(stop)
		go func() {
			t := time.NewTicker(20 * time.Millisecond)
			defer t.Stop()
			var ms runtime.MemStats
			for {
				select {
				case <-stop:
					return
				case <-t.C:
					runtime.ReadMemStats(&ms)
					if int64(ms.HeapAlloc) > limit {
						thread.Cancel(fmt.Sprintf("script used more than %d MB", start.MemoryMB))
						return
					}
				}
			}
		}()
	}

	call := func(name string, args ...string) (any, error) {
		if err := enc.Encode(callMsg{Call: name, Args: args}); err != nil {
			return nil, err
		}
		var reply replyMsg
		if err := dec.Decode(&reply); err != nil {
			return nil, err
		}
		if reply.Error != "" {
			return nil, errors.New(reply.Error)
		}
		return reply.Result, nil
	}
	predeclared := starlark.StringDict{
		"json": starjson.Module,
		"slug": starlark.NewBuiltin("slug", func(_ *starlark.Thread, b *starlark.Builtin, args starlark.Tuple, kwargs []starlark.Tuple) (starlark.Value, error) {
			var s string
			if err := starlark.UnpackPositionalArgs(b.Name(), args, kwargs, 1, &s); err != nil {
				return nil, err
			}
			return starlark.String(refactor.Slug(s)), nil
		}),
	}
	for _, name := range []string{"query", "read", "frontmatter", "links"} {
		predeclared[name] = hostBuiltin(name, call, false)
	}
	predeclared["files"] = hostBuiltin("files", call, true)

	globals, err := starlark.ExecFileOptions(&syntax.FileOptions{}, thread, "script.star", start.Script, predeclared)
	if err != nil {
		return fail(scriptError(err))
	}
	var result starlark.Value = globals["manifest"]
	if main, ok := globals["main"].(starlark.Callable); ok {
		if result, err = starlark.Call(thread, main, nil, nil); err != nil {
			return fail(scriptError(err))
		}
	}
	if result == nil || result == starlark.None {
		return fail(errors.New("the script must return a manifest from main() or set a global manifest"))
	}
	value, err := toGo(result)
	if err != nil {
		return fail(err)
	}
	data, err := json.Marshal(value)
	if err != nil {
		return fail(err)
	}
	return enc.Encode(callMsg{Done: data, Output: output.String()})
}

func scriptError(err error) error {
	var evalErr *starlark.EvalError
	if errors.As(err, &evalErr) {
		return errors.New(evalErr.Backtrace())
	}
	return err
}

func hostBuiltin(name string, call func(string, ...string) (any, error), optional bool) *starlark.Builtin {
	return starlark.NewBuiltin(name, func(_ *starlark.Thread, b *starlark.Builtin, args starlark.Tuple, kwargs []starlark.Tuple) (starlark.Value, error) {
		var s string
		min := 1
		if optional {
			min = 0
			s = "**"
		}
		if err := starlark.UnpackPositionalArgs(b.Name(), args, kwargs, min, &s); err != nil {
			return nil, err
		}
		v, err := call(name, s)
		if err != nil {
			return nil, fmt.Errorf("%s(%q): %w", name, s, err)
		}
		return toStarlark(v)
	})
}

func toStarlark(v any) (starlark.Value, error) {
	switch x := v.(type) {
	case nil:
		return starlark.None, nil
	case string:
		return starlark.String(x), nil
	case bool:
		return starlark.Bool(x), nil
	case float64:
		if float64(int64(x)) == x {
			return starlark.MakeInt64(int64(x)), nil
		}
		return starlark.Float(x), nil
	case []any:
		items := make([]starlark.Value, 0, len(x))
		for _, e := range x {
			sv, err := toStarlark(e)
			if err != nil {
				return nil, err
			}
			items = append(items, sv)
		}
		return starlark.NewList(items), nil
	case map[string]any:
		d := starlark.NewDict(len(x))
		for k, e := range x {
			sv, err := toStarlark(e)
			if err != nil {
				return nil, err
			}
			if err := d.SetKey(starlark.String(k), sv); err != nil {
				return nil, err
			}
		}
		return d, nil
	}
	return starlark.String(fmt.Sprint(v)), nil
}

func toGo(v starlark.Value) (any, error) {
	switch x := v.(type) {
	case starlark.NoneType:
		return nil, nil
	case starlark.String:
		return string(x), nil
	case starlark.Bool:
		return bool(x), nil
	case starlark.Int:
		n, ok := x.Int64()
		if !ok {
			return nil, fmt.Errorf("integer %s is too large", x)
		}
		return n, nil
	case starlark.Float:
		return float64(x), nil
	case *starlark.List:
		out := make([]any, 0, x.Len())
		for i := 0; i < x.Len(); i++ {
			e, err := toGo(x.Index(i))
			if err != nil {
				return nil, err
			}
			out = append(out, e)
		}
		return out, nil
	case starlark.Tuple:
		out := make([]any, 0, len(x))
		for _, e := range x {
			g, err := toGo(e)
			if err != nil {
				return nil, err
			}
			out = append(out, g)
		}
		return out, nil
	case *starlark.Dict:
		out := make(map[string]any, x.Len())
		for _, item := range x.Items() {
			k, ok := item[0].(starlark.String)
			if !ok {
				return nil, fmt.Errorf("manifest keys must be strings, got %s", item[0].Type())
			}
			g, err := toGo(item[1])
			if err != nil {
				return nil, err
			}
			out[string(k)] = g
		}
		return out, nil
	}
	return nil, fmt.Errorf("a manifest cannot hold a %s", v.Type())
}
