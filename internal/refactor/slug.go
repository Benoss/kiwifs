package refactor

import (
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

// slugMaxBytes keeps a slug well inside the 255-byte segment limit, with
// room for an extension and a collision suffix.
const slugMaxBytes = 120

// windowsReserved are names Windows (and SMB shares) refuse as a file or
// folder name, with or without an extension.
var windowsReserved = map[string]bool{
	"con": true, "prn": true, "aux": true, "nul": true,
	"com1": true, "com2": true, "com3": true, "com4": true, "com5": true, "com6": true, "com7": true, "com8": true, "com9": true,
	"lpt1": true, "lpt2": true, "lpt3": true, "lpt4": true, "lpt5": true, "lpt6": true, "lpt7": true, "lpt8": true, "lpt9": true,
}

// Slug turns a title into a portable path segment: accents dropped
// ("Café" → "cafe"), letters and digits of any script kept and lowercased,
// everything else collapsed to single hyphens, NFC-normalized, at most
// slugMaxBytes, never empty and never a reserved Windows name.
func Slug(s string) string {
	decomposed := norm.NFKD.String(s)
	var b strings.Builder
	dash := false
	latinBase := false
	for _, r := range decomposed {
		switch {
		case unicode.Is(unicode.Mn, r):
			// A combining mark from decomposition. On a Latin letter it is
			// an accent and goes; elsewhere it is part of the letter (the
			// voicing mark that makes ヘ into ペ) and stays, to be
			// recomposed by NFC below.
			if !latinBase && !dash && b.Len() > 0 {
				b.WriteRune(r)
			}
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			if dash && b.Len() > 0 {
				b.WriteByte('-')
			}
			dash = false
			latinBase = unicode.Is(unicode.Latin, r)
			b.WriteRune(unicode.ToLower(r))
		default:
			dash = true
		}
	}
	out := norm.NFC.String(b.String())
	if len(out) > slugMaxBytes {
		cut := slugMaxBytes
		for cut > 0 && !utf8.RuneStart(out[cut]) {
			cut--
		}
		out = strings.TrimRight(out[:cut], "-")
	}
	if out == "" {
		return "untitled"
	}
	if windowsReserved[out] {
		out += "-page"
	}
	return out
}
