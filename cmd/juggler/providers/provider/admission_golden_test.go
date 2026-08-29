//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package provider

import (
	"strings"
	"testing"
)

// goldenCorpus pins the estimator against an independent oracle. Expected
// counts were generated offline with tiktoken cl100k_base (the GPT-4 family
// BPE), 2026-07-18; regenerate by encoding each sample with any cl100k_base
// implementation. The oracle is independent: changing the estimator cannot
// silently change the expected values with it.
var goldenCorpus = []struct {
	name         string
	text         string
	cl100kTokens int64
}{
	{"single word", "text", 1},
	{"short sentence", "Hello, world!", 4},
	{"CJK common", "翻译中文", 7},
	{"CJK rare glyphs", "龘驫麤鱻", 10},
	{"CJK paragraph", "人工智能正在改变软件开发的方式，但上下文窗口仍然是有限的资源。", 31},
	{"mixed CJK/EN", "上下文 window 是 finite 的", 7},
	{"katakana", "コンテキストウィンドウ", 10},
	{"korean", "컨텍스트 창이 유한합니다", 13},
	{"go one-liner", `func main() { fmt.Println("hello") }`, 10},
	{"go code block", `func handleRequest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req Request
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	fmt.Fprintf(w, "ok: %s", req.ID)
}`, 92},
	{"small json", `{"path":"internal/agent/agent.go","line":698}`, 14},
	{"tool call json", `{"tool":"replace_text","input":{"path":"web/js/model/document.js","old":"function render(items){return items.map(renderItem)}","new":"function render(items){return items.filter(Boolean).map(renderItem)}"},"options":{"createBackup":true,"validateSyntax":true}}`, 57},
	{"url", "https://github.com/charmbracelet/crush/pull/3280", 15},
	{"snake_case", "snake_case_identifier_with_many_parts", 6},
	{"formatted number", "1,234,567.89", 7},
	{"punctuation run", strings.Repeat("!", 32), 4},
	{"replacement char run", strings.Repeat("\uFFFD", 48), 12},
	{"bracket wall", strings.Repeat("[", 64), 32},
	{"quote run", strings.Repeat("\"", 8), 4},
	{"dash rule", strings.Repeat("-", 64), 1},
	{"deeply nested json", strings.Repeat(`{"a":`, 30) + "1" + strings.Repeat("}", 30), 77},
	{"deeply nested arrays", strings.Repeat("[[[", 40) + "1" + strings.Repeat("]]]", 40), 121},
	{"emoji", "😀🧪🚀🫠", 11},
	{"emoji zwj sequence", "👨‍👩‍👧‍👦🏳️‍🌈", 27},
	{"combining mark", "café", 3},
	{"accented words", "naïve façade résumé", 8},
	{"hex blob", strings.Repeat("deadbeef", 125), 375},
	{"base64 blob", strings.Repeat("QWxhZGRpbjpvcGVuIHNlc2FtZQ==", 36), 720},
	{"single char run", strings.Repeat("a", 5000), 625},
	{"adversarial alnum pairs", strings.Repeat("x9", 2000), 4000},
	{"adversarial alnum soup", strings.Repeat("qZ7wK2pX9mR4vB8nJ3hF6dS1gT5yL0cM", 50), 1600},
	{"prose", strings.Repeat("the quick brown fox jumps over the lazy dog. ", 40), 401},
	{"mixed whitespace", strings.Repeat(" \t\n", 100), 100},
	{"space run", strings.Repeat("    ", 25), 2},
	{"markdown", "# Context Windows\n\nEvery model has a **finite** context window. Juggler keeps requests inside it:\n\n- provider-reported limits are definitive\n- conservative local estimation before each call\n- automatic recovery by summarizing the oldest history\n\n> The output reserve is charged against the window before sending.\n\n`estimate + reserve <= window` must hold, or the call is not made.", 76},
	{"technical prose", "The bounded reducer splits the canonical transcript into chunks that\neach fit the reduced window, summarizes every chunk with a hidden map call,\nthen reduces the partial summaries across passes until one final call fits.\nPasses, calls, and estimated spend are bounded; partial accounting survives\nfailure and cancellation so the operation always leaves diagnostics.", 64},
}

// TestApproximateTokenCountNeverUndercountsGoldenCorpus is a heuristic-quality
// tripwire, not an admission safety proof. Under-counting may cause a provider
// rejection (or silent truncation without the future guard), while over-counting
// may trigger earlier planning; neither estimate is authoritative.
func TestApproximateTokenCountNeverUndercountsGoldenCorpus(t *testing.T) {
	for _, sample := range goldenCorpus {
		if est := approximateTokenCount(sample.text); est < sample.cl100kTokens {
			t.Errorf("%s: estimate %d under-counts cl100k %d for %.40q", sample.name, est, sample.cl100kTokens, sample.text)
		}
	}
}

// maxOvercountRatio is the calibration target: how far above cl100k each
// sample class is allowed to estimate. The corpus above is measured truth; this
// is policy, kept separate so tuning a rate never edits the oracle.
//
// Bounds sit just above what the estimator currently produces, so any change
// that worsens a class fails here and has to be argued for rather than absorbed
// silently. That matters because the ratio is not cosmetic: automatic
// compaction fires on this estimate whenever admission cannot anchor to a
// provider-reported count, and the recovery ladder picks which history to fold
// by comparing these same per-item numbers. An estimator that runs 2x hot
// compacts a conversation at half the window it really has.
//
// The rates cannot be lowered uniformly to chase these down. Several samples
// sit at exactly 1.00 — "adversarial alnum pairs" and "adversarial alnum soup"
// pin the >16-char rule at one token per byte, "formatted number" pins mixed
// punctuation at one token per rune, and "deeply nested arrays" and "bracket
// wall" pin identical-punctuation runs at 0.5/char. Those are measured maxima
// in real BPE, and cutting them would undercount, which is the one direction
// this estimator must never take (see the never-undercount test above).
//
// The loose entries are degenerate by construction rather than sloppy: long
// runs of one repeated character merge almost completely in a real vocabulary
// ("-"x64 is a single token) and no run-length heuristic can model that without
// undercounting the adversarial cases it also has to cover.
var maxOvercountRatio = map[string]float64{
	// Degenerate single-character runs: charged far above any real tokenizer.
	"dash rule":       34.0,
	"space run":       26.0,
	"single char run": 8.5,
	"punctuation run": 4.5,

	// Opaque and non-ASCII content, charged at provable per-byte maxima.
	"replacement char run":    4.25,
	"katakana":                3.5,
	"mixed CJK/EN":            3.2,
	"CJK paragraph":           3.2,
	"korean":                  2.9,
	"hex blob":                2.8,
	"CJK common":              1.9,
	"emoji":                   1.6,
	"emoji zwj sequence":      1.6,
	"base64 blob":             1.6,
	"CJK rare glyphs":         1.4,
	"combining mark":          1.2,
	"accented words":          1.9,
	"adversarial alnum pairs": 1.2,
	"adversarial alnum soup":  1.2,

	// Structured content: punctuation density is what keeps these above prose.
	"snake_case":           3.3,
	"tool call json":       2.6,
	"deeply nested json":   2.3,
	"go code block":        2.3,
	"go one-liner":         2.3,
	"small json":           2.1,
	"url":                  1.8,
	"quote run":            1.4,
	"bracket wall":         1.2,
	"deeply nested arrays": 1.2,
	"formatted number":     1.2,

	// Prose and markdown: the classes an agent transcript is mostly made of.
	"single word":      2.2,
	"technical prose":  2.1,
	"markdown":         2.1,
	"mixed whitespace": 1.7,
	"short sentence":   1.7,
	"prose":            1.7,
}

func TestApproximateTokenCountOvercountStaysWithinCalibration(t *testing.T) {
	for _, sample := range goldenCorpus {
		bound, ok := maxOvercountRatio[sample.name]
		if !ok {
			t.Errorf("%s: no calibration bound declared; add one to maxOvercountRatio", sample.name)
			continue
		}
		est := approximateTokenCount(sample.text)
		if ratio := float64(est) / float64(sample.cl100kTokens); ratio > bound {
			t.Errorf("%s: estimate %d is %.2fx cl100k %d, above the %.2fx bound", sample.name, est, ratio, sample.cl100kTokens, bound)
		}
	}
}

// A single space before a word is carried inside the word's token in BPE
// vocabularies, so charging the separator too double-counts every word boundary
// — the largest single source of drift against cl100k on prose. Runs of
// two or more spaces are real tokens, and a trailing space has no word to be
// absorbed into, so both stay charged.
func TestApproximateTokenCountAbsorbsSingleWordSeparators(t *testing.T) {
	for _, tc := range []struct {
		name string
		text string
		want int64
	}{
		{"lone separator is absorbed by the following word", "ab cd", 2},
		{"no separator costs the same", "abcd", 2},
		{"a doubled separator is charged", "ab  cd", 3},
		{"a trailing separator is charged", "ab ", 2},
		{"a separator before punctuation is charged", "ab .", 3},
		{"a lone space is still a token", " ", 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := approximateTokenCount(tc.text); got != tc.want {
				t.Errorf("approximateTokenCount(%q) = %d, want %d", tc.text, got, tc.want)
			}
		})
	}
}
