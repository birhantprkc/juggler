//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaibase

import (
	"encoding/json"
	"strings"
	"testing"

	provider "juggler/cmd/juggler/providers/registry"

	"github.com/openai/openai-go/v3"
)

// reasoningTurn is a representative thinking+text+tool-call assistant turn:
// DeepSeek streams chain-of-thought, then a tool call. The continuation request
// that carries the tool result back must replay the reasoning or DeepSeek's
// thinking mode 400s with "The reasoning_content ... must be passed back".
func reasoningTurn() []provider.Message {
	return []provider.Message{
		{Type: "user", Content: "What's the weather?"},
		{Type: "thinking", Content: "The user wants weather; I should call the tool."},
		{Type: "assistant", Content: "Let me check."},
		{Type: "tool-use", ToolUseID: "call_1", ToolName: "get_weather", ToolInput: map[string]any{"city": "SF"}},
		{Type: "tool-result", ToolUseID: "call_1", Content: "sunny"},
	}
}

// assistantJSON marshals the first assistant message in the transformed set so
// tests can assert on the exact wire shape (including non-modeled extra fields).
func assistantJSON(t *testing.T, msgs []openai.ChatCompletionMessageParamUnion) string {
	t.Helper()
	for _, m := range msgs {
		if m.OfAssistant != nil {
			data, err := json.Marshal(m)
			if err != nil {
				t.Fatalf("marshal assistant message: %v", err)
			}
			return string(data)
		}
	}
	t.Fatal("no assistant message found in transformed set")
	return ""
}

// TestEchoReasoningContentReplaysThinking proves that with the quirk enabled the
// assistant turn carries reasoning_content back on the wire (DeepSeek thinking
// mode requires it), alongside the normal content and tool_calls.
func TestEchoReasoningContentReplaysThinking(t *testing.T) {
	msgs := transformMessages(reasoningTurn(), false, true, "")
	got := assistantJSON(t, msgs)

	if !strings.Contains(got, `"reasoning_content":"The user wants weather; I should call the tool."`) {
		t.Fatalf("reasoning_content not replayed on assistant turn; got %s", got)
	}
	// The reasoning must not clobber the real answer or the tool call.
	if !strings.Contains(got, `"content":"Let me check."`) {
		t.Fatalf("assistant content missing; got %s", got)
	}
	if !strings.Contains(got, `"tool_calls"`) {
		t.Fatalf("tool_calls missing; got %s", got)
	}
}

// TestEchoReasoningContentDisabledDropsThinking proves the default (every vendor
// but DeepSeek) still omits reasoning_content — replaying it to OpenAI/OpenRouter
// is at best ignored and at worst rejected.
func TestEchoReasoningContentDisabledDropsThinking(t *testing.T) {
	msgs := transformMessages(reasoningTurn(), false, false, "")
	got := assistantJSON(t, msgs)

	if strings.Contains(got, "reasoning_content") {
		t.Fatalf("reasoning_content leaked with echo disabled; got %s", got)
	}
	if !strings.Contains(got, `"content":"Let me check."`) {
		t.Fatalf("assistant content missing; got %s", got)
	}
}
