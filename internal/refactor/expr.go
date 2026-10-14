package refactor

import (
	"fmt"
	"path"
	"regexp"
	"strings"
	"time"

	"github.com/expr-lang/expr"
	"github.com/expr-lang/expr/vm"
	"github.com/kiwifs/kiwifs/internal/markdown"
)

// Expressions in a manifest (when:, compute:, and the {{ }} parts of a
// move_to template) are expr-lang programs over one page as it was before
// the manifest, with:
//
//	path, dir, name, stem   where the page is ("notes/a.md", "notes", "a.md", "a")
//	title                   frontmatter title, else the first # heading, else stem
//	tags                    frontmatter tags
//	fm                      the whole frontmatter (fm.status, fm["due-date"])
//	links                   paths the page links to
//	date                    fm.date, else fm.created, else modified
//	modified                the file's modification time
//	now                     the plan's clock: recorded on the plan, so applying
//	                        what was reviewed computes the same values
//
// and the pure helpers slug(s), year(t), month(t), day(t), date(t[, layout])
// plus expr's builtins (lower, upper, trim, split, join, len, …). Programs
// cannot touch the disk or the network, and expr bounds their size and
// memory.

// templateSugar maps a bare {{word}} in a move_to template to what it means.
var templateSugar = map[string]string{
	"slug":  "slug(title)",
	"year":  "year(date)",
	"month": "month(date)",
	"day":   "day(date)",
}

var templatePartRe = regexp.MustCompile(`\{\{(.*?)\}\}`)

// exprMaxLen bounds one expression's source.
const exprMaxLen = 2048

func exprOptions(extra ...expr.Option) []expr.Option {
	opts := []expr.Option{
		expr.Env(map[string]any{}),
		expr.AllowUndefinedVariables(),
		expr.Function("slug", func(params ...any) (any, error) {
			return Slug(fmt.Sprint(params[0])), nil
		}, new(func(any) string)),
		expr.Function("year", timePart("2006"), new(func(any) string)),
		expr.Function("month", timePart("01"), new(func(any) string)),
		expr.Function("day", timePart("02"), new(func(any) string)),
		expr.Function("date", func(params ...any) (any, error) {
			layout := "2006-01-02"
			if len(params) > 1 {
				layout = fmt.Sprint(params[1])
			}
			t, err := asTime(params[0])
			if err != nil {
				return nil, err
			}
			return t.Format(layout), nil
		}, new(func(any) string), new(func(any, string) string)),
	}
	return append(opts, extra...)
}

func timePart(layout string) func(params ...any) (any, error) {
	return func(params ...any) (any, error) {
		t, err := asTime(params[0])
		if err != nil {
			return nil, err
		}
		return t.Format(layout), nil
	}
}

func asTime(v any) (time.Time, error) {
	switch x := v.(type) {
	case time.Time:
		return x, nil
	case string:
		for _, layout := range []string{time.RFC3339, "2006-01-02T15:04:05", "2006-01-02 15:04", "2006-01-02"} {
			if t, err := time.Parse(layout, strings.TrimSpace(x)); err == nil {
				return t, nil
			}
		}
		return time.Time{}, fmt.Errorf("%q is not a date", x)
	case nil:
		return time.Time{}, fmt.Errorf("no date")
	}
	return time.Time{}, fmt.Errorf("%v is not a date", v)
}

func compileExpr(src string, extra ...expr.Option) (*vm.Program, error) {
	if len(src) > exprMaxLen {
		return nil, fmt.Errorf("expression longer than %d bytes", exprMaxLen)
	}
	return expr.Compile(src, exprOptions(extra...)...)
}

// template is a compiled move_to: literal text and expressions.
type template struct {
	lits  []string
	progs []*vm.Program
}

func compileTemplate(src string) (*template, error) {
	t := &template{}
	last := 0
	for _, m := range templatePartRe.FindAllStringSubmatchIndex(src, -1) {
		t.lits = append(t.lits, src[last:m[0]])
		code := strings.TrimSpace(src[m[2]:m[3]])
		if sugar, ok := templateSugar[code]; ok {
			code = sugar
		}
		prog, err := compileExpr(code)
		if err != nil {
			return nil, fmt.Errorf("{{%s}}: %w", code, err)
		}
		t.progs = append(t.progs, prog)
		last = m[1]
	}
	t.lits = append(t.lits, src[last:])
	return t, nil
}

func (t *template) render(env map[string]any) (string, error) {
	var b strings.Builder
	for i, lit := range t.lits {
		b.WriteString(lit)
		if i == len(t.progs) {
			break
		}
		v, err := expr.Run(t.progs[i], env)
		if err != nil {
			return "", err
		}
		s := stringify(v)
		if s == "" {
			return "", fmt.Errorf("part %d of the template is empty", i+1)
		}
		b.WriteString(s)
	}
	return b.String(), nil
}

func stringify(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case time.Time:
		return x.Format("2006-01-02")
	}
	return fmt.Sprint(v)
}

// pageEnv is the expression environment for one page.
func pageEnv(f string, content []byte, modified, now time.Time, outLinks []string) map[string]any {
	fm, _ := markdown.Frontmatter(content)
	if fm == nil {
		fm = map[string]any{}
	}
	stem := strings.TrimSuffix(path.Base(f), path.Ext(f))
	title, _ := fm["title"].(string)
	if strings.TrimSpace(title) == "" {
		title = firstHeading(content)
	}
	if strings.TrimSpace(title) == "" {
		title = stem
	}
	var date any = modified
	for _, k := range []string{"date", "created"} {
		if v, ok := fm[k]; ok && v != nil {
			if t, err := asTime(v); err == nil {
				date = t
				break
			}
		}
	}
	tags := pageTags(content)
	if tags == nil {
		tags = []string{}
	}
	if outLinks == nil {
		outLinks = []string{}
	}
	return map[string]any{
		"path":     f,
		"dir":      dirOf(f),
		"name":     path.Base(f),
		"stem":     stem,
		"title":    title,
		"tags":     tags,
		"fm":       fm,
		"links":    outLinks,
		"date":     date,
		"modified": modified,
		"now":      now,
	}
}

func firstHeading(content []byte) string {
	masked := maskCode(content)
	for _, line := range strings.Split(string(masked), "\n") {
		if strings.HasPrefix(line, "# ") {
			return strings.TrimSpace(line[2:])
		}
	}
	return ""
}
