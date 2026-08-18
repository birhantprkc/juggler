//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// Streaming assembly: a streamed turn lands as one message per block, updates
// the right message, survives long content, and surfaces status chunks.

// TestStreamingNoDuplicateMessages verifies that streaming text chunks followed
// by the final LLM response does NOT create duplicate assistant messages.
//
// This test catches the bug where:
// 1. Streaming chunks create/update an assistant message via processStreamChunk
// 2. A tool_use chunk arrives, triggering finalizeStreaming() via default case
// 3. processLLMResponse then adds ANOTHER assistant message for the same content
//
// Expected: Only ONE assistant message with accumulated content "Hello world!"
func TestStreamingNoDuplicateMessages(t *testing.T) {
	// Create worker directly (not through manager, to avoid async issues)
	w := NewConversationWorker("test-conv", "user:test")

	// Simulate streaming text chunks
	// These should all accumulate into a SINGLE assistant message
	w.processStreamChunk(StreamChunk{Type: "text", Content: "Hello"})
	w.processStreamChunk(StreamChunk{Type: "text", Content: " world"})
	w.processStreamChunk(StreamChunk{Type: "text", Content: "!"})

	// Verify streaming created exactly ONE message
	items := w.doc.GetItems()
	if len(items) != 1 {
		t.Errorf("After streaming: expected 1 item, got %d", len(items))
		for i, item := range items {
			t.Logf("  Item %d: type=%s content=%q", i, item.Type, item.Content)
		}
	}

	// Verify content was accumulated
	if len(items) > 0 && items[0].Content != "Hello world!" {
		t.Errorf("Streaming content: expected 'Hello world!', got %q", items[0].Content)
	}

	// CRITICAL: Simulate a tool_use chunk arriving after text streaming
	// This triggers the "default" case in processStreamChunk which calls finalizeStreaming()
	// and clears streamingTextMessageID - THIS IS WHERE THE BUG MANIFESTS
	w.processStreamChunk(StreamChunk{Type: "tool_use"})

	// Verify streaming was finalized (IDs cleared)
	if w.streaming.textMsgID != "" {
		t.Error("streaming.textMsgID should be cleared after tool_use chunk")
	}

	// Now simulate the final LLM response (which contains the same text)
	// This is what the LLM sends after streaming completes
	response := &LLMResponse{
		Blocks: []LLMResponseBlock{
			{Type: "text", Content: "Hello world!"},
		},
		StopReason: "end_turn",
	}

	// Process the response - this should NOT add duplicate messages
	shouldContinue, err := w.processLLMResponse(response)
	if err != nil {
		t.Fatalf("processLLMResponse failed: %v", err)
	}
	if shouldContinue {
		t.Error("Expected shouldContinue=false for end_turn")
	}

	// CRITICAL ASSERTION: Still only ONE assistant message
	items = w.doc.GetItems()
	if len(items) != 1 {
		t.Errorf("After processLLMResponse: expected 1 item, got %d", len(items))
		for i, item := range items {
			t.Logf("  Item %d: type=%s content=%q", i, item.Type, item.Content)
		}
		t.Fatal("BUG: Duplicate messages created!")
	}

	// Verify the message content is correct
	if items[0].Type != ItemTypeAssistant {
		t.Errorf("Expected assistant message, got type=%s", items[0].Type)
	}
	if items[0].Content != "Hello world!" {
		t.Errorf("Expected content 'Hello world!', got %q", items[0].Content)
	}

	w.doc.Destroy()
	t.Log("SUCCESS: No duplicate messages after streaming + response")
}

// TestMultipleTextBlocksNoDuplicates verifies that multiple text blocks
// (text → tool_use → text) are handled correctly without duplicates.
//
// This tests the fix for the bug where streamingTextContent accumulated across
// ALL text blocks instead of resetting for each new block.
func TestMultipleTextBlocksNoDuplicates(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")

	// First text block: "Hello"
	w.processStreamChunk(StreamChunk{Type: "text", Content: "Hello"})

	// Verify first message created
	items := w.doc.GetItems()
	if len(items) != 1 {
		t.Fatalf("After first text block: expected 1 item, got %d", len(items))
	}
	if items[0].Content != "Hello" {
		t.Errorf("First message content: expected 'Hello', got %q", items[0].Content)
	}

	// tool_use chunk arrives - this triggers finalizeStreaming via default case
	w.processStreamChunk(StreamChunk{Type: "tool_use"})

	// Verify streaming was finalized
	if w.streaming.textMsgID != "" {
		t.Error("streaming.textMsgID should be cleared after tool_use")
	}

	// Second text block: "World"
	w.processStreamChunk(StreamChunk{Type: "text", Content: "World"})

	// Verify second message was created correctly
	items = w.doc.GetItems()
	if len(items) != 2 {
		t.Fatalf("After second text block: expected 2 items, got %d", len(items))
	}

	// CRITICAL: Second message should have "World", not "HelloWorld" —
	// streamingTextContent must reset per block, not accumulate across them.
	if items[1].Content != "World" {
		t.Errorf("Second message content: expected 'World', got %q (bug: accumulated from previous block)", items[1].Content)
	}

	// Now simulate final LLM response with both text blocks (no tool_use to avoid waiting)
	// In practice, tool_use would be processed separately, but for this test we only
	// need to verify that text blocks are deduplicated correctly
	response := &LLMResponse{
		Blocks: []LLMResponseBlock{
			{Type: "text", Content: "Hello"},
			{Type: "text", Content: "World"},
		},
		StopReason: "end_turn",
	}

	// Process the response - should NOT add duplicate messages
	_, err := w.processLLMResponse(response)
	if err != nil {
		t.Fatalf("processLLMResponse failed: %v", err)
	}

	// CRITICAL: Still only 2 assistant messages (no duplicates)
	items = w.doc.GetItems()

	// Count assistant messages
	assistantCount := 0
	for _, item := range items {
		if item.Type == ItemTypeAssistant {
			assistantCount++
			t.Logf("Assistant message: %q", item.Content)
		}
	}

	if assistantCount != 2 {
		t.Errorf("After processLLMResponse: expected 2 assistant messages, got %d", assistantCount)
		for i, item := range items {
			t.Logf("  Item %d: type=%s content=%q", i, item.Type, item.Content)
		}
		t.Fatal("BUG: Duplicate messages created for multiple text blocks!")
	}

	w.doc.Destroy()
	t.Log("SUCCESS: Multiple text blocks handled correctly without duplicates")
}

// TestStreamingUpdatesCorrectMessage verifies that streaming from a NEW LLM response
// creates a NEW message after the user message, not updating an OLD assistant message.
//
// This test catches the bug where:
// 1. Previous turn ends with text streaming (streamingTextMessageID = "old-msg")
// 2. User sends new message
// 3. New LLM response starts streaming
// 4. BUT streamingTextMessageID was never cleared!
// 5. First chunks UPDATE the old message (before user message) instead of creating new
//
// The fix: runStrategyLoop must call finalizeStreaming() before starting.
func TestStreamingUpdatesCorrectMessage(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")

	// Turn 1: Simulate previous conversation ending with text streaming
	// The key is that streaming.textMsgID is still set (not cleared)
	w.streaming.textMsgID = "old-assistant-msg"
	oldAssistantMsg := ConversationItem{
		Type:    ItemTypeAssistant,
		ItemID:  "old-assistant-msg",
		Content: "Previous response",
	}
	w.tracker.InsertMessage(0, oldAssistantMsg)

	// Turn 2: New user message arrives. finalizeStreaming() clears
	// streamingTextMessageID so new streaming creates a new message rather
	// than updating the previous turn's assistant message.
	w.finalizeStreaming()

	userMsg := ConversationItem{
		Type:    ItemTypeUser,
		ItemID:  "user-1",
		Content: "New question",
	}
	w.tracker.InsertMessage(w.doc.GetItemsLength(), userMsg)

	// Verify state before new LLM response
	items := w.doc.GetItems()
	if len(items) != 2 {
		t.Fatalf("Expected 2 items before LLM response, got %d", len(items))
	}
	t.Logf("Before new LLM response: [%s: %q, %s: %q]",
		items[0].Type, items[0].Content, items[1].Type, items[1].Content)

	// First text chunk of the new LLM response must create a new message,
	// not update "old-assistant-msg".
	w.processTextChunk(StreamChunk{Type: "text", Content: "New response"})

	// Verify order: should be [old-assistant, user, new-assistant]
	items = w.doc.GetItems()
	t.Logf("After streaming: %d items", len(items))
	for i, item := range items {
		t.Logf("  Item %d: type=%s msgId=%s content=%q", i, item.Type, item.ItemID, item.Content)
	}

	if len(items) != 3 {
		t.Fatalf("Expected 3 items (old assistant, user, new assistant), got %d", len(items))
	}

	// First item: should be OLD assistant with UNCHANGED content
	if items[0].Type != ItemTypeAssistant {
		t.Errorf("First item should be assistant, got %s", items[0].Type)
	}
	if items[0].Content != "Previous response" {
		t.Errorf("First item (old assistant) should have unchanged content 'Previous response', got %q (BUG: new content was written here!)", items[0].Content)
	}
	if items[0].ItemID != "old-assistant-msg" {
		t.Errorf("First item should have old message ID")
	}

	// Second item: should be user message
	if items[1].Type != ItemTypeUser {
		t.Errorf("Second item should be user, got %s", items[1].Type)
	}

	// Third item: should be NEW assistant with new content
	if items[2].Type != ItemTypeAssistant {
		t.Errorf("Third item should be assistant, got %s", items[2].Type)
	}
	if items[2].Content != "New response" {
		t.Errorf("Third item (new assistant) should have 'New response', got %q", items[2].Content)
	}
	if items[2].ItemID == "old-assistant-msg" {
		t.Errorf("Third item should have NEW message ID, not old one")
	}

	w.doc.Destroy()
	t.Log("SUCCESS: New streaming creates new message after user message")
}

// generateLongText builds a deterministic string of the given word count.
func generateLongText(wordCount int) string {
	words := []string{
		"The", "quick", "brown", "fox", "jumps", "over", "the", "lazy", "dog.",
		"Pack", "my", "box", "with", "five", "dozen", "liquor", "jugs.",
		"How", "vexingly", "quick", "daft", "zebras", "jump.",
	}
	var b strings.Builder
	for i := 0; i < wordCount; i++ {
		if i > 0 {
			b.WriteByte(' ')
		}
		b.WriteString(words[i%len(words)])
	}
	return b.String()
}

// TestStreamingLongMessageIntact verifies that a long message streamed
// word-by-word through the real channel path arrives without any dropped content.
func TestStreamingLongMessageIntact(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	fullText := generateLongText(500)
	wordsInText := strings.Fields(fullText)

	// llmCallFunc streams one word per chunk (simulates real LLM token streaming).
	// The callback IS queueStreamChunk — same path as production.
	w.llmCallFunc = func(ctx context.Context, request json.RawMessage, chunkHandler func(StreamChunk)) (*LLMResponse, error) {
		for i, word := range wordsInText {
			tok := word
			if i > 0 {
				tok = " " + word
			}
			chunkHandler(StreamChunk{Type: "text", Content: tok})
		}
		return &LLMResponse{
			Blocks:     []LLMResponseBlock{{Type: "text", Content: fullText}},
			StopReason: "end_turn",
		}, nil
	}

	// callLLM spawns the provider goroutine and enters waitForLLMResponse,
	// which processes chunks from the inbound channel on THIS goroutine.
	_, err := w.callLLM(nil)
	if err != nil {
		t.Fatalf("callLLM failed: %v", err)
	}

	items := w.doc.GetItems()
	if len(items) != 1 {
		t.Fatalf("Expected 1 item, got %d", len(items))
	}

	got := items[0].Content
	if got != fullText {
		// Find first divergence point for a useful error message
		minLen := len(got)
		if len(fullText) < minLen {
			minLen = len(fullText)
		}
		diffPos := minLen // assume divergence is at the end (length mismatch)
		for i := 0; i < minLen; i++ {
			if got[i] != fullText[i] {
				diffPos = i
				break
			}
		}
		t.Errorf("Content mismatch (expected %d bytes, got %d bytes, first diff at byte %d)",
			len(fullText), len(got), diffPos)
		// Show a window around the divergence
		start := diffPos - 20
		if start < 0 {
			start = 0
		}
		endE := diffPos + 40
		if endE > len(fullText) {
			endE = len(fullText)
		}
		endG := diffPos + 40
		if endG > len(got) {
			endG = len(got)
		}
		t.Errorf("  expected[%d:%d]: %q", start, endE, fullText[start:endE])
		t.Errorf("  got     [%d:%d]: %q", start, endG, got[start:endG])
	}
}

// TestStreamingNoBottleneck verifies that once the LLM provider has finished
// sending all chunks, the worker processes them without unnecessary delay.
// A slow pipeline would mean the worker is still trickling through chunks
// long after the provider goroutine has returned.
func TestStreamingNoBottleneck(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	fullText := generateLongText(500)
	wordsInText := strings.Fields(fullText)

	var providerDone time.Time

	w.llmCallFunc = func(ctx context.Context, request json.RawMessage, chunkHandler func(StreamChunk)) (*LLMResponse, error) {
		for i, word := range wordsInText {
			tok := word
			if i > 0 {
				tok = " " + word
			}
			chunkHandler(StreamChunk{Type: "text", Content: tok})
		}
		providerDone = time.Now()
		return &LLMResponse{
			Blocks:     []LLMResponseBlock{{Type: "text", Content: fullText}},
			StopReason: "end_turn",
		}, nil
	}

	_, err := w.callLLM(nil)
	callLLMDone := time.Now()
	if err != nil {
		t.Fatalf("callLLM failed: %v", err)
	}

	delay := callLLMDone.Sub(providerDone)

	// After the provider goroutine returns, the worker should finish near-instantly.
	// The only remaining work is draining any buffered chunks — this should take
	// microseconds, not hundreds of milliseconds. 200ms is a generous upper bound.
	const maxDelay = 200 * time.Millisecond
	if delay > maxDelay {
		t.Errorf("Worker took %v after provider finished (max allowed: %v) — streaming pipeline is bottlenecked", delay, maxDelay)
	} else {
		t.Logf("Worker finished %v after provider (within %v limit)", delay, maxDelay)
	}
}

// TestStatusChunkSurfacesPhase verifies that a provider-emitted status chunk
// (the cold-start liveness label) lands in processingState as `phase` so every
// observing client's spinner can show what's happening instead of a static
// "Receiving...". Exercises the real channel path (queueStreamChunk → worker
// goroutine → processStreamChunk), same as the streaming-integrity tests above.
func TestStatusChunkSurfacesPhase(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	// mergeProcessingPhase only writes while a live status is set — mirror the
	// strategy loop, which sends "streaming" just before the provider call.
	w.sendStatus("streaming", "")

	w.llmCallFunc = func(ctx context.Context, request json.RawMessage, chunkHandler func(StreamChunk)) (*LLMResponse, error) {
		// A phase label arrives before any content, then the first token.
		chunkHandler(StreamChunk{
			Type:            "status",
			Content:         "Rebuilding Claude Code context",
			CacheMissReason: "diverged: system prompt changed",
		})
		chunkHandler(StreamChunk{Type: "text", Content: "hi"})
		return &LLMResponse{
			Blocks:     []LLMResponseBlock{{Type: "text", Content: "hi"}},
			StopReason: "end_turn",
		}, nil
	}

	if _, err := w.callLLM(nil); err != nil {
		t.Fatalf("callLLM failed: %v", err)
	}

	state := w.readProcessingState()
	if state == nil {
		t.Fatal("processingState is nil after streaming a status chunk")
	}
	if got, _ := state["phase"].(string); got != "Rebuilding Claude Code context" {
		t.Errorf("processingState.phase = %q, want %q", got, "Rebuilding Claude Code context")
	}
}

// TestCacheMissLandsInTranscript verifies that a consequential provider cache
// miss becomes a durable notice item standing where it happened, rather than a
// caption on the spinner that the next status frame overwrites. Repeating the
// same reason within one turn must leave ONE notice: a provider is free to
// re-emit its status chunk, and a column of identical notices helps nobody.
func TestCacheMissLandsInTranscript(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	w.sendStatus("streaming", "")

	const reason = "diverged: system prompt changed"
	w.llmCallFunc = func(ctx context.Context, request json.RawMessage, chunkHandler func(StreamChunk)) (*LLMResponse, error) {
		chunkHandler(StreamChunk{Type: "status", Content: "Rebuilding Claude Code context", CacheMissReason: reason})
		// The same miss re-announced mid-turn must not add a second item.
		chunkHandler(StreamChunk{Type: "status", Content: "Waiting for response", CacheMissReason: reason})
		chunkHandler(StreamChunk{Type: "text", Content: "hi"})
		return &LLMResponse{
			Blocks:     []LLMResponseBlock{{Type: "text", Content: "hi"}},
			StopReason: "end_turn",
		}, nil
	}

	if _, err := w.callLLM(nil); err != nil {
		t.Fatalf("callLLM failed: %v", err)
	}

	var notices []ConversationItem
	for _, item := range w.getTargetItems() {
		if item.Type == ItemTypeNotice {
			notices = append(notices, item)
		}
	}
	if len(notices) != 1 {
		t.Fatalf("got %d notice items, want exactly 1", len(notices))
	}
	if notices[0].Summary == "" {
		t.Error("notice item has no summary — nothing for the transcript row to title itself with")
	}
	// The plain-English lead goes ABOVE the provider's own text, never in place
	// of it: both must survive into the item.
	if !strings.Contains(notices[0].Content, reason) {
		t.Errorf("notice content dropped the provider's reason: %q", notices[0].Content)
	}
	if !strings.Contains(notices[0].Content, cacheMissNoticeLead) {
		t.Errorf("notice content dropped the plain-English lead: %q", notices[0].Content)
	}
}

// TestNoticeItemEmitsNothingToTheLLM pins the contract that makes a notice safe
// to insert mid-turn: itemWireMessages has no case for it, so it contributes
// nothing to the provider payload. That fallthrough is SILENT — a stray case
// added later would quietly start narrating our caching to the model — so it is
// asserted rather than trusted.
func TestNoticeItemEmitsNothingToTheLLM(t *testing.T) {
	item := ConversationItem{
		Type:    ItemTypeNotice,
		ItemID:  "NOTICE_1",
		Summary: "Cache miss",
		Content: cacheMissNoticeLead + "\n\nReason: diverged",
		Source:  "claudecode",
	}
	if msgs := itemWireMessages(item, []ConversationItem{item}); msgs != nil {
		t.Errorf("notice item emitted %d wire message(s), want none: %+v", len(msgs), msgs)
	}
}

// TestStatusChunkIgnoredWhenIdle verifies the liveness guard: a status chunk
// arriving when no live status is set must not revive a stale spinner by
// writing a `phase` into an idle processingState.
func TestStatusChunkIgnoredWhenIdle(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	w.sendStatus("idle", "")
	w.processStreamChunk(StreamChunk{Type: "status", Content: "Starting Claude Code"})

	state := w.readProcessingState()
	if state != nil {
		if _, has := state["phase"]; has {
			t.Errorf("phase written into a non-live processingState: %+v", state)
		}
	}
}
