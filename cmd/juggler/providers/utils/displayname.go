//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package utils

import (
	"strings"
	"unicode"
)

// modelAcronyms are id tokens that read better fully uppercased than
// title-cased when a model id has no vendor-supplied display name to use.
var modelAcronyms = map[string]string{
	"gpt": "GPT",
	"glm": "GLM",
	"oss": "OSS",
	"ai":  "AI",
}

// ModelDisplayName derives a readable label from a raw hyphenated model id, for
// providers whose upstream listing carries no human name of its own. Runs of
// numeric tokens collapse into a dotted version (`4-5` → `4.5`), known acronyms
// uppercase (`gpt` → `GPT`), and a leading brand hyphenates onto its version the
// way the vendors write it (`gpt-5-codex` → `GPT-5 Codex`, `glm-4.6` → `GLM-4.6`).
// Tokens already carrying a digit (`4o`, `o3`) pass through untouched so real
// casing survives.
//
// This is a shared convenience a provider may call when composing its
// ModelInfo.DisplayName — the naming decision still belongs to the provider,
// which owns any prefix/qualifier it wraps around this base (e.g. claudecode's
// "Claude … (CLI)"). Never the wire id: this string is presentation only.
func ModelDisplayName(id string) string {
	base := strings.TrimPrefix(id, "models/")
	if base == "" {
		return ""
	}

	// Collapse consecutive pure-integer tokens into one dotted version token.
	var merged []string
	for _, part := range strings.Split(base, "-") {
		if part == "" {
			continue
		}
		if isDigits(part) && len(merged) > 0 && isDottedVersion(merged[len(merged)-1]) {
			merged[len(merged)-1] += "." + part
		} else {
			merged = append(merged, part)
		}
	}

	type token struct {
		text    string
		acronym bool
	}
	tokens := make([]token, 0, len(merged))
	for _, part := range merged {
		switch {
		case modelAcronyms[strings.ToLower(part)] != "":
			tokens = append(tokens, token{modelAcronyms[strings.ToLower(part)], true})
		case strings.ContainsFunc(part, unicode.IsDigit):
			// Anything with a digit (versions, `4o`, `o3`) keeps its own casing.
			tokens = append(tokens, token{part, false})
		default:
			tokens = append(tokens, token{strings.ToUpper(part[:1]) + part[1:], false})
		}
	}

	var b strings.Builder
	for i, tok := range tokens {
		if i == 0 {
			b.WriteString(tok.text)
			continue
		}
		// Hyphenate the leading brand onto its version the way the vendors write
		// it — "GPT-5", "GLM-4.6" — but never a mid-id acronym+size like
		// "gpt-oss-120b" → "GPT OSS 120b".
		switch {
		case i == 1 && tokens[0].acronym && startsWithDigit(tok.text):
			b.WriteByte('-')
		default:
			b.WriteByte(' ')
		}
		b.WriteString(tok.text)
	}
	return b.String()
}

// FirstNonEmpty returns the first non-empty string, or "". Handy for
// "vendor display name, else derived" fallbacks when composing DisplayName.
func FirstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if !unicode.IsDigit(r) {
			return false
		}
	}
	return true
}

// isDottedVersion reports whether s is one or more digit runs joined by dots
// (`4`, `4.5`, `1.2.3`) — the shape numeric tokens accumulate into.
func isDottedVersion(s string) bool {
	if s == "" {
		return false
	}
	for _, part := range strings.Split(s, ".") {
		if !isDigits(part) {
			return false
		}
	}
	return true
}

func startsWithDigit(s string) bool {
	return s != "" && unicode.IsDigit(rune(s[0]))
}
