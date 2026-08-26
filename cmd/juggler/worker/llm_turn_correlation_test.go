//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"testing"
	"time"

	"juggler/cmd/juggler/providers/provider"
)

func TestWaitForLLMResponseRejectsStaleAttemptResult(t *testing.T) {
	w := NewConversationWorker("conv-result-generation", "user:test")
	t.Cleanup(func() { w.doc.Destroy() })

	want := &LLMResponse{StopReason: "current"}
	go func() {
		w.turn.responseChan <- llmCallResult{TurnID: "stale", Response: &LLMResponse{StopReason: "stale"}}
		w.turn.responseChan <- llmCallResult{TurnID: "current", Response: want}
	}()

	got, err := w.waitForLLMResponse("current", time.Second)
	if err != nil {
		t.Fatalf("waitForLLMResponse: %v", err)
	}
	if got != want {
		t.Fatalf("wait returned stale attempt response: got %#v, want %#v", got, want)
	}
}

func TestCoalescedStreamRejectsStaleAttemptChunks(t *testing.T) {
	w := NewConversationWorker("conv-chunk-generation", "user:test")
	t.Cleanup(func() { w.doc.Destroy() })

	w.streamChunkChan <- StreamChunk{TurnID: "current", Type: provider.ContentBlockTypeText, Content: "current"}
	w.processCoalescedStreamChunks("current", StreamChunk{
		TurnID:  "stale",
		Type:    provider.ContentBlockTypeText,
		Content: "stale",
	})
	w.flushPendingStreamWrites()

	items := w.doc.GetItems()
	if len(items) != 1 || items[0].Content != "current" {
		t.Fatalf("stream content = %#v, want only current attempt", items)
	}
}

func TestMockLLMUsesFreshAttemptGeneration(t *testing.T) {
	w := NewConversationWorker("conv-mock-generation", "user:test")
	t.Cleanup(func() { w.doc.Destroy() })
	w.setMockResponses([]MockResponse{
		{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "one"}}},
		{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "two"}}},
	})

	var generations []string
	sink := func(chunk StreamChunk) { generations = append(generations, chunk.TurnID) }
	if _, err := w.callLLMWithSink(nil, sink); err != nil {
		t.Fatalf("first mock call: %v", err)
	}
	if _, err := w.callLLMWithSink(nil, sink); err != nil {
		t.Fatalf("second mock call: %v", err)
	}

	if len(generations) != 2 || generations[0] == "" || generations[1] == "" || generations[0] == generations[1] {
		t.Fatalf("mock attempt generations = %#v, want two distinct non-empty ids", generations)
	}
}
