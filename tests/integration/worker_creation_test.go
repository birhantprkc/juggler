//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration_test

import (
	"encoding/json"
	"testing"
	"time"

	"juggler/cmd/juggler/worker"
)

func waitForWorkerCreation(t *testing.T, manager *worker.Manager, convID string) *worker.ConversationWorker {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if w := manager.Get(convID); w != nil {
			return w
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timeout waiting for worker creation for %q", convID)
	return nil
}

// TestWorkerCreatedOnAnyMessage verifies that workers are created lazily on ANY message,
// not just "init". This is critical for page reload scenarios where yjs-sync arrives
// before init.
func TestWorkerCreatedOnAnyMessage(t *testing.T) {
	t.Parallel()
	manager := worker.NewManager()
	defer manager.Shutdown()

	// Send yjs-sync without init first (simulates page reload)
	yjsPayload := []byte(`{"type":"yjs-sync","bytes":[]}`)
	handled := manager.HandleMessage("conv-123", "yjs-sync", yjsPayload, nil)

	// This should PASS after fix: worker created on first message
	if !handled {
		t.Error("FAILED: yjs-sync not handled, worker should be created on first message")
	}

	w := waitForWorkerCreation(t, manager, "conv-123")

	// Second test: Verify worker is reused for subsequent messages
	initPayload, _ := json.Marshal(worker.InitMessage{
		Type: "init",
		Conversation: worker.SerializedConversation{
			ID:   "conv-123",
			Name: "Test Conversation",
		},
		Config: worker.WorkerConfig{
			ProjectPath: t.TempDir(),
		},
	})

	handled = manager.HandleMessage("conv-123", "init", initPayload, func([]byte) {})
	if !handled {
		t.Error("FAILED: init message not handled")
	}

	// Should still be the same worker instance
	w2 := manager.Get("conv-123")
	if w2 != w {
		t.Error("FAILED: Worker was recreated instead of reused")
	}
}

// TestWorkerCreatedOnYjsSync verifies worker creation for yjs-sync messages.
func TestWorkerCreatedOnYjsSync(t *testing.T) {
	t.Parallel()
	manager := worker.NewManager()
	defer manager.Shutdown()

	// Send yjs-sync as first message (this is the real-world scenario)
	yjsPayload := []byte(`{"type":"yjs-sync","bytes":[]}`)
	handled := manager.HandleMessage("conv-456", "yjs-sync", yjsPayload, nil)

	if !handled {
		t.Error("FAILED: yjs-sync not handled, worker should be created")
	}

	waitForWorkerCreation(t, manager, "conv-456")
}
