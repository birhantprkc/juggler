//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// handleInit: what a worker reconstructs, resets, and deliberately leaves alone
// when it attaches to an already-persisted conversation.

// TestInitResetsStaleProcessingState verifies that handleInit clears stale
// processingState metadata from the Yjs doc (e.g., after loading from disk).
func TestInitResetsStaleProcessingState(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")

	// Manually set stale processingState (simulates state loaded from disk)
	w.doc.SetMetadata("processingState", map[string]any{
		"status":       "streaming",
		"message":      "",
		"threadItemId": "",
	})

	// Verify it's set
	ps := w.doc.GetMetadata("processingState")
	psMap, _ := ps.(map[string]any)
	if psMap == nil || psMap["status"] != "streaming" {
		t.Fatal("processingState not set to streaming")
	}

	// Call handleInit directly (worker not started, same-package access)
	initPayload, _ := json.Marshal(InitMessage{
		Type: "init",
		Conversation: SerializedConversation{
			ID: "test-conv",
		},
		Config: WorkerConfig{
			ProjectPath: t.TempDir(),
		},
	})
	w.currentRun().handleInit(initPayload)

	// Verify processingState is now idle
	ps = w.doc.GetMetadata("processingState")
	psMap, _ = ps.(map[string]any)
	if psMap == nil {
		t.Fatal("processingState is nil after init")
	}
	if psMap["status"] != "idle" {
		t.Errorf("Expected processingState status 'idle', got %q", psMap["status"])
	}

	w.doc.Destroy()
}

// TestInitCancelsStaleToolActions verifies that handleInit cancels tool-action
// items that were left running when the app was killed.
func TestInitCancelsStaleToolActions(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")

	// Insert a stale tool-action: approved, running, no result (simulates crash mid-execution)
	w.doc.InsertMessage(0, ConversationItem{
		Type:      ItemTypeToolAction,
		ItemID:    "ta-stale",
		ToolUseID: "tu-stale",
		ToolName:  "bash",
		State:     StateRunning,
	})

	// Verify no result before init
	items := w.doc.GetItems()
	if len(items[0].Result) != 0 {
		t.Fatal("Expected no result before handleInit")
	}

	// The repair / stale-tool cleanup pass in handleInit only runs on the
	// load-from-disk path, so we need a real on-disk doc.yjs reachable
	// through the worker's path provider. Wire a tmpdir-backed provider
	// and seed the file with the worker's current Yjs state so the
	// inserted stale tool-action is re-applied on load.
	tmpDir := t.TempDir()
	convDir := filepath.Join(tmpDir, ".juggler", "test--test-conv")
	if err := os.MkdirAll(convDir, 0o755); err != nil {
		t.Fatalf("mkdir conv dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(convDir, "doc.yjs"), w.doc.ToState(), 0o644); err != nil {
		t.Fatalf("seed doc.yjs: %v", err)
	}
	w.SetPathProvider(func(string) (string, bool) { return convDir, true })

	initPayload, _ := json.Marshal(InitMessage{
		Type: "init",
		Conversation: SerializedConversation{
			ID:           "test-conv",
			LoadFromDisk: true,
		},
		Config: WorkerConfig{
			ProjectPath: tmpDir,
		},
	})
	w.currentRun().handleInit(initPayload)

	// Verify the stale tool-action was cancelled
	items = w.doc.GetItems()
	if len(items) != 1 {
		t.Fatalf("Expected 1 item, got %d", len(items))
	}
	if len(items[0].Result) == 0 {
		t.Fatal("Expected stale tool-action to have interrupted result after init")
	}
	var r map[string]any
	if err := json.Unmarshal(items[0].Result, &r); err != nil {
		t.Fatalf("Failed to unmarshal result: %v", err)
	}
	if r["content"] != "Interrupted" {
		t.Errorf("Expected content 'Interrupted', got %v", r["content"])
	}
	if r["cancelled"] != true {
		t.Errorf("Expected cancelled=true, got %v", r["cancelled"])
	}

	w.doc.Destroy()
}

// TestInitPreservesAwaitingLLMForPendingTool verifies that handleInit does NOT
// clobber processingState.activity to idle when the on-disk doc still has a
// pending tool-action awaiting approval. If activity is cleared, then after the
// user approves and the tool completes, the thread reducer sees activity=""
// and returns ActionNone instead of dispatching the next LLM turn — the bash
// command runs but the conversation hangs without a follow-up LLM response.
func TestInitPreservesAwaitingLLMForPendingTool(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")

	// Seed a pending tool-action and an awaiting-LLM activity marker — the
	// state we'd be in at restart while the user has an approval dialog open.
	w.doc.InsertMessage(0, ConversationItem{
		Type:      ItemTypeUser,
		ItemID:    "u-1",
		Content:   "run bash",
		Timestamp: time.Now().Format(time.RFC3339),
	})
	w.doc.InsertMessage(1, ConversationItem{
		Type:      ItemTypeAssistant,
		ItemID:    "a-1",
		Content:   "I'll run that.",
		Timestamp: time.Now().Format(time.RFC3339),
	})
	w.doc.InsertMessage(2, ConversationItem{
		Type:      ItemTypeToolAction,
		ItemID:    "ta-pending",
		ToolUseID: "tu-pending",
		ToolName:  "bash",
		State:     StatePending,
	})
	w.doc.SetMetadata("processingState", map[string]any{
		"activity":     ActivityAwaitingLLM,
		"threadItemId": "",
		"status":       "processing_tools",
	})

	// Stage doc.yjs on disk so the load-from-disk path replays the seeded state.
	tmpDir := t.TempDir()
	convDir := filepath.Join(tmpDir, ".juggler", "test--test-conv")
	if err := os.MkdirAll(convDir, 0o755); err != nil {
		t.Fatalf("mkdir conv dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(convDir, "doc.yjs"), w.doc.ToState(), 0o644); err != nil {
		t.Fatalf("seed doc.yjs: %v", err)
	}
	w.SetPathProvider(func(string) (string, bool) { return convDir, true })

	initPayload, _ := json.Marshal(InitMessage{
		Type: "init",
		Conversation: SerializedConversation{
			ID:           "test-conv",
			LoadFromDisk: true,
		},
		Config: WorkerConfig{ProjectPath: tmpDir},
	})
	w.currentRun().handleInit(initPayload)

	// The pending tool must NOT have been cancelled — CancelStaleToolActions
	// skips StatePending, but cross-check here so a regression in that path
	// shows up as a clear failure on this test rather than silent drift.
	items := w.doc.GetItems()
	if len(items) != 3 || items[2].State != StatePending {
		t.Fatalf("Expected pending tool-action preserved, got items=%+v", items)
	}

	// The activity marker must still be awaiting_llm so that when the user
	// approves and the tool completes, decideNextAction dispatches CallLLM.
	if got := w.getActivity(); got != ActivityAwaitingLLM {
		t.Errorf("Expected activity %q after init with pending tool, got %q",
			ActivityAwaitingLLM, got)
	}

	w.doc.Destroy()
}

// TestInitLeavesUnsummarisedThreadAlone verifies that a thread carrying no
// summary survives a reload / server restart untouched. A thread with no
// summary is an ordinary resting state — a thread is running or stopped — so
// the load path must NOT stamp a result on it, as the old "Thread was
// interrupted" crash-repair did.
func TestInitLeavesUnsummarisedThreadAlone(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")

	w.doc.AppendMessage(ConversationItem{Type: ItemTypeUser, ItemID: "u-1", Content: "Hello"})
	threadArr := w.doc.InsertThread(1, "Open thread")
	// A thread that ended its turn on plain assistant text: stopped, carrying no
	// summary, with no live tool. This is the state the old repair stamped.
	w.doc.InsertMessageIntoArray(threadArr, 0, ConversationItem{
		Type:    ItemTypeAssistant,
		ItemID:  "a-1",
		Content: "I did some work.",
	})

	var threadItemID string
	for _, item := range w.doc.GetItems() {
		if item.Type == ItemTypeThread {
			threadItemID = item.ItemID
			break
		}
	}
	if threadItemID == "" {
		t.Fatal("thread item not found")
	}

	// Stage doc.yjs on disk so the load-from-disk path replays the seeded state.
	tmpDir := t.TempDir()
	convDir := filepath.Join(tmpDir, ".juggler", "test--test-conv")
	if err := os.MkdirAll(convDir, 0o755); err != nil {
		t.Fatalf("mkdir conv dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(convDir, "doc.yjs"), w.doc.ToState(), 0o644); err != nil {
		t.Fatalf("seed doc.yjs: %v", err)
	}
	w.SetPathProvider(func(string) (string, bool) { return convDir, true })

	initPayload, _ := json.Marshal(InitMessage{
		Type: "init",
		Conversation: SerializedConversation{
			ID:           "test-conv",
			LoadFromDisk: true,
		},
		Config: WorkerConfig{ProjectPath: tmpDir},
	})
	w.currentRun().handleInit(initPayload)

	threadYMap := w.doc.GetThreadYMap(threadItemID)
	if threadYMap == nil {
		t.Fatal("thread Y.Map not found after init")
	}
	if result, _ := threadYMap.Get("result").(string); result != "" {
		t.Errorf("a summary was stamped on reload (result=%q) — a stopped thread must survive a restart unchanged", result)
	}

	w.doc.Destroy()
}

// TestInitDuringProcessingCancelsAndResetsState verifies that receiving an init
// message while the strategy loop is running cancels the operation and resets state.
func TestInitDuringProcessingDoesNotCancel(t *testing.T) {
	manager := NewManager()
	defer manager.Shutdown()

	tmpDir := t.TempDir()

	// Set up a blocking LLM call that waits on a channel
	blockChan := make(chan struct{})
	t.Cleanup(func() {
		select {
		case <-blockChan:
		default:
			close(blockChan)
		}
	})

	manager.SetLLMCaller(func(ctx context.Context, req json.RawMessage, streamCB func(StreamChunk)) (*LLMResponse, error) {
		select {
		case <-blockChan:
			return &LLMResponse{StopReason: "end_turn"}, nil
		case <-ctx.Done():
			return nil, ErrCancelled
		}
	})

	// Init with model config so send-message passes validation
	initPayload, _ := json.Marshal(InitMessage{
		Type: "init",
		Conversation: SerializedConversation{
			ID:          "conv1",
			Name:        "Test",
			ModelConfig: &ModelConfig{Provider: "test", Model: "test-model"},
		},
		Config: WorkerConfig{
			ProjectPath: tmpDir,
		},
	})

	readyChan := make(chan struct{}, 2)
	sendCallback := func(msg []byte) {
		var parsed map[string]any
		if err := json.Unmarshal(msg, &parsed); err == nil {
			if parsed["type"] == "ready" {
				select {
				case readyChan <- struct{}{}:
				default:
				}
			}
		}
	}

	// First init
	manager.HandleMessage("conv1", "init", initPayload, sendCallback)
	select {
	case <-readyChan:
	case <-time.After(2 * time.Second):
		t.Fatal("Timeout waiting for ready")
	}

	w := manager.Get("conv1")
	if w == nil {
		t.Fatal("Worker not found")
	}

	// Send a message to start processing
	sendPayload, _ := json.Marshal(SendMessageMessage{
		Type: "send-message",
		Text: "Hello",
	})
	manager.HandleMessage("conv1", "send-message", sendPayload, nil)

	// Wait for worker to enter processing state
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if w.State() == StateProcessing {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if w.State() != StateProcessing {
		t.Fatalf("Expected StateProcessing, got %s", w.State())
	}

	// Send second init (simulates viewer reconnect) — this should NOT cancel
	manager.HandleMessage("conv1", "init", initPayload, sendCallback)

	// Wait for the reconnect init to be processed (it sends "ready")
	select {
	case <-readyChan:
	case <-time.After(2 * time.Second):
		t.Fatal("Timeout waiting for ready after reconnect")
	}

	// Worker should still be processing — reconnect does not cancel
	if w.State() != StateProcessing {
		t.Fatalf("Expected StateProcessing after reconnect init, got %s", w.State())
	}

	// Verify processingState metadata is NOT idle (still actively processing)
	ps := w.Document().GetMetadata("processingState")
	psMap, _ := ps.(map[string]any)
	if psMap != nil && psMap["status"] == "idle" {
		t.Error("processingState should not be idle during active processing")
	}
}
