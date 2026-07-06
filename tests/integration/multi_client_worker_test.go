//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration

import (
	"context"
	"encoding/json"
	"fmt"
	"juggler/cmd/juggler/worker"
	"sync"
	"testing"
	"time"
)

// TestWorker_MultipleCallbacks verifies that a worker with multiple callbacks
// broadcasts messages to all connected clients.
func TestWorker_MultipleCallbacks(t *testing.T) {
	w := worker.NewConversationWorker("test-conv", "user:main")
	w.Start(context.Background())
	defer w.Stop()

	// Create channels to receive messages from callbacks
	client1Chan := make(chan []byte, 10)
	client2Chan := make(chan []byte, 10)
	client3Chan := make(chan []byte, 10)

	// Add three callbacks with unique client IDs
	w.SetCallback("client1", func(msg []byte) {
		client1Chan <- msg
	})
	w.SetCallback("client2", func(msg []byte) {
		client2Chan <- msg
	})
	w.SetCallback("client3", func(msg []byte) {
		client3Chan <- msg
	})

	defer w.RemoveCallback("client1")
	defer w.RemoveCallback("client2")
	defer w.RemoveCallback("client3")

	// Initialize worker
	initMsg := worker.InitMessage{
		Type: "init",
		Conversation: worker.SerializedConversation{
			ID: "test-conv",
			ModelConfig: &worker.ModelConfig{
				Provider: "anthropic",
				Model:    "claude-sonnet-4-20250514",
			},
		},
		Config: worker.WorkerConfig{
			ProjectPath: t.TempDir(),
		},
	}
	initBytes, _ := json.Marshal(initMsg)
	w.Send("init", initBytes)

	// Wait for ready messages on all clients
	// Note: yjs-sync messages may arrive before 'ready' due to observer firing during init
	waitForReady := func(ch chan []byte, clientName string) {
		timeout := time.After(1 * time.Second)
		for {
			select {
			case msg := <-ch:
				var parsed map[string]string
				_ = json.Unmarshal(msg, &parsed)
				if parsed["type"] == "ready" {
					return // Found ready message
				}
				// Skip other messages (like yjs-sync) and keep looking
			case <-timeout:
				t.Fatalf("%s timeout waiting for ready", clientName)
			}
		}
	}

	waitForReady(client1Chan, "Client 1")
	waitForReady(client2Chan, "Client 2")
	waitForReady(client3Chan, "Client 3")

	// Drain any remaining yjs-sync messages
	drainChannel(client1Chan, 100*time.Millisecond)
	drainChannel(client2Chan, 100*time.Millisecond)
	drainChannel(client3Chan, 100*time.Millisecond)

	// Directly mutate Yjs document - should broadcast to all clients via Pure Yjs
	w.Document().AppendMessage(worker.ConversationItem{
		Type:      worker.ItemTypeUser,
		ItemID:    "msg1",
		Content:   "Hello",
		Timestamp: "2025-01-01T00:00:00Z",
	})

	// All three clients should receive yjs-sync message
	receivedByClient1 := waitForYjsSync(client1Chan, 1*time.Second)
	receivedByClient2 := waitForYjsSync(client2Chan, 1*time.Second)
	receivedByClient3 := waitForYjsSync(client3Chan, 1*time.Second)

	if !receivedByClient1 {
		t.Error("Client 1 did not receive yjs-sync after mutation")
	}
	if !receivedByClient2 {
		t.Error("Client 2 did not receive yjs-sync after mutation")
	}
	if !receivedByClient3 {
		t.Error("Client 3 did not receive yjs-sync after mutation")
	}
}

// TestWorker_AddRemoveCallback verifies callback addition and removal.
func TestWorker_AddRemoveCallback(t *testing.T) {
	w := worker.NewConversationWorker("test-conv", "user:main")
	w.Start(context.Background())
	defer w.Stop()

	client1Chan := make(chan []byte, 10)
	client2Chan := make(chan []byte, 10)

	// Add two callbacks with unique client IDs
	w.SetCallback("client1", func(msg []byte) {
		client1Chan <- msg
	})
	w.SetCallback("client2", func(msg []byte) {
		client2Chan <- msg
	})

	// Initialize worker
	initMsg := worker.InitMessage{
		Type: "init",
		Conversation: worker.SerializedConversation{
			ID: "test-conv",
			ModelConfig: &worker.ModelConfig{
				Provider: "anthropic",
				Model:    "claude-sonnet-4-20250514",
			},
		},
		Config: worker.WorkerConfig{
			ProjectPath: t.TempDir(),
		},
	}
	initBytes, _ := json.Marshal(initMsg)
	w.Send("init", initBytes)

	// Both should receive ready
	waitForReady(client1Chan, t)
	waitForReady(client2Chan, t)

	// Remove client1's callback
	w.RemoveCallback("client1")

	// Drain channels
	drainChannel(client1Chan, 100*time.Millisecond)
	drainChannel(client2Chan, 100*time.Millisecond)

	// Send another message
	w.Send("ping", nil)

	// Only client2 should receive pong
	select {
	case msg := <-client2Chan:
		var parsed map[string]string
		_ = json.Unmarshal(msg, &parsed)
		if parsed["type"] != "pong" {
			t.Errorf("Client 2 expected 'pong', got %v", parsed)
		}
	case <-time.After(1 * time.Second):
		t.Fatal("Client 2 timeout waiting for pong")
	}

	// Client1 should NOT receive pong
	select {
	case msg := <-client1Chan:
		t.Errorf("Client 1 should not receive message after removal, got: %s", string(msg))
	case <-time.After(200 * time.Millisecond):
		// Expected - no message
	}

	w.RemoveCallback("client2")
}

// TestWorker_SendWithNoCallbacks verifies that sendWS doesn't crash with empty callback list.
func TestWorker_SendWithNoCallbacks(t *testing.T) {
	w := worker.NewConversationWorker("test-conv", "user:main")
	w.Start(context.Background())
	defer w.Stop()

	// No callbacks added - this should not crash
	initMsg := worker.InitMessage{
		Type: "init",
		Conversation: worker.SerializedConversation{
			ID: "test-conv",
			ModelConfig: &worker.ModelConfig{
				Provider: "anthropic",
				Model:    "claude-sonnet-4-20250514",
			},
		},
		Config: worker.WorkerConfig{
			ProjectPath: t.TempDir(),
		},
	}
	initBytes, _ := json.Marshal(initMsg)
	w.Send("init", initBytes)

	// Give it time to process
	time.Sleep(100 * time.Millisecond)

	// If we got here without panic, test passes
}

// TestWorker_CallbackThreadSafety verifies concurrent add/remove/send operations don't race.
func TestWorker_CallbackThreadSafety(t *testing.T) {
	w := worker.NewConversationWorker("test-conv", "user:main")
	w.Start(context.Background())
	defer w.Stop()

	var wg sync.WaitGroup
	stopChan := make(chan struct{})

	// Goroutine 1: Continuously add and remove callbacks
	wg.Go(func() {
		counter := 0
		for {
			select {
			case <-stopChan:
				return
			default:
				clientID := fmt.Sprintf("client-%d", counter)
				counter++
				w.SetCallback(clientID, func(msg []byte) {})
				time.Sleep(1 * time.Millisecond)
				w.RemoveCallback(clientID)
			}
		}
	})

	// Goroutine 2: Continuously send messages
	wg.Go(func() {
		for {
			select {
			case <-stopChan:
				return
			default:
				w.Send("ping", nil)
				time.Sleep(1 * time.Millisecond)
			}
		}
	})

	// Run for 500ms
	time.Sleep(500 * time.Millisecond)
	close(stopChan)
	wg.Wait()

	// If we got here without data race or panic, test passes
}

// Helper functions

func waitForReady(ch chan []byte, t *testing.T) {
	timeout := time.After(1 * time.Second)
	for {
		select {
		case msg := <-ch:
			var parsed map[string]string
			_ = json.Unmarshal(msg, &parsed)
			if parsed["type"] == "ready" {
				return // Found ready message
			}
			// Skip other messages (like yjs-sync) and keep looking
		case <-timeout:
			t.Fatal("Timeout waiting for ready")
		}
	}
}

func waitForYjsSync(ch chan []byte, timeout time.Duration) bool {
	timer := time.NewTimer(timeout)
	defer timer.Stop()

	for {
		select {
		case msg := <-ch:
			var parsed map[string]any
			_ = json.Unmarshal(msg, &parsed)
			if parsed["type"] == "yjs-sync" {
				return true
			}
			// Keep waiting for yjs-sync, might get undo-state or other messages
		case <-timer.C:
			return false
		}
	}
}

func drainChannel(ch chan []byte, timeout time.Duration) {
	timer := time.NewTimer(timeout)
	defer timer.Stop()

	for {
		select {
		case <-ch:
			// Drain message
		case <-timer.C:
			return
		}
	}
}
