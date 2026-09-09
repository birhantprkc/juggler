//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaibase

import (
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

// TestMapOpenAIFinishReason pins the finish_reason → stop_reason mapping. The
// content_filter case is the one that matters: collapsing it into end_turn (the
// old default) made a filtered, often-empty completion indistinguishable from a
// clean finish.
func TestMapOpenAIFinishReason(t *testing.T) {
	cases := map[string]provider.StopReason{
		"stop":           provider.StopReasonEndTurn,
		"tool_calls":     provider.StopReasonToolUse,
		"function_call":  provider.StopReasonToolUse,
		"length":         provider.StopReasonMaxTokens,
		"content_filter": provider.StopReasonContentFilter,
		"":               provider.StopReasonEndTurn,
		"something_new":  provider.StopReasonEndTurn, // unknown → benign default
	}
	for in, want := range cases {
		if got := mapOpenAIFinishReason(in); got != want {
			t.Errorf("mapOpenAIFinishReason(%q) = %q, want %q", in, got, want)
		}
	}
}
