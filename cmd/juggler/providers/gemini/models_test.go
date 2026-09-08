//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gemini

import "testing"

// TestGetContextWindow pins the offline windows. Gemini's /v1beta/models does
// report inputTokenLimit, and ListModelsWithInfo prefers it — so this table is
// what answers when the list cannot be fetched, or for an id typed by hand.
//
// Google publishes 1048576 exactly, not a rounded 1000000, for every current
// text model.
func TestGetContextWindow(t *testing.T) {
	cases := []struct {
		model string
		want  int
	}{
		{"gemini-3.8-flash", 1048576},
		{"gemini-3.5-flash", 1048576},
		{"gemini-3.1-pro-preview", 1048576},
		{"gemini-2.5-pro", 1048576},
		{"gemini-2.5-flash", 1048576},
		// The API hands back ids carrying the collection prefix.
		{"models/gemini-3.8-flash", 1048576},
		{"gemini-4-unreleased", DefaultContextWindow},
	}
	for _, tc := range cases {
		if got := GetContextWindow(tc.model); got != tc.want {
			t.Errorf("GetContextWindow(%q) = %d, want %d", tc.model, got, tc.want)
		}
	}
}

// TestGetMaxOutputTokens pins the output ceiling every current Gemini text
// model shares. Without it, a listing that could not be fetched leaves the
// output limit unknown and admission falls back to a derived 20k reserve —
// less than a third of what these models will actually write.
func TestGetMaxOutputTokens(t *testing.T) {
	for _, model := range []string{
		"gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-2.5-pro", "models/gemini-3.1-pro-preview",
	} {
		if got := GetMaxOutputTokens(model); got != 65536 {
			t.Errorf("GetMaxOutputTokens(%q) = %d, want the documented 65536", model, got)
		}
	}
}

// TestRetiredModelsCarryNoPromise checks that the generations Google has shut
// down hold no catalog entry. Gemini 2.0 was switched off on 2026-06-01; 1.5
// and 1.0 are gone entirely, and 1.0's 32000 window is small enough that
// inheriting it would be actively harmful.
func TestRetiredModelsCarryNoPromise(t *testing.T) {
	for _, model := range []string{
		"gemini-2.0-flash", "gemini-2.0-flash-lite", "gemini-2.0-pro",
		"gemini-1.5-pro", "gemini-1.5-flash", "gemini-1.0-pro",
	} {
		if _, known := ModelContextWindows[model]; known {
			t.Errorf("%q still has a catalogued context window, but it cannot be called", model)
		}
	}
}

// TestSupportsImageInput is the one that matters beyond metadata: this
// classifier gates image conversion on every outbound turn (client.go), so a
// model it answers "no" for has its images silently stripped rather than
// merely mislabelled.
//
// It keyed on the literal strings "gemini-1.5" and "gemini-2", which answered
// no for every Gemini 3 model — the entire current line.
func TestSupportsImageInput(t *testing.T) {
	multimodal := []string{
		"gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.5-flash-lite",
		"gemini-3.1-pro-preview", "gemini-3-flash-preview",
		"models/gemini-3.8-flash", "gemini-2.5-pro", "gemini-2.5-flash",
		// A generation past this code's knowledge must not be reported
		// text-only: withholding images is the expensive direction of error.
		"gemini-4-flash", "gemini-5.2-pro",
	}
	for _, model := range multimodal {
		if !SupportsImageInput(model) {
			t.Errorf("SupportsImageInput(%q) = false, want true", model)
		}
	}
	textOnly := []string{"gemini-1.0-pro", "gemini-1.0-pro-latest", "gpt-4o", ""}
	for _, model := range textOnly {
		if SupportsImageInput(model) {
			t.Errorf("SupportsImageInput(%q) = true, want false", model)
		}
	}
}
