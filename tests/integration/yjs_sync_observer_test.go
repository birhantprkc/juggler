//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration_test

import (
	"context"
	"encoding/json"
	"sync/atomic"
	"testing"
	"time"

	"juggler/cmd/juggler/worker"
)

// TestYjsSyncTriggersObserver is a regression test for the critical bug:
// When frontend sets tool results and syncs back via yjs-sync, the worker's
// handleItemsChange() observer MUST fire to check batch completion.
//
// BUG SYMPTOM: Worker stuck in "Waiting for batch to complete..." forever
// because ApplySyncUpdate() wasn't triggering the items observer.
func TestYjsSyncTriggersObserver(t *testing.T) {
	t.Parallel()
	tmpDir := t.TempDir()
	manager := worker.NewManager()
	defer manager.Shutdown()

	// Track how many times handleItemsChange is called
	var observerCallCount atomic.Int32

	// Mock LLM that returns a tool use
	manager.SetLLMCaller(func(ctx context.Context, request json.RawMessage, chunkHandler func(worker.StreamChunk)) (*worker.LLMResponse, error) {
		return &worker.LLMResponse{
			Blocks: []worker.LLMResponseBlock{
				{
					Type:  "tool_use",
					ID:    "tool-test-123",
					Name:  "bash",
					Input: json.RawMessage(`{"command":"echo test"}`),
				},
			},
			StopReason:   "tool_use",
			InputTokens:  10,
			OutputTokens: 5,
		}, nil
	})

	// Auto-responder for context and tools requests
	var sendCallback func([]byte)
	sendCallback = func(msg []byte) {
		var parsed map[string]any
		if err := json.Unmarshal(msg, &parsed); err != nil {
			return
		}

		msgType, _ := parsed["type"].(string)

		switch msgType {
		case "render-context-items-request":
			reqID, _ := parsed["requestId"].(string)
			contextResult, _ := json.Marshal(worker.RenderContextItemsResponse{
				Type:      "render-context-items-response",
				RequestID: reqID,
				Contexts:  []worker.ItemContext{},
			})
			manager.HandleMessage("test-conv", "render-context-items-response", contextResult, sendCallback)

		case "request-tools":
			reqID, _ := parsed["requestId"].(string)
			toolsResult, _ := json.Marshal(worker.ToolsResultMessage{
				Type:      "tools-result",
				RequestID: reqID,
				Tools: []worker.ToolDefinition{
					{
						Name:        "bash",
						Description: "Execute bash command",
						InputSchema: json.RawMessage(`{"type":"object","properties":{"command":{"type":"string"}}}`),
						Category:    "write",
					},
				},
			})
			manager.HandleMessage("test-conv", "tools-result", toolsResult, sendCallback)
		}
	}

	// Initialize worker
	initPayload, _ := json.Marshal(worker.InitMessage{
		Type: "init",
		Conversation: worker.SerializedConversation{
			ID:   "test-conv",
			Name: "Test",
			ModelConfig: &worker.ModelConfig{
				Provider: "anthropic",
				Model:    "claude-sonnet-4-20250514",
			},
			CurrentStrategyID: "default",
		},
		Config: worker.WorkerConfig{
			ProjectPath: tmpDir,
		},
	})

	handled := manager.HandleMessage("test-conv", "init", initPayload, sendCallback)
	if !handled {
		t.Fatal("Init message not handled")
	}

	w := waitForWorkerCreation(t, manager, "test-conv")

	// Hook into the document observer to count calls
	// This simulates what handleItemsChange does
	originalDoc := w.Document()
	callCountChan := make(chan int, 10)
	originalDoc.RegisterItemsObserver(func() {
		count := observerCallCount.Add(1)
		select {
		case callCountChan <- int(count):
		default:
		}
	})

	// Reset count after setup
	observerCallCount.Store(0)

	// Send message to trigger tool use
	sendPayload, _ := json.Marshal(worker.SendMessageMessage{
		Type:           "send-message",
		Text:           "Run a command",
		IsContinuation: false,
	})

	handled = manager.HandleMessage("test-conv", "send-message", sendPayload, sendCallback)
	if !handled {
		t.Error("Send message not handled")
	}

	// Wait specifically for the tool item to be inserted. Item count >= 1
	// is not enough: the user message and system-prompt also count, and they
	// land before the worker has processed the LLM response that creates the
	// tool-action item.
	var toolIndex int
	deadline := time.Now().Add(5 * time.Second)
	for {
		items := originalDoc.GetItems()
		toolIndex = -1
		for i, item := range items {
			if item.ToolUseID == "tool-test-123" {
				toolIndex = i
				break
			}
		}
		if toolIndex >= 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("Tool item never appeared (have %d items)", len(items))
		}
		time.Sleep(20 * time.Millisecond)
	}

	t.Logf("Observer called %d time(s) after tool creation", observerCallCount.Load())

	// CRITICAL TEST: Simulate frontend approving tool and setting result via Yjs sync
	// This is what happens when user clicks approve and action completes
	items := originalDoc.GetItems()

	// Approve and set result (simulating what frontend does)
	items[toolIndex].State = "approved"
	items[toolIndex].Result = json.RawMessage(`{"content": "test output", "exitCode": 0}`)

	// Drain any observer events already buffered from setup churn. The
	// observer uses a non-blocking send into a 10-slot buffer; if init+send-
	// message produced more than 9 transitions, the ReplaceMessage observer
	// fire below would be silently dropped (channel full → default branch).
	for drained := false; !drained; {
		select {
		case <-callCountChan:
		default:
			drained = true
		}
	}
	preUpdateCount := int(observerCallCount.Load())

	// Use tracker to update (this triggers Yjs sync internally)
	if err := w.Tracker().ReplaceMessage(toolIndex, items[toolIndex]); err != nil {
		t.Fatalf("Failed to update tool: %v", err)
	}

	// CRITICAL: Wait for observer to fire again
	// This tests that ApplySyncUpdate() triggers the observer
	select {
	case count := <-callCountChan:
		if count <= preUpdateCount {
			t.Fatalf("REGRESSION: Observer not called after tool update (count=%d, expected > %d)", count, preUpdateCount)
		}
		t.Logf("SUCCESS: Observer called %d time(s) after tool update", count-preUpdateCount)
		t.Log("This proves ApplySyncUpdate() triggers the observer, fixing the stuck worker bug")
	case <-time.After(2 * time.Second):
		t.Fatal("REGRESSION: Observer never called after tool result update - ApplySyncUpdate() not triggering observer!")
	}
}
