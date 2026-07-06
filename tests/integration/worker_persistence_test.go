//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"juggler/cmd/juggler/worker"
	"juggler/tests/integration/helpers"
)

// wirePathProvider attaches a default test path provider + save callback
// so the worker can persist its doc.yjs and txn blobs. Call this immediately
// after worker.NewManager() to wire up persistence I/O.
func wirePathProvider(m *worker.Manager, tmpDir string) {
	pathProvider := helpers.TestPathProvider(tmpDir)
	m.SetPathProvider(pathProvider)
	m.SetSaveBinary(helpers.TestSaveBinary(tmpDir, pathProvider))
}

// TestWorkerPersistsStateOnChange verifies that the Go worker saves its Yjs
// state to disk when the conversation changes. This is critical because:
// - Frontend skips saving conversations with active workers
// - Workers are expected to handle their own persistence
// - Without this, data is lost on server restart
func TestWorkerPersistsStateOnChange(t *testing.T) {
	t.Parallel()
	tmpDir := t.TempDir()
	convID := "test-conv"

	manager := worker.NewManager()
	defer manager.Shutdown()
	wirePathProvider(manager, tmpDir)

	initPayload, _ := json.Marshal(worker.InitMessage{
		Type: "init",
		Conversation: worker.SerializedConversation{
			ID:   convID,
			Name: "Test",
		},
		Config: worker.WorkerConfig{
			ProjectPath: tmpDir,
		},
	})

	readyChan := make(chan struct{}, 1)
	messagesChan := make(chan []byte, 1000)
	sendCallback := func(msg []byte) {
		messagesChan <- msg

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

	handled := manager.HandleMessage(convID, "init", initPayload, sendCallback)
	if !handled {
		t.Fatal("Init message not handled")
	}

	// Wait for ready message before accessing document
	select {
	case <-readyChan:
	case <-time.After(1 * time.Second):
		t.Fatal("Timeout waiting for ready message")
	}

	w := manager.Get(convID)
	if w == nil {
		t.Fatal("Worker not found")
	}

	// Add a message to the conversation
	w.Document().AppendMessage(worker.ConversationItem{
		Type:    worker.ItemTypeUser,
		ItemID:  "msg1",
		Content: "Test message that should be persisted",
	})

	flushCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := w.FlushPersistence(flushCtx); err != nil {
		t.Fatalf("FlushPersistence: %v", err)
	}

	// Verify the file was created
	statePath := convDocPath(t, tmpDir, convID)
	data, err := os.ReadFile(statePath)
	if err != nil {
		t.Fatalf("State file not created: %v", err)
	}
	if len(data) == 0 {
		t.Fatal("State file is empty")
	}

	// Verify we can load the state in a new document
	doc2 := worker.NewConversationDocument("verify", "user:test")
	if err := doc2.LoadFromState(data); err != nil {
		t.Fatalf("Failed to load state: %v", err)
	}

	items := doc2.GetItems()
	if len(items) != 1 {
		t.Fatalf("Expected 1 item in loaded doc, got %d", len(items))
	}
	if items[0].Content != "Test message that should be persisted" {
		t.Errorf("Content mismatch: %s", items[0].Content)
	}

	doc2.Destroy()
	t.Log("SUCCESS: Worker persisted state to disk")
}

// TestWorkerPersistsOnShutdown verifies that pending changes are saved
// when the worker shuts down, even if the debounce timer hasn't fired yet.
func TestWorkerPersistsOnShutdown(t *testing.T) {
	t.Parallel()
	tmpDir := t.TempDir()
	convID := "test-conv"

	manager := worker.NewManager()
	wirePathProvider(manager, tmpDir)

	initPayload, _ := json.Marshal(worker.InitMessage{
		Type:         "init",
		Conversation: worker.SerializedConversation{ID: convID},
		Config: worker.WorkerConfig{
			ProjectPath: tmpDir,
		},
	})

	readyChan := make(chan struct{}, 1)
	messagesChan := make(chan []byte, 1000)
	sendCallback := func(msg []byte) {
		messagesChan <- msg

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

	handled := manager.HandleMessage(convID, "init", initPayload, sendCallback)
	if !handled {
		t.Fatal("Init message not handled")
	}

	// Wait for ready message
	select {
	case <-readyChan:
	case <-time.After(1 * time.Second):
		t.Fatal("Timeout waiting for ready message")
	}

	w := manager.Get(convID)
	if w == nil {
		t.Fatal("Worker not found")
	}

	w.Document().AppendMessage(worker.ConversationItem{
		Type:    worker.ItemTypeUser,
		ItemID:  "msg1",
		Content: "Must be saved on shutdown",
	})

	// Shutdown immediately (before debounce timer fires)
	manager.Shutdown()

	// Verify state was saved on shutdown
	statePath := convDocPath(t, tmpDir, convID)
	data, err := os.ReadFile(statePath)
	if err != nil {
		t.Fatalf("State not saved on shutdown: %v", err)
	}

	// Verify content
	doc := worker.NewConversationDocument("verify", "user:test")
	if err := doc.LoadFromState(data); err != nil {
		t.Fatalf("Failed to load state: %v", err)
	}
	items := doc.GetItems()
	if len(items) != 1 || items[0].Content != "Must be saved on shutdown" {
		t.Errorf("Shutdown save missing content, got %d items", len(items))
		if len(items) > 0 {
			t.Logf("Content: %s", items[0].Content)
		}
	}
	doc.Destroy()

	t.Log("SUCCESS: Worker persisted state on shutdown")
}

// TestWorkerLoadsPersistedState verifies that the worker correctly loads
// pre-existing state from disk when it starts up.
func TestWorkerLoadsPersistedState(t *testing.T) {
	t.Parallel()
	tmpDir := t.TempDir()
	convID := "test-conv"

	// Pre-create state file with content
	doc := worker.NewConversationDocument(convID, "user:test")
	doc.AppendMessage(worker.ConversationItem{
		Type:    worker.ItemTypeUser,
		ItemID:  "pre-existing",
		Content: "Pre-existing message from disk",
	})
	state := doc.ToState()
	doc.Destroy()

	statePath := convDocPath(t, tmpDir, convID)
	if err := os.MkdirAll(filepath.Dir(statePath), 0755); err != nil {
		t.Fatalf("Failed to create directory: %v", err)
	}
	if err := os.WriteFile(statePath, state, 0644); err != nil {
		t.Fatalf("Failed to write state file: %v", err)
	}

	// Now create worker - should load the state
	manager := worker.NewManager()
	defer manager.Shutdown()
	wirePathProvider(manager, tmpDir)

	initPayload, _ := json.Marshal(worker.InitMessage{
		Type:         "init",
		Conversation: worker.SerializedConversation{ID: convID},
		Config: worker.WorkerConfig{
			ProjectPath: tmpDir,
		},
	})

	readyChan := make(chan struct{}, 1)
	messagesChan := make(chan []byte, 1000)
	sendCallback := func(msg []byte) {
		messagesChan <- msg

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

	handled := manager.HandleMessage(convID, "init", initPayload, sendCallback)
	if !handled {
		t.Fatal("Init message not handled")
	}

	// Wait for ready message
	select {
	case <-readyChan:
	case <-time.After(1 * time.Second):
		t.Fatal("Timeout waiting for ready message")
	}

	w := manager.Get(convID)
	if w == nil {
		t.Fatal("Worker not found")
	}

	items := w.Document().GetItems()

	if len(items) != 1 {
		t.Fatalf("Expected 1 pre-existing item, got %d", len(items))
	}
	if items[0].Content != "Pre-existing message from disk" {
		t.Errorf("Wrong content loaded: %s", items[0].Content)
	}

	t.Log("SUCCESS: Worker loaded pre-existing state from disk")
}

// TestWorkerPersistsMultipleChanges verifies that rapid changes are debounced
// and saved correctly - only the final state should be on disk.
func TestWorkerPersistsMultipleChanges(t *testing.T) {
	t.Parallel()
	tmpDir := t.TempDir()
	convID := "test-conv"

	manager := worker.NewManager()
	defer manager.Shutdown()
	wirePathProvider(manager, tmpDir)

	initPayload, _ := json.Marshal(worker.InitMessage{
		Type: "init",
		Conversation: worker.SerializedConversation{
			ID:   convID,
			Name: "Test",
		},
		Config: worker.WorkerConfig{
			ProjectPath: tmpDir,
		},
	})

	readyChan := make(chan struct{}, 1)
	messagesChan := make(chan []byte, 1000)
	sendCallback := func(msg []byte) {
		messagesChan <- msg

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

	handled := manager.HandleMessage(convID, "init", initPayload, sendCallback)
	if !handled {
		t.Fatal("Init message not handled")
	}

	// Wait for ready message
	select {
	case <-readyChan:
	case <-time.After(1 * time.Second):
		t.Fatal("Timeout waiting for ready message")
	}

	w := manager.Get(convID)
	if w == nil {
		t.Fatal("Worker not found")
	}

	// Add multiple messages rapidly (debounce should coalesce them).
	for i := 1; i <= 5; i++ {
		w.Document().AppendMessage(worker.ConversationItem{
			Type:    worker.ItemTypeUser,
			ItemID:  string(rune('a' + i - 1)),
			Content: string(rune('A' + i - 1)),
		})
		time.Sleep(10 * time.Millisecond) // Brief gap between mutations
	}

	flushCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := w.FlushPersistence(flushCtx); err != nil {
		t.Fatalf("FlushPersistence: %v", err)
	}

	// Verify all 5 messages are persisted
	statePath := convDocPath(t, tmpDir, convID)
	data, err := os.ReadFile(statePath)
	if err != nil {
		t.Fatalf("State file not created: %v", err)
	}

	doc2 := worker.NewConversationDocument("verify", "user:test")
	if err := doc2.LoadFromState(data); err != nil {
		t.Fatalf("Failed to load state: %v", err)
	}

	items := doc2.GetItems()
	if len(items) != 5 {
		t.Errorf("Expected 5 items in loaded doc, got %d", len(items))
	}

	expected := []string{"A", "B", "C", "D", "E"}
	for i, exp := range expected {
		if i < len(items) && items[i].Content != exp {
			t.Errorf("Item %d: expected %s, got %s", i, exp, items[i].Content)
		}
	}

	doc2.Destroy()
	t.Log("SUCCESS: Worker persisted multiple debounced changes")
}
