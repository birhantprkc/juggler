//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"strings"
	"testing"

	"juggler/cmd/juggler/worker"
)

func TestSanitizeAutoName(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{"plain", "Fix login bug", "Fix login bug"},
		{"trims space", "   Add dark mode   ", "Add dark mode"},
		{"strips straight quotes", `"Refactor auth layer"`, "Refactor auth layer"},
		{"strips single quotes", `'Cleanup CI'`, "Cleanup CI"},
		{"strips curly quotes", "\u201cShip the release\u201d", "Ship the release"},
		{"first line only", "Update parser\nand also the lexer", "Update parser"},
		{"skips leading blank lines", "\n\n  Wire up webhooks", "Wire up webhooks"},
		{"collapses whitespace", "Set   up\tCI   pipeline", "Set up CI pipeline"},
		{"trims trailing punctuation", "Investigate flaky test.", "Investigate flaky test"},
		{"empty", "", ""},
		{"whitespace only", "   \n\t ", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := sanitizeAutoName(tt.in); got != tt.want {
				t.Fatalf("sanitizeAutoName(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestSanitizeAutoNameCapsLength(t *testing.T) {
	long := strings.Repeat("word ", 40) // far over the cap
	got := sanitizeAutoName(long)
	if n := len([]rune(got)); n > autoNameMaxLen {
		t.Fatalf("sanitized length = %d runes, want <= %d", n, autoNameMaxLen)
	}
	if got == "" {
		t.Fatal("expected a non-empty truncated title")
	}
}

func TestTruncateRunesMultibyte(t *testing.T) {
	// Ensure a multibyte string isn't split mid-rune and stays within the cap.
	in := strings.Repeat("é", 10)
	got := truncateRunes(in, 4)
	if n := len([]rune(got)); n > 4 {
		t.Fatalf("truncateRunes kept %d runes, want <= 4", n)
	}
	if !strings.HasPrefix(in, got) {
		t.Fatalf("truncateRunes(%q) = %q, not a prefix", in, got)
	}
}

func TestAcceptableAutoName(t *testing.T) {
	good := []string{
		"Fix login bug",
		"Add dark mode toggle",
		"Refactor auth layer",
		"Investigate flaky CI test",
		"Wire up webhooks",
		"Import CSV parser rewrite", // starts with a legit word, not a preamble
	}
	bad := []string{
		"",
		// The exact real-world failure: a conversational reply, truncated.
		"I'd be happy to help organize those changes into",
		"I'll take a look at that for you",
		"I'm on it right away",
		"Sure, let's get started on this",
		"Here's a summary of the task",
		"Let me help you with that",
		"Of course I can do that",
		"Okay so what you want is a new parser",
		// A full sentence: too many words even without a preamble.
		"This title clearly runs well past any sensible tab label length here",
	}
	for _, g := range good {
		if !acceptableAutoName(g) {
			t.Errorf("expected %q to be acceptable", g)
		}
	}
	for _, b := range bad {
		if acceptableAutoName(b) {
			t.Errorf("expected %q to be rejected", b)
		}
	}
}

// TestNameIsProvisionalWithoutLoadedWorker pins the "can't tell ⇒ don't rename" reading
// of the auto-namer's guard. The marker lives in the conversation's doc, so only
// a loaded worker can answer; with no worker manager at all, or no worker for the
// id, the guard must refuse rather than rename a name it cannot inspect.
func TestNameIsProvisionalWithoutLoadedWorker(t *testing.T) {
	if (&Server{}).isProvisionalName("conv_missing1") {
		t.Error("isProvisionalName = true with no worker manager, want false")
	}

	wm := worker.NewManager()
	t.Cleanup(wm.Shutdown)
	if (&Server{workerManager: wm}).isProvisionalName("conv_missing2") {
		t.Error("isProvisionalName = true for a conversation with no loaded worker, want false")
	}
}
