//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"fmt"
	"strings"

	ycrdt "github.com/skyterra/y-crdt"
)

// isMetaTool checks if a tool name is a meta tool (built-in tools that execute in worker).
func isMetaTool(toolName string) bool {
	return toolName == "drop_context_items" || toolName == "return_result"
}

// executeMetaTool executes a meta tool directly in the worker.
// Meta tools are built-in operations that manipulate Yjs state (set metadata, drop context items).
// They execute instantly and don't need frontend approval or action execution.
func (w *ConversationWorker) executeMetaTool(toolUseID, toolName string, toolInput json.RawMessage, fallbackText string) error {
	var input map[string]any
	if err := json.Unmarshal(toolInput, &input); err != nil {
		return fmt.Errorf("failed to parse meta tool input: %w", err)
	}

	var message string
	var execErr error
	var showThinkingMessage bool

	switch toolName {
	case "return_result":
		// return_result: sets result on the current thread Y.Map and stops the child loop.
		resultText := resolveReturnResultText(input, fallbackText)
		message = fmt.Sprintf("Thread result: %s", resultText)
		// The result is surfaced through the thread tile (Y.Map "result"), the
		// same path every thread uses — not as a thinking bubble, which would
		// mis-type the summary. Only the meta-tool-result below (LLM-context
		// plumbing) is emitted.
		showThinkingMessage = false

		// Write result to the thread's Y.Map in Yjs (single source of truth).
		// The strategy loop checks the Y.Map to decide whether to stop.
		if w.thread.itemID != "" {
			threadYMap := w.doc.GetThreadYMap(w.thread.itemID)
			if threadYMap != nil {
				ycrdtMu.Lock()
				w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
					threadYMap.Set("result", resultText)
				}, w.doc.authorID)
				ycrdtMu.Unlock()
			}
		}

	case "drop_context_items":
		itemIds, ok := input["itemIds"].([]any)
		if !ok {
			execErr = fmt.Errorf("drop_context_items: invalid itemIds input (expected array)")
			message = fmt.Sprintf("Error: %v", execErr)
			showThinkingMessage = true
		} else {
			// Unified storage: collect indices of matching context items.
			items := w.doc.GetItems()
			var indicesToDelete []int
			for i, item := range items {
				if item.ItemID != "" {
					for _, id := range itemIds {
						if idStr, ok := id.(string); ok && item.ItemID == idStr {
							indicesToDelete = append(indicesToDelete, i)
							break
						}
					}
				}
			}
			if len(indicesToDelete) > 0 {
				w.tracker.DeleteMessages(indicesToDelete)
			}
			message = fmt.Sprintf("Dropped %d context items", len(indicesToDelete))
			showThinkingMessage = true
		}

	default:
		execErr = fmt.Errorf("unknown meta tool: %s", toolName)
		message = fmt.Sprintf("Error: %v", execErr)
		showThinkingMessage = true
	}

	if showThinkingMessage {
		w.addThinkingMessage(message)
	}

	w.addMetaToolResult(toolUseID, toolName, toolInput, message, execErr != nil)

	return execErr
}

// resolveReturnResultText recovers the thread-result text from a return_result
// call. The schema names the argument "result", but models mis-name it (most
// commonly "summary") or write the summary as an assistant text block alongside
// an empty arg object. Discarding that work and writing "No result provided"
// loses real output, so we recover from the most likely sources in priority
// order: the schema key, common aliases, then the turn's assistant text
// (fallbackText). Only a genuinely empty turn yields the placeholder.
func resolveReturnResultText(input map[string]any, fallbackText string) string {
	for _, key := range []string{"result", "summary", "content", "text", "output", "message"} {
		if s, ok := input[key].(string); ok {
			if t := strings.TrimSpace(s); t != "" {
				return t
			}
		}
	}
	if t := strings.TrimSpace(fallbackText); t != "" {
		return t
	}
	return "No result provided"
}
