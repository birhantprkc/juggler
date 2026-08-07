//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// TestIsUntitledName pins the matcher that gates auto-naming: only a bare numbered
// placeholder is a rename candidate. A user-titled or oddly-shaped name must not
// match, or the auto-namer would clobber a real title.
func TestIsUntitledName(t *testing.T) {
	matches := []string{"Untitled 1", "Untitled 42", "Untitled 100"}
	nonMatches := []string{"Untitled", "Untitled ", "untitled 1", "My Untitled 1", "Untitled 1 ", "Untitled 1x", "Fix bug"}
	for _, m := range matches {
		if !IsUntitledName(m) {
			t.Errorf("IsUntitledName(%q) = false, want true", m)
		}
	}
	for _, m := range nonMatches {
		if IsUntitledName(m) {
			t.Errorf("IsUntitledName(%q) = true, want false", m)
		}
	}
}

// TestUntitledNameRoundTrips pins that the two halves of the contract agree: every
// name the generator emits is one the matcher accepts.
func TestUntitledNameRoundTrips(t *testing.T) {
	for n := 1; n <= 3; n++ {
		got := UntitledName(n)
		if !IsUntitledName(got) {
			t.Errorf("UntitledName(%d) = %q, which IsUntitledName rejects", n, got)
		}
	}
	if got := UntitledName(7); got != "Untitled 7" {
		t.Errorf("UntitledName(7) = %q, want %q", got, "Untitled 7")
	}
}

// TestUntitledNamingMatchesJS pins the cross-language contract. Go owns the
// placeholder shape here; the browser keeps a twin in
// web/js/model/conversation-naming.js — the client generates the placeholder a new
// conversation requests, and this package's matcher decides whether to auto-name
// it. If the base word or the numbered pattern drifts between the two, new
// conversations either never auto-name or get clobbered after the user titles them.
// This reads the JS source and asserts the shared constants agree, so the desync is
// caught at build time (mirrors worker/compaction_prompt_parity_test.go).
func TestUntitledNamingMatchesJS(t *testing.T) {
	const jsPath = "../../../web/js/model/conversation-naming.js"
	raw, err := os.ReadFile(jsPath)
	if err != nil {
		t.Fatalf("read %s: %v", jsPath, err)
	}
	// Normalize CRLF → LF so a Windows autocrlf checkout compares apples to apples.
	src := strings.ReplaceAll(string(raw), "\r\n", "\n")

	jsBase, err := extractJSStringConst(src, "UNTITLED_BASE")
	if err != nil {
		t.Fatalf("extract UNTITLED_BASE from %s: %v", jsPath, err)
	}
	if jsBase != UntitledBase {
		t.Fatalf("JS UNTITLED_BASE = %q, Go UntitledBase = %q — update both together", jsBase, UntitledBase)
	}

	jsRe, err := extractJSRegexConst(src, "UNTITLED_NAME_RE")
	if err != nil {
		t.Fatalf("extract UNTITLED_NAME_RE from %s: %v", jsPath, err)
	}
	// The JS regex carries a capture group (to read N) that the Go matcher omits;
	// both derive from the one base word. Assert the JS pattern is exactly the
	// base-derived numbered shape, so it can never drift from UntitledBase.
	wantRe := `^` + regexp.QuoteMeta(UntitledBase) + ` (\d+)$`
	if jsRe != wantRe {
		t.Fatalf("JS UNTITLED_NAME_RE = %q, want %q (derived from Go UntitledBase)", jsRe, wantRe)
	}
	// Belt and suspenders: the JS pattern must agree with the Go matcher on the
	// same inputs, including the tricky near-misses.
	jsCompiled := regexp.MustCompile(jsRe)
	for _, s := range []string{"Untitled 1", "Untitled 99", "Untitled", "untitled 1", "My Untitled 2", "Fix bug"} {
		if jsCompiled.MatchString(s) != IsUntitledName(s) {
			t.Errorf("JS regex and Go IsUntitledName disagree on %q: js=%v go=%v",
				s, jsCompiled.MatchString(s), IsUntitledName(s))
		}
	}
}

// extractJSStringConst pulls the quoted value of `export const NAME = '...'`.
func extractJSStringConst(src, name string) (string, error) {
	decl := "export const " + name + " ="
	i := strings.Index(src, decl)
	if i < 0 {
		return "", errNamingNotFound(decl)
	}
	rest := strings.TrimLeft(src[i+len(decl):], " ")
	if len(rest) == 0 || (rest[0] != '\'' && rest[0] != '"') {
		return "", errNamingNotFound("opening quote after " + decl)
	}
	quote := rest[0]
	end := strings.IndexByte(rest[1:], quote)
	if end < 0 {
		return "", errNamingNotFound("closing quote after " + decl)
	}
	return rest[1 : 1+end], nil
}

// extractJSRegexConst pulls the pattern source of `export const NAME = /.../;` (the
// text between the delimiting slashes). The shared pattern contains no slash, so a
// naive scan to the next slash is sufficient.
func extractJSRegexConst(src, name string) (string, error) {
	decl := "export const " + name + " ="
	i := strings.Index(src, decl)
	if i < 0 {
		return "", errNamingNotFound(decl)
	}
	rest := strings.TrimLeft(src[i+len(decl):], " ")
	if len(rest) == 0 || rest[0] != '/' {
		return "", errNamingNotFound("opening / of regex after " + decl)
	}
	end := strings.IndexByte(rest[1:], '/')
	if end < 0 {
		return "", errNamingNotFound("closing / of regex after " + decl)
	}
	return rest[1 : 1+end], nil
}

type errNamingNotFound string

func (e errNamingNotFound) Error() string { return "not found: " + string(e) }
