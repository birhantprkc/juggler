//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaibase

import "testing"

// TestMapOpenAIFinishReason pins the finish_reason → stop_reason mapping. The
// content_filter case is the one that matters: collapsing it into end_turn (the
// old default) made a filtered, often-empty completion indistinguishable from a
// clean finish.
func TestMapOpenAIFinishReason(t *testing.T) {
	cases := map[string]string{
		"stop":           "end_turn",
		"tool_calls":     "tool_use",
		"function_call":  "tool_use",
		"length":         "max_tokens",
		"content_filter": "content_filter",
		"":               "end_turn",
		"something_new":  "end_turn", // unknown → benign default
	}
	for in, want := range cases {
		if got := mapOpenAIFinishReason(in); got != want {
			t.Errorf("mapOpenAIFinishReason(%q) = %q, want %q", in, got, want)
		}
	}
}
