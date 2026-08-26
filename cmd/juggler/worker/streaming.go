//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"juggler/cmd/juggler/providers/provider"
	providerutils "juggler/cmd/juggler/providers/utils"
)

// A streamed block's content is a plain string value in a Y.Map, so writing it
// replaces the whole value rather than appending to it: the Yjs update the
// write produces is as long as the message SO FAR, not as long as the new
// characters. One write per provider delta therefore puts O(n²) bytes on the
// wire over a turn — a 20k-character reply arriving in a thousand deltas is
// megabytes of sync traffic per connected client, which is what a remote or
// slow connection actually feels.
//
// Spacing writes in proportion to the content already accumulated keeps a
// turn's total roughly linear: as the reply grows, each write costs more, so
// they are made less often. The reader loses nothing — a single delta is a
// smaller and smaller share of what is on screen as the message lengthens.
const (
	// streamWriteMinChars is the floor on new characters between writes, so a
	// short message still streams smoothly instead of arriving in lumps.
	streamWriteMinChars = 24
	// streamWriteLengthRatio spaces writes at one per len(content)/16 new
	// characters, once that exceeds the floor.
	streamWriteLengthRatio = 16
	// streamWriteMaxDelayMs caps the gap between writes, so a slow trickle of
	// tokens never looks stalled.
	streamWriteMaxDelayMs = 250
)

// streamingState holds accumulated streaming content for one LLM turn.
// Zeroed at iteration boundaries by finalizeStreaming.
//
// The *Content fields are always the complete accumulated text. The document
// is allowed to lag behind them between writes (see the throttle constants
// above); the *WrittenLen fields record how much of each block the document
// currently holds, so a flush knows whether anything is outstanding.
type streamingState struct {
	textMsgID       string
	thinkingMsgID   string
	textContent     string
	thinkingContent string

	textWrittenLen      int
	thinkingWrittenLen  int
	lastTextWriteMs     int64
	lastThinkingWriteMs int64
}

// queueStreamChunk sends a streaming chunk to a dedicated channel.
// Thread-safe: can be called from any goroutine (e.g., the LLM provider goroutine).
// Uses a large dedicated channel (not the shared inbound) so chunks are never dropped.
func (w *ConversationWorker) queueStreamChunk(chunk StreamChunk) {
	w.streamChunkChan <- chunk
}

// deliverLLMResponse hands a result to waitForLLMResponse via the 1-buffered
// turn.responseChan. Resilient to the cancel-during-rerun race: if a previously-
// cancelled LLM goroutine deposits a stale result after the new call has
// drained the channel, our send would block forever (1-slot full) and the
// new result would never reach waitForLLMResponse. The select drains any
// stale value as a third case so the next iteration's send wins. No default
// branch — we block until exactly one of {send, shutdown, drain} fires.
func (w *ConversationWorker) deliverLLMResponse(response *LLMResponse, err error) {
	result := llmCallResult{Response: response, Err: err}
	for {
		select {
		case w.turn.responseChan <- result:
			return
		case <-w.done:
			return
		case <-w.turn.responseChan:
			// Stale response from a previously-cancelled call. Loop and
			// retry the send on the now-empty channel.
		}
	}
}

// processCoalescedStreamChunks reads one chunk plus any additional buffered chunks,
// coalesces adjacent text/thinking chunks, and processes them. This produces
// at most one Yjs update per chunk type per call instead of one per token.
func (w *ConversationWorker) processCoalescedStreamChunks(first StreamChunk) {
	// Drain all currently buffered chunks
	chunks := []StreamChunk{first}
	for {
		select {
		case chunk := <-w.streamChunkChan:
			chunks = append(chunks, chunk)
		default:
			goto process
		}
	}
process:
	// Coalesce adjacent same-type text/thinking chunks
	coalesced := make([]StreamChunk, 0, len(chunks))
	current := chunks[0]
	for i := 1; i < len(chunks); i++ {
		c := chunks[i]
		if c.Type == current.Type && (current.Type == provider.ContentBlockTypeText || current.Type == provider.ContentBlockTypeThinking) {
			current.Content += c.Content
			// A thinking block's provider data (signature, reasoning item id)
			// rides on a trailing contentless chunk, which lands here. Carry it
			// onto the merged chunk or the merge is where it goes missing.
			if len(c.Metadata) > 0 && current.Metadata == nil {
				current.Metadata = make(map[string]any, len(c.Metadata))
			}
			for k, v := range c.Metadata {
				current.Metadata[k] = v
			}
		} else {
			coalesced = append(coalesced, current)
			current = c
		}
	}
	coalesced = append(coalesced, current)

	for _, chunk := range coalesced {
		w.processStreamChunk(chunk)
	}
}

// processStreamChunk handles incremental streaming of LLM responses.
// Updates the conversation document and sends streaming-content messages to browser.
func (w *ConversationWorker) processStreamChunk(chunk StreamChunk) {
	switch chunk.Type {
	case provider.ContentBlockTypeText:
		w.clearRetryingStatus()
		w.processTextChunk(chunk)
	case provider.ContentBlockTypeThinking:
		w.clearRetryingStatus()
		w.processThinkingChunk(chunk)
	case provider.ContentBlockTypeActivity:
		// Provider activity is a complete, replaceable snapshot. It lives only in
		// processingState and is never inserted into conversation history.
		w.patchProcessingState(func(state map[string]any) {
			state["description"] = chunk.Content
		})
	case provider.ContentBlockTypeProviderState:
		// Hidden continuation data is durable and ordered with the provider's
		// visible output, even when it has no content of its own.
		w.finalizeStreaming()
		if len(chunk.Metadata) > 0 {
			w.appendTargetMessage(ConversationItem{
				Type:         ItemTypeProviderState,
				ItemID:       generateItemID(),
				ProviderData: chunk.Metadata,
				Timestamp:    time.Now().Format(time.RFC3339),
			})
		}
	case provider.ContentBlockTypeProgress:
		// Transient mid-stream progress: a running output-token estimate
		// from the provider. Merge into processingState so every peer
		// renders the same digit off the doc (no point-to-point WS frame
		// — a second browser view would never receive it). Throttled
		// because text deltas can arrive ~30/sec on a fast provider; one
		// Yjs broadcast per delta would dominate the sync channel.
		now := time.Now().UnixMilli()
		if now-w.lastProgressWriteMs >= 200 {
			w.lastProgressWriteMs = now
			w.mergeProcessingTokens(chunk.OutputTokens, 0, 0)
		}
	case provider.ContentBlockTypeUsage:
		// Surface input/cached tokens on the live spinner status text
		// (transient — cleared when status leaves "streaming"). The
		// footer's anchor reads the most recent transaction blob's
		// `inputTokens` on demand instead. Spinner text is purely
		// cosmetic and tolerates noisy provider numbers.
		if chunk.InputTokens > 0 {
			w.mergeProcessingTokens(0, chunk.InputTokens, chunk.CachedTokens)
		}
	case provider.ContentBlockTypeStatus:
		// Provider-emitted retry, cache, or notice status. These exceptional
		// conditions replace any ordinary activity description and remain visible
		// as the turn's current phase until output takes precedence.
		//
		// A status chunk may ALSO carry a consequential cache miss. That is not
		// transient — it is an event worth reading after the fact — so it lands
		// in the transcript as its own item instead of riding the spinner.
		w.clearProcessingDescription()
		w.mergeProcessingPhase(chunk.Content)
		w.insertCacheMissNotice(chunk.CacheMissReason)
		w.insertProviderNotice(chunk.Notice)
	default:
		// Other chunk types (tool_use, etc.) end any provider activity.
		w.clearProcessingDescription()
		w.finalizeStreaming()
	}
}

func (w *ConversationWorker) clearProcessingDescription() {
	w.patchProcessingState(func(state map[string]any) {
		delete(state, "description")
	})
}

// streamWriteDue reports whether an accumulated block has moved far enough — in
// characters or in elapsed time — to be worth re-encoding into the document.
func streamWriteDue(contentLen, writtenLen int, lastWriteMs, nowMs int64) bool {
	threshold := contentLen / streamWriteLengthRatio
	if threshold < streamWriteMinChars {
		threshold = streamWriteMinChars
	}
	return contentLen-writtenLen >= threshold || nowMs-lastWriteMs >= streamWriteMaxDelayMs
}

// resetStreamingText starts a fresh text block: the accumulated content and the
// marks that track how much of it the document holds go together, or the next
// block's throttle would compare against the previous block's length.
func (w *ConversationWorker) resetStreamingText() {
	w.turn.streaming.textContent = ""
	w.turn.streaming.textWrittenLen = 0
	w.turn.streaming.lastTextWriteMs = 0
}

// resetStreamingThinking is resetStreamingText's counterpart for thinking blocks.
func (w *ConversationWorker) resetStreamingThinking() {
	w.turn.streaming.thinkingContent = ""
	w.turn.streaming.thinkingWrittenLen = 0
	w.turn.streaming.lastThinkingWriteMs = 0
}

// writeStreamingText puts the whole accumulated text block into the document
// and records what the document now holds.
func (w *ConversationWorker) writeStreamingText() {
	// Update content using messageId lookup - avoids expensive GetItems() JSON conversion
	_ = w.updateTargetItemByID(w.turn.streaming.textMsgID, "content", w.turn.streaming.textContent)
	w.turn.streaming.textWrittenLen = len(w.turn.streaming.textContent)
	w.turn.streaming.lastTextWriteMs = time.Now().UnixMilli()
}

// writeStreamingThinking is writeStreamingText's counterpart for thinking blocks.
func (w *ConversationWorker) writeStreamingThinking() {
	_ = w.updateTargetItemByID(w.turn.streaming.thinkingMsgID, "content", w.turn.streaming.thinkingContent)
	w.turn.streaming.thinkingWrittenLen = len(w.turn.streaming.thinkingContent)
	w.turn.streaming.lastThinkingWriteMs = time.Now().UnixMilli()
}

// flushStreamingText writes any text the throttle is still holding back. A
// no-op when the document is already current, so a caller that cannot tell
// whether a write is outstanding can call it unconditionally — which is what
// every path that reads, persists or finalises the document does.
func (w *ConversationWorker) flushStreamingText() {
	if w.turn.streaming.textMsgID == "" || w.turn.streaming.textWrittenLen >= len(w.turn.streaming.textContent) {
		return
	}
	w.writeStreamingText()
}

// flushStreamingThinking is flushStreamingText's counterpart for thinking blocks.
func (w *ConversationWorker) flushStreamingThinking() {
	if w.turn.streaming.thinkingMsgID == "" || w.turn.streaming.thinkingWrittenLen >= len(w.turn.streaming.thinkingContent) {
		return
	}
	w.writeStreamingThinking()
}

// flushPendingStreamWrites brings the document level with the accumulated
// streaming content of both block kinds. Every path that ends a block, ends a
// turn, persists the document, or hands it to something that reads it back must
// go through here first: the throttle's lag is only ever allowed to be
// transient, and a missed flush silently truncates a message.
func (w *ConversationWorker) flushPendingStreamWrites() {
	w.flushStreamingText()
	w.flushStreamingThinking()
}

func (w *ConversationWorker) processTextChunk(chunk StreamChunk) {
	// If starting a new text block (ID is empty), reset accumulated content
	// This ensures each text block's content is tracked separately for duplicate detection
	if w.turn.streaming.textMsgID == "" {
		// Text following a thinking block leaves that block's tail unwritten;
		// nothing else will come back to it until the turn ends.
		w.flushStreamingThinking()
		w.resetStreamingText()
	}

	// Accumulate content for this block
	w.turn.streaming.textContent += chunk.Content

	// Extract <plan> tags from accumulated text and set as nextSteps metadata
	w.extractPlanTag()

	// Create new message if needed
	if w.turn.streaming.textMsgID == "" {
		w.turn.streaming.textMsgID = generateItemID()
		msg := ConversationItem{
			Type:      ItemTypeAssistant,
			ItemID:    w.turn.streaming.textMsgID,
			Content:   w.turn.streaming.textContent,
			Timestamp: time.Now().Format(time.RFC3339),
		}
		w.appendTargetMessage(msg)
		// The first write of a block is never throttled: the bubble has to
		// appear the moment the model starts talking.
		w.turn.streaming.textWrittenLen = len(w.turn.streaming.textContent)
		w.turn.streaming.lastTextWriteMs = time.Now().UnixMilli()
	} else if streamWriteDue(len(w.turn.streaming.textContent), w.turn.streaming.textWrittenLen,
		w.turn.streaming.lastTextWriteMs, time.Now().UnixMilli()) {
		w.writeStreamingText()
	}
}

// extractPlanTag extracts <plan>...</plan> content from streaming text and
// stores it as the emitting thread's `nextSteps` (per-thread state, like
// goal/result). The root thread has no Y.Map of its own, so its plan lives on
// conversation metadata; a sub-thread's plan lives on its own thread Y.Map.
func (w *ConversationWorker) extractPlanTag() {
	const openTag = "<plan>"
	const closeTag = "</plan>"

	openIdx := strings.Index(w.turn.streaming.textContent, openTag)
	if openIdx == -1 {
		return
	}

	closeIdx := strings.Index(w.turn.streaming.textContent, closeTag)
	if closeIdx == -1 {
		return // Tag not yet closed (still streaming)
	}

	plan := strings.TrimSpace(w.turn.streaming.textContent[openIdx+len(openTag) : closeIdx])
	if plan != "" {
		// Per-thread: a sub-thread's plan lives on its own thread Y.Map so each
		// column reads its own plan and concurrent threads never share one slot.
		// The root thread has no Y.Map, so its plan lives on conversation metadata.
		if w.turn.thread.itemID == "" {
			w.doc.SetMetadata("nextSteps", plan)
		} else {
			w.doc.SetThreadField(w.turn.thread.itemID, "nextSteps", plan)
		}
	}
}

func (w *ConversationWorker) processThinkingChunk(chunk StreamChunk) {
	// A thinking block's provider data (Anthropic signature, OpenAI reasoning
	// item id + encrypted content) is known only once the block ends, so it
	// arrives on a trailing contentless chunk. With no thinking block on screen
	// there is nothing to attach it to: an item created for it would be empty,
	// which renders as a blank tile and is dropped from the wire anyway
	// (itemWireMessages emits nothing for contentless thinking). Let it go.
	if chunk.Content == "" && len(chunk.Metadata) > 0 && w.turn.streaming.thinkingMsgID == "" {
		return
	}

	// Finalize any active text streaming when thinking starts
	if w.turn.streaming.textMsgID != "" && w.turn.streaming.thinkingMsgID == "" {
		// The text block is ending here, so this is the last chance to write
		// whatever the throttle held back from it.
		w.flushStreamingText()
		w.turn.streaming.textMsgID = ""
	}

	// If starting a new thinking block (ID is empty), reset accumulated content
	// This ensures each thinking block's content is tracked separately for duplicate detection
	if w.turn.streaming.thinkingMsgID == "" {
		w.resetStreamingThinking()
	}

	// Accumulate content for this block
	w.turn.streaming.thinkingContent += chunk.Content

	// Create new message if needed
	if w.turn.streaming.thinkingMsgID == "" {
		w.turn.streaming.thinkingMsgID = generateItemID()
		msg := ConversationItem{
			Type:         ItemTypeThinking,
			ItemID:       w.turn.streaming.thinkingMsgID,
			Content:      w.turn.streaming.thinkingContent,
			ProviderData: chunk.Metadata,
			Timestamp:    time.Now().Format(time.RFC3339),
		}
		w.appendTargetMessage(msg)
		// The first write of a block is never throttled: the tile has to appear
		// the moment the model starts reasoning.
		w.turn.streaming.thinkingWrittenLen = len(w.turn.streaming.thinkingContent)
		w.turn.streaming.lastThinkingWriteMs = time.Now().UnixMilli()
		return
	}

	// Provider data is what lets the next turn replay this block: Anthropic
	// rejects a signatureless thinking block, and the Responses API needs
	// the reasoning item's id and encrypted content to carry the chain of
	// thought across a tool call. It rides a trailing chunk that ends the
	// block, so the content goes in alongside it whatever the throttle says.
	if len(chunk.Metadata) > 0 {
		w.flushStreamingThinking()
		_ = w.updateTargetItemByID(w.turn.streaming.thinkingMsgID, "providerData", chunk.Metadata)
		return
	}

	if streamWriteDue(len(w.turn.streaming.thinkingContent), w.turn.streaming.thinkingWrittenLen,
		w.turn.streaming.lastThinkingWriteMs, time.Now().UnixMilli()) {
		w.writeStreamingThinking()
	}
}

// mergeProcessingTokens augments the live processingState with running token
// counts so every observing client renders the same spinner text off the doc.
// Each non-zero argument overwrites its slot; zeros preserve the prior value
// (so the "progress" chunk handler can update outputTokens without clobbering
// the inputTokens/cachedTokens written earlier by the "usage" chunk). No-op
// when status isn't currently a live processing one — we don't want to revive
// a stale spinner after sendStatus("idle").
func (w *ConversationWorker) mergeProcessingTokens(outputTokens, inputTokens, cachedTokens int) {
	raw := w.doc.GetMetadata("processingState")
	state, ok := raw.(map[string]any)
	if !ok || state == nil {
		return
	}
	status, _ := state["status"].(string)
	switch status {
	case "preparing", "streaming", "processing_tools", "retrying":
		// live — fall through
	default:
		return
	}
	if outputTokens > 0 {
		state["outputTokens"] = outputTokens
	}
	if inputTokens > 0 {
		state["inputTokens"] = inputTokens
	}
	if cachedTokens > 0 {
		state["cachedTokens"] = cachedTokens
	}
	w.doc.SetMetadata("processingState", state)
}

// mergeProcessingPhase writes a provider-emitted phase label into the live
// processingState so every observing client renders the same spinner text off
// the doc. Mirrors mergeProcessingTokens' liveness guard: a no-op unless the
// status is a running one, so a status chunk that races past sendStatus("idle")
// can't revive a stale spinner.
func (w *ConversationWorker) mergeProcessingPhase(phase string) {
	if phase == "" {
		return
	}
	raw := w.doc.GetMetadata("processingState")
	state, ok := raw.(map[string]any)
	if !ok || state == nil {
		return
	}
	status, _ := state["status"].(string)
	switch status {
	case "preparing", "streaming", "processing_tools", "retrying":
		// live — fall through
	default:
		return
	}
	state["phase"] = phase
	w.doc.SetMetadata("processingState", state)
}

// cacheMissNoticeLead states, in plain English, what a provider cache miss cost.
// The provider's own reason is appended after it verbatim: the lead goes ABOVE
// the underlying text, never in place of it.
const cacheMissNoticeLead = "Claude Code re-read the whole conversation instead of using its cached copy, so this turn cost more than it needed to."

// insertCacheMissNotice records a consequential provider cache miss in the
// transcript, at the point in the conversation where it happened — after the
// message that triggered the turn, before the reply it paid for. A miss is
// worth reading after the fact (and worth still being there tomorrow), so it is
// a durable item rather than a caption on a spinner that the next status frame
// overwrites.
//
// Going through insertTargetMessage stamps the in-flight transaction id, so
// undoing the turn takes the notice with it. The item is deliberately absent
// from itemWireMessages: the model neither needs nor benefits from reading
// about our caching.
func (w *ConversationWorker) insertCacheMissNotice(reason string) {
	if reason == "" || reason == w.lastCacheMissNotice {
		return
	}
	w.lastCacheMissNotice = reason
	w.appendTargetMessage(ConversationItem{
		Type:   ItemTypeNotice,
		ItemID: generateItemID(),
		// The summary is the row's entire label — the transcript shows a warning
		// triangle and this text as a lozenge, nothing else — so it stays short
		// enough to read as one. The detail is in Content, for the panel.
		Summary:   "Cache miss",
		Content:   cacheMissNoticeLead + "\n\nReason: " + reason,
		Source:    "claudecode",
		Timestamp: time.Now().Format(time.RFC3339),
	})
}

// insertProviderNotice records a durable warning the provider composed in full
// — a serving tier the backend declined, say — at the point in the conversation
// where it happened.
//
// Deduplicated on the whole notice for the worker's lifetime, because the
// conditions that produce one rarely hold for a single turn: a plan that cannot
// use a tier cannot use it on the next turn either, and a warning repeated on
// every reply stops being information and becomes wallpaper. Once is the
// honest count.
func (w *ConversationWorker) insertProviderNotice(notice *StreamNotice) {
	if notice == nil || notice.Summary == "" || notice.Content == "" {
		return
	}
	key := notice.Summary + "\x00" + notice.Content
	if key == w.lastProviderNotice {
		return
	}
	w.lastProviderNotice = key
	w.appendTargetMessage(ConversationItem{
		Type:      ItemTypeNotice,
		ItemID:    generateItemID(),
		Summary:   notice.Summary,
		Content:   notice.Content,
		Source:    notice.Source,
		Timestamp: time.Now().Format(time.RFC3339),
	})
}

// truncationNoticeLead states, in plain English, what a max_tokens stop
// actually was. The measured numbers follow it; the lead never replaces them.
const truncationNoticeLead = "The model hit its output limit before it finished, so this turn stops mid-reply."

// insertTruncationNotice records that the provider ended a turn at its output
// budget, at the point in the conversation where it happened.
//
// A truncation is not deduplicated the way a provider-composed notice is: two
// turns cut short are two separate events, each worth seeing where it landed,
// whereas a declined serving tier is one standing condition restated. The
// strategy loop calls this at most once per turn, so there is no repetition to
// suppress within a turn either.
//
// The budget quoted is the output reserve admission charged for this model —
// the same number that went on the wire as max_tokens — so the note explains
// the limit the user can actually act on rather than a provider-side default
// nobody here can see.
func (w *ConversationWorker) insertTruncationNotice(response *LLMResponse) {
	_, reserve := w.resolveContextWindow()

	var detail strings.Builder
	detail.WriteString(truncationNoticeLead)
	// The reported case: a reasoning model that never reached an answer. Worth
	// saying outright, because the transcript shows thinking and then nothing,
	// which reads like a crash rather than a budget.
	if !hasAssistantText(response) {
		detail.WriteString(" It spent the whole budget thinking, so there is no answer to show.")
	}
	detail.WriteString("\n\n")
	switch {
	case reserve > 0 && response.OutputTokens > 0:
		fmt.Fprintf(&detail, "Output budget: %d tokens; this turn used %d. ", reserve, response.OutputTokens)
	case reserve > 0:
		fmt.Fprintf(&detail, "Output budget: %d tokens. ", reserve)
	case response.OutputTokens > 0:
		fmt.Fprintf(&detail, "This turn produced %d output tokens. ", response.OutputTokens)
	}
	detail.WriteString("Thinking counts against that budget, and Juggler derives the budget from the model's " +
		"context window — so if the window shown in Settings is smaller than the one your server really serves, " +
		"that is what shrank this reply.")

	source := ""
	if mc := w.resolveModelConfig(); mc != nil {
		source = mc.Provider
	}
	w.appendTargetMessage(ConversationItem{
		Type:      ItemTypeNotice,
		ItemID:    generateItemID(),
		Summary:   "Reply cut off",
		Content:   detail.String(),
		Source:    source,
		Timestamp: time.Now().Format(time.RFC3339),
	})
}

func (w *ConversationWorker) finalizeStreaming() {
	// Both blocks end here, and clearing the IDs makes their accumulated content
	// unreachable — so anything the throttle held back goes in first. This is
	// the flush point for a tool_use or provider-state chunk arriving mid-turn
	// and for every strategy-loop iteration boundary.
	w.flushPendingStreamWrites()

	// Only clear IDs, not content - content is used for duplicate detection in processLLMResponse
	w.turn.streaming.textMsgID = ""
	w.turn.streaming.thinkingMsgID = ""
}

// partialCancelledResponse assembles whatever text/thinking content was mid-stream
// when the user cancelled, so the transaction blob records the truncated output.
// Returns nil if nothing had been emitted yet.
func (w *ConversationWorker) partialCancelledResponse() *LLMResponse {
	// The blob and the transcript must show the same truncated output, so the
	// document catches up with the accumulated content before it is read off.
	w.flushPendingStreamWrites()

	var blocks []LLMResponseBlock
	if w.turn.streaming.thinkingContent != "" {
		blocks = append(blocks, LLMResponseBlock{Type: provider.ContentBlockTypeThinking, Thinking: w.turn.streaming.thinkingContent})
	}
	if w.turn.streaming.textContent != "" {
		blocks = append(blocks, LLMResponseBlock{Type: provider.ContentBlockTypeText, Content: w.turn.streaming.textContent})
	}
	return &LLMResponse{StopReason: "cancelled", Blocks: blocks}
}

// waitForLLMResponse waits for an LLM response while processing stream chunks
// and handling cancel messages. Stream chunks arrive on a dedicated channel
// and are coalesced before Yjs updates to minimize transaction overhead.
func (w *ConversationWorker) waitForLLMResponse(timeout time.Duration) (*LLMResponse, error) {
	// Every exit from the wait — response, cancel, timeout, worker stop, panic —
	// ends the streamed blocks, so the document catches up here rather than at
	// each return. The flush is a direct write, never a wait on the throttle
	// window, so a finished stream still completes immediately.
	defer w.flushPendingStreamWrites()

	timer := time.NewTimer(timeout)
	defer timer.Stop()

	for {
		select {
		case result := <-w.turn.responseChan:
			// Drain remaining stream chunks before returning
			for {
				select {
				case chunk := <-w.streamChunkChan:
					w.processStreamChunk(chunk)
				default:
					if result.Err != nil {
						return result.Response, &deliveredLLMError{err: result.Err}
					}
					return result.Response, nil
				}
			}
		case chunk := <-w.streamChunkChan:
			w.processCoalescedStreamChunks(chunk)
		case msg := <-w.inbound:
			w.handleMessageInWait(msg)
			if w.loadState() == StateCancelling {
				return nil, ErrCancelled
			}
		case <-w.doc.UpdateSignal():
			w.batcher.Schedule()
		case <-w.batcher.TimerChan():
			w.batcher.Flush()
		case <-w.livenessC():
			// A machine freeze (sleep, hibernate, host suspend) during the LLM
			// call would otherwise inflate the elapsed digit by the frozen span;
			// service the detector here too so it self-corrects within a tick of
			// the process resuming, without waiting for the call to return.
			w.detectFrozenGap()
		case <-timer.C:
			return nil, fmt.Errorf("LLM request timed out")
		case <-w.done:
			return nil, fmt.Errorf("worker stopped")
		}
	}
}

// waitForContextAndTools waits for context and tools results concurrently.
// Both requests should be sent before calling this. When needContext is false,
// only the tools response is awaited (context result will be nil).
func (w *ConversationWorker) waitForContextAndTools(timeout time.Duration, needContext bool) (json.RawMessage, json.RawMessage, error) {
	timer := time.NewTimer(timeout)
	defer timer.Stop()

	var contextResult, toolsResult json.RawMessage
	if !needContext {
		contextResult = []byte("null") // mark as "done" so we only wait for tools
	}

	for contextResult == nil || toolsResult == nil {
		// Disable a channel case once its result is received by using a nil channel
		// (selecting on nil blocks forever, effectively removing the case). This
		// prevents the select from consuming a future pair's value when the goroutine
		// has eagerly buffered the next ctx before tools from the current pair arrive.
		var ctxChan <-chan json.RawMessage
		if contextResult == nil {
			ctxChan = w.contextReply.out()
		}
		var toolsChan <-chan json.RawMessage
		if toolsResult == nil {
			toolsChan = w.toolsReply.out()
		}
		select {
		case result := <-ctxChan:
			if !w.contextReply.answersCurrent(result) {
				continue // an earlier round-trip's answer, left unread
			}
			contextResult = result
		case result := <-toolsChan:
			if !w.toolsReply.answersCurrent(result) {
				continue
			}
			toolsResult = result
		case msg := <-w.inbound:
			w.handleMessageInWait(msg)
			if w.loadState() == StateCancelling {
				return nil, nil, ErrCancelled
			}
		case <-w.doc.UpdateSignal():
			w.batcher.Schedule()
		case <-w.batcher.TimerChan():
			w.batcher.Flush()
		case <-w.livenessC():
			w.detectFrozenGap()
		case <-timer.C:
			// Report which half never answered — the context reply is engine-only
			// (single responder), so a wedge is almost always the context side.
			// Naming it turns an opaque timeout into an actionable diagnosis.
			var missing []string
			if contextResult == nil {
				missing = append(missing, "context")
			}
			if toolsResult == nil {
				missing = append(missing, "tools")
			}
			return nil, nil, fmt.Errorf("context/tools request timed out after %s (no %s response)", timeout, strings.Join(missing, "+"))
		case <-w.done:
			return nil, nil, fmt.Errorf("worker stopped")
		}
	}

	// Return nil for context when it wasn't requested
	if !needContext {
		contextResult = nil
	}

	return contextResult, toolsResult, nil
}

// isRateLimitMsg returns true if an error string indicates an HTTP 429 rate-limit.
func isRateLimitMsg(msg string) bool {
	lower := strings.ToLower(msg)
	return strings.Contains(msg, "429") ||
		strings.Contains(lower, "rate limit") ||
		strings.Contains(lower, "too many requests")
}

// isTransientMsg returns true if an error string indicates a failure that a
// fresh attempt usually clears: a stalled/dropped stream, or an upstream
// overload. The judgement lives in providerutils.TransientMessage so the turn
// loop and the out-of-band QuickComplete callers classify identically;
// deliberately narrow there, and it does NOT match the CLI's "exited
// unexpectedly" message, which can signal genuine quota exhaustion that
// retrying would only paper over.
func isTransientMsg(msg string) bool {
	return providerutils.TransientMessage(msg)
}

// parseRetryWaitFromMsg extracts a suggested retry delay from an error string
// ("in 1.9s", "after 2s", etc.). Falls back to 2 seconds.
func parseRetryWaitFromMsg(msg string) time.Duration {
	lower := strings.ToLower(msg)
	for _, prefix := range []string{"in ", "after "} {
		if idx := strings.Index(lower, prefix); idx != -1 {
			rest := msg[idx+len(prefix):]
			var secs float64
			if _, err := fmt.Sscanf(rest, "%fs", &secs); err == nil && secs > 0 && secs < 120 {
				return time.Duration(secs * float64(time.Second))
			}
		}
	}
	return 2 * time.Second
}

// RetryWaitResult reports how a waitForRetryDelay call ended.
// At most one of Cancelled / NewMessage is true; both false means the timer
// elapsed normally and the caller should retry the request.
type RetryWaitResult struct {
	Cancelled  bool // caller should return from runStrategyLoop
	NewMessage bool // user sent a new message; caller should restart the outer strategy loop
}

// waitForRetryDelay parks for d while processing worker messages (cancel,
// send-message, Yjs updates).
func (w *ConversationWorker) waitForRetryDelay(d time.Duration) RetryWaitResult {
	// Chunks from the attempt that just failed can still be draining into the
	// throttle; whichever way the wait ends, the document catches up with them.
	defer w.flushPendingStreamWrites()

	timer := time.NewTimer(d)
	defer timer.Stop()

	for {
		select {
		case <-timer.C:
			return RetryWaitResult{}

		case msg := <-w.inbound:
			switch msg.Type {
			case "cancel":
				w.logCancel(cancelReasonFromPayload(msg.Payload))
				if p := w.turn.cancelLLM.Swap(nil); p != nil {
					(*p)()
				}
				w.storeState(StateCancelling)
				return RetryWaitResult{Cancelled: true}

			case "send-message":
				// Only redirect when no tokens have streamed yet (pure retry — no partial response).
				if w.turn.streaming.textContent == "" && w.turn.streaming.thinkingContent == "" {
					var sm SendMessageMessage
					if err := json.Unmarshal(msg.Payload, &sm); err == nil {
						if input := sm.UserInput(); !input.isEmpty() {
							if sm.ThreadItemID != w.turn.thread.itemID {
								w.turn.thread.itemID = sm.ThreadItemID
								if sm.ThreadItemID != "" {
									w.turn.thread.itemsArray = w.doc.GetThreadItemsArray(sm.ThreadItemID)
								} else {
									w.turn.thread.itemsArray = nil
								}
							}
							w.addUserMessage(input)
							w.batcher.Flush()
							return RetryWaitResult{NewMessage: true}
						}
					}
				}
				// Has partial streamed tokens — composer should still be locked; ignore.

			default:
				w.handleMessageInWait(msg)
				if w.loadState() == StateCancelling {
					return RetryWaitResult{Cancelled: true}
				}
			}

		case chunk := <-w.streamChunkChan:
			w.processCoalescedStreamChunks(chunk)
		case <-w.doc.UpdateSignal():
			w.batcher.Schedule()
		case <-w.batcher.TimerChan():
			w.batcher.Flush()
		case <-w.done:
			return RetryWaitResult{Cancelled: true}
		}
	}
}
