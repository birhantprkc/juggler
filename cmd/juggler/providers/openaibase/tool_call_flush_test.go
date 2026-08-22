//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaibase

import (
	"strings"
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

// TestFlushToolCalls_NonContiguousIndicesAllEmitted guards against the regression
// where flushToolCalls iterated 0..len-1, silently dropping tool calls whose
// streamed index is non-contiguous (e.g. {0, 2, 5}). OpenAI itself happens to
// stream contiguous indices, but other openaibase-derived providers
// may stream sparsely.
func TestFlushToolCalls_NonContiguousIndicesAllEmitted(t *testing.T) {
	buffers := map[int]*toolCallAccumulator{
		0: {id: "a", name: "tool_a", argsBuilder: stringsBuilderWith(`{"x":1}`)},
		2: {id: "b", name: "tool_b", argsBuilder: stringsBuilderWith(`{"y":2}`)},
		5: {id: "c", name: "tool_c", argsBuilder: stringsBuilderWith(`{"z":3}`)},
	}

	var seen []string
	cb := func(chunk provider.StreamChunk) (*provider.ToolResult, error) {
		if chunk.Type == provider.ContentBlockTypeToolUse {
			seen = append(seen, chunk.ToolUseID)
		}
		return nil, nil
	}

	if err := flushToolCalls(buffers, cb); err != nil {
		t.Fatalf("flushToolCalls: %v", err)
	}
	if len(seen) != 3 {
		t.Fatalf("expected 3 tool-use blocks emitted, got %d (%v)", len(seen), seen)
	}
	// Order must be by ascending index for deterministic provider→model semantics.
	want := []string{"a", "b", "c"}
	for i, id := range want {
		if seen[i] != id {
			t.Fatalf("expected ordered emission %v, got %v", want, seen)
		}
	}
}

func TestFlushToolCalls_EmptyBuffersEmitsNothing(t *testing.T) {
	called := 0
	cb := func(chunk provider.StreamChunk) (*provider.ToolResult, error) {
		called++
		return nil, nil
	}
	if err := flushToolCalls(map[int]*toolCallAccumulator{}, cb); err != nil {
		t.Fatal(err)
	}
	if called != 0 {
		t.Fatalf("expected no callback invocations, got %d", called)
	}
}

func stringsBuilderWith(s string) strings.Builder {
	var b strings.Builder
	b.WriteString(s)
	return b
}
