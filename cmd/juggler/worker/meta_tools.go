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

	var (
		message      string
		execErr      error
		showThinking = true
	)
	switch toolName {
	case "return_result":
		// The result is surfaced through the thread tile (Y.Map "result"), the
		// same path every thread uses — not as a thinking bubble, which would
		// mis-type the summary. Only the meta-tool-result below (LLM-context
		// plumbing) is emitted.
		message = w.execReturnResult(input, fallbackText)
		showThinking = false
	case "drop_context_items":
		message, execErr = w.execDropContextItems(input)
	default:
		execErr = fmt.Errorf("unknown meta tool: %s", toolName)
		message = fmt.Sprintf("Error: %v", execErr)
	}

	if showThinking {
		w.addThinkingMessage(message)
	}

	w.addMetaToolResult(toolUseID, toolName, toolInput, message, execErr != nil)

	return execErr
}

// execReturnResult handles the return_result meta tool: it writes the recovered
// result text onto the current thread's Y.Map (the single source of truth the
// strategy loop reads to stop the child loop) and returns the log message.
func (w *ConversationWorker) execReturnResult(input map[string]any, fallbackText string) string {
	resultText := resolveReturnResultText(input, fallbackText)
	if w.thread.itemID != "" {
		if threadYMap := w.doc.GetThreadYMap(w.thread.itemID); threadYMap != nil {
			ycrdtMu.Lock()
			w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
				threadYMap.Set("result", resultText)
			}, w.doc.authorID)
			ycrdtMu.Unlock()
		}
	}
	return fmt.Sprintf("Thread result: %s", resultText)
}

// execDropContextItems handles the drop_context_items meta tool: it deletes the
// context items whose itemId appears in the input set. Returns the log message
// and an error for malformed input.
func (w *ConversationWorker) execDropContextItems(input map[string]any) (string, error) {
	rawIDs, ok := input["itemIds"].([]any)
	if !ok {
		err := fmt.Errorf("drop_context_items: invalid itemIds input (expected array)")
		return fmt.Sprintf("Error: %v", err), err
	}

	// Build a set so matching is O(n+m), not O(n×m).
	wanted := make(map[string]bool, len(rawIDs))
	for _, id := range rawIDs {
		if idStr, ok := id.(string); ok {
			wanted[idStr] = true
		}
	}

	var indicesToDelete []int
	for i, item := range w.doc.GetItems() {
		if item.ItemID != "" && wanted[item.ItemID] {
			indicesToDelete = append(indicesToDelete, i)
		}
	}
	if len(indicesToDelete) > 0 {
		w.tracker.DeleteMessages(indicesToDelete)
	}
	return fmt.Sprintf("Dropped %d context items", len(indicesToDelete)), nil
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
