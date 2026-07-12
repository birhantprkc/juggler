//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Test-harness message handlers and mock LLM support.
// Compiled into the binary only when -tags production is NOT set.

//go:build !production

package worker

import (
	"encoding/json"

	"juggler/internal/jlog"
)

// handleTestMessage routes test-harness messages. Returns true when the
// message was consumed so the caller can skip the normal switch.
// The production stub always returns false — this code is absent from release binaries.
func (w *ConversationWorker) handleTestMessage(msg workerMessage) bool {
	switch msg.Type {
	case "get-yjs-state":
		w.handleGetYjsState(msg.Payload)
	case "ping":
		w.handlePing(msg.Payload)
	case "flush-persistence":
		w.handleFlushPersistence(msg.Payload)
	case "set-mock-responses":
		w.handleSetMockResponses(msg.Payload)
	case "release-mock":
		if w.mock != nil {
			w.mock.release()
		}
	default:
		return false
	}
	return true
}

func (w *ConversationWorker) handleGetYjsState(payload json.RawMessage) {
	var msg struct {
		AckID string `json:"ackId,omitempty"`
	}
	_ = json.Unmarshal(payload, &msg)

	state := w.doc.ToState()
	w.send(map[string]any{
		"type":   "ack",
		"ackId":  msg.AckID,
		"result": state,
	})
}

// handleFlushPersistence forces the conversation's in-memory state to disk
// synchronously, bypassing the SaveDebounceTime debounce, then acks. Persistence
// tests use this instead of sleeping past the 2s debounce before a
// destroy+reload cycle: when the ack arrives the write is complete, so the
// reload can't race a not-yet-written file.
//
// This runs on the worker goroutine (dispatched inline from the run loop), so it
// saves directly — mirroring the loop's own flushReq case — rather than routing
// through ConversationWorker.FlushPersistence, which would deadlock waiting on
// the same loop to service flushReq.
func (w *ConversationWorker) handleFlushPersistence(payload json.RawMessage) {
	var msg struct {
		AckID string `json:"ackId,omitempty"`
	}
	_ = json.Unmarshal(payload, &msg)

	// Match the run loop's flushReq handling: skip while deleting (the folder is
	// about to be removed), otherwise stop the pending debounce timer and save.
	if !w.deleting.Load() {
		if w.saveTimer != nil {
			w.saveTimer.Stop()
		}
		if err := w.saveStateToDisk(); err != nil {
			w.log.Error("Failed to flush persistence: %v", err)
		}
	}
	w.send(map[string]any{
		"type":  "ack",
		"ackId": msg.AckID,
	})
}

// handlePing is a test synchronization barrier. The worker processes
// inbound messages serially, so by the time this handler runs every prior
// yjs-sync / undo / redo has been applied. The UndoManager batches captured
// updates inside a 20 ms timeout window before firing stack-item-added (the
// event that writes undoState to metadata). Force the window closed here so
// undoState is written synchronously, then flush the outbound batcher so
// every resulting Yjs sync precedes the ack.
//
// Closing the capture window in ping is equivalent to letting the 20 ms
// timer fire naturally between operations: subsequent mutations form a new
// undo group exactly as they would have. Tests that want adjacent
// operations to share a group simply don't ping between them.
func (w *ConversationWorker) handlePing(payload json.RawMessage) {
	var msg struct {
		AckID string `json:"ackId,omitempty"`
	}
	_ = json.Unmarshal(payload, &msg)

	w.tracker.StopCapturing()
	w.batcher.Flush()
	if msg.AckID != "" {
		w.send(map[string]any{
			"type":  "ack",
			"ackId": msg.AckID,
		})
		return
	}
	// Callers that don't supply an ackId get the pong frame instead.
	w.send(map[string]any{"type": "pong"})
}

// handleSetMockResponses enables mock mode and sets scripted LLM responses.
// When w.mock is non-nil, callLLM() pops and returns these responses instead of calling the real LLM.
func (w *ConversationWorker) handleSetMockResponses(payload json.RawMessage) {
	var msg struct {
		SetMockResponsesMessage
		AckID string `json:"ackId,omitempty"`
	}
	if err := json.Unmarshal(payload, &msg); err != nil {
		jlog.Error("Failed to parse set-mock-responses: %v", err)
		return
	}

	w.setMockResponses(msg.Responses)
	jlog.Info("[set-mock-responses] conv=%s count=%d payloadLen=%d", w.conversationID, len(msg.Responses), len(payload))

	if msg.AckID != "" {
		w.send(AckMessage{
			Type:   "ack",
			AckID:  msg.AckID,
			Result: true,
		})
	}
}
