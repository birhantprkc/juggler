//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openai

import "testing"

// TestAstraCapsAreDeclared covers the Platform API's gen-6 flagship. OpenAI's
// /v1/models says nothing about limits, so an id missing from these tables runs
// at the last-resort defaults — 128000 against a documented 1050000 window, and
// 16384 against 128000 of output. That is not a visible failure: the model
// works and quietly compacts about eight times sooner than it needed to.
func TestAstraCapsAreDeclared(t *testing.T) {
	window, ok := contextWindowCaps.LookupKnown("gpt-6-astra")
	if !ok {
		t.Fatal("gpt-6-astra has no declared context window, so it would run at the 128000 default")
	}
	if window != 1050000 {
		t.Errorf("gpt-6-astra context window = %d, want the documented 1050000", window)
	}
	output, ok := maxOutputCaps.LookupKnown("gpt-6-astra")
	if !ok {
		t.Fatal("gpt-6-astra has no declared max output, so it would run at the 16384 default")
	}
	if output != 128000 {
		t.Errorf("gpt-6-astra max output = %d, want the documented 128000", output)
	}
}

// TestGPT5xCapsAreDeclared covers the generations between the gpt-5 line and
// 5.6. They are niche now, but a model missing from these tables is not merely
// unlisted — it runs at 128000 against a documented window eight times that,
// and compacts a conversation that had most of its room left.
func TestGPT5xCapsAreDeclared(t *testing.T) {
	for _, tc := range []struct {
		model  string
		window int
		output int
	}{
		{"gpt-5.4", 1050000, 128000},
		{"gpt-5.4-mini", 400000, 128000},
		{"gpt-5.5", 1050000, 128000},
	} {
		window, ok := contextWindowCaps.LookupKnown(tc.model)
		if !ok || window != tc.window {
			t.Errorf("%s context window = %d (declared: %v), want %d", tc.model, window, ok, tc.window)
		}
		output, ok := maxOutputCaps.LookupKnown(tc.model)
		if !ok || output != tc.output {
			t.Errorf("%s max output = %d (declared: %v), want %d", tc.model, output, ok, tc.output)
		}
	}
}

// TestVisionFollowsGeneration pins image support as a generation comparison
// rather than a list of prefixes, so a model id newer than this code is not
// reported text-only — which silently strips the images off a turn.
func TestVisionFollowsGeneration(t *testing.T) {
	for _, model := range []string{"gpt-6-astra", "gpt-6", "gpt-7-somecodename", "gpt-5.6-sol", "gpt-5", "gpt-4o", "gpt-4.1", "o4-mini", "o3"} {
		if !supportsVision(model) {
			t.Errorf("supportsVision(%q) = false, want true", model)
		}
	}
	for _, model := range []string{"gpt-4", "gpt-3.5-turbo", "o1-mini", "o3-mini", "gpt-oss-120b"} {
		if supportsVision(model) {
			t.Errorf("supportsVision(%q) = true, want false (text-only)", model)
		}
	}
	if got := inputModalities("gpt-6-astra"); len(got) != 2 || got[0] != "text" || got[1] != "image" {
		t.Errorf("inputModalities(gpt-6-astra) = %v, want [text image]", got)
	}
}
