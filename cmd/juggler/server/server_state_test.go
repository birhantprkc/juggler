//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"testing"
	"time"
)

// mockSender captures messages via channels for async-safe test assertions.
type mockSender struct {
	messages chan any
	rawMsgs  chan []byte
}

func (m *mockSender) Send(msg any) bool {
	m.messages <- msg
	return true
}

func (m *mockSender) SendRaw(data []byte) bool {
	m.rawMsgs <- data
	return true
}

func newMockSender() *mockSender {
	return &mockSender{
		messages: make(chan any, 100),
		rawMsgs:  make(chan []byte, 100),
	}
}

// newTestServerState creates a minimal Server with the three actor goroutines
// running (hub, viewerGroup via projectState, engineSlot). No HTTP server,
// no session manager, no workers.
func newTestServerState(t *testing.T) *Server {
	t.Helper()
	s := &Server{hub: newClientHub()}
	s.projectState.Store(&projectState{viewers: newViewerGroup()})
	return s
}

// testWSClient creates a WSClient suitable for testing (no real connection).
func testWSClient(id string) *WSClient {
	return &WSClient{
		ID:   id,
		send: make(chan wsMessage, 256),
	}
}

// --- Tests ---

func TestServerState_ViewerSendToAll(t *testing.T) {
	s := newTestServerState(t)

	s1 := newMockSender()
	s2 := newMockSender()

	// We can't use joinViewerGroup with mockSender because it expects *WSClient.
	// Instead, manipulate state directly via ops. The state goroutine stores
	// op.client as a Sender. WSClient implements Sender.
	// For mock testing, we'll use a wrapped approach: create WSClients whose
	// Send methods forward to our mocks.

	// Actually, the simplest approach: use real WSClients and read from their send channels.
	c1 := testWSClient("c1")
	c2 := testWSClient("c2")

	s.joinViewerGroup(c1)
	s.joinViewerGroup(c2)

	s.viewerSendToAll(map[string]string{"type": "heartbeat"})

	// Read from the WSClient send channels
	select {
	case msg := <-c1.send:
		if msg.json == nil {
			t.Error("c1: expected JSON message")
		}
	case <-time.After(1 * time.Second):
		t.Fatal("c1: timeout waiting for message")
	}

	select {
	case msg := <-c2.send:
		if msg.json == nil {
			t.Error("c2: expected JSON message")
		}
	case <-time.After(1 * time.Second):
		t.Fatal("c2: timeout waiting for message")
	}

	_ = s1
	_ = s2
}

func TestServerState_ViewerSendRawToAll(t *testing.T) {
	s := newTestServerState(t)

	c1 := testWSClient("c1")
	c2 := testWSClient("c2")

	s.joinViewerGroup(c1)
	s.joinViewerGroup(c2)

	s.viewerSendRawToAll([]byte("streaming chunk"))

	for _, c := range []*WSClient{c1, c2} {
		select {
		case msg := <-c.send:
			if string(msg.raw) != "streaming chunk" {
				t.Errorf("expected 'streaming chunk', got %q", msg.raw)
			}
		case <-time.After(1 * time.Second):
			t.Fatalf("timeout waiting for raw message on %s", c.ID)
		}
	}
}

func TestServerState_ViewerRemove(t *testing.T) {
	s := newTestServerState(t)

	c1 := testWSClient("c1")
	c2 := testWSClient("c2")

	s.joinViewerGroup(c1)
	s.joinViewerGroup(c2)

	s.leaveViewerGroup("c2")

	s.viewerSendToAll(map[string]string{"type": "test"})

	// c1 should receive
	select {
	case <-c1.send:
	case <-time.After(1 * time.Second):
		t.Fatal("c1: timeout")
	}

	// c2 should NOT receive
	select {
	case <-c2.send:
		t.Error("c2 should not receive after removal")
	case <-time.After(100 * time.Millisecond):
		// expected
	}
}

func TestServerState_StartRequest(t *testing.T) {
	s := newTestServerState(t)

	c := testWSClient("c1")
	s.joinViewerGroup(c)

	ctx := context.Background()

	_, cancel1 := context.WithCancel(ctx)
	if !s.viewerStartRequest("conv1", cancel1) {
		t.Error("first StartRequest should return true")
	}

	_, cancel2 := context.WithCancel(ctx)
	if s.viewerStartRequest("conv1", cancel2) {
		t.Error("duplicate StartRequest should return false")
	}

	_, cancel3 := context.WithCancel(ctx)
	defer cancel3()
	if !s.viewerStartRequest("conv2", cancel3) {
		t.Error("StartRequest for different conv should return true")
	}
}

func TestServerState_CompleteRequest(t *testing.T) {
	s := newTestServerState(t)

	c := testWSClient("c1")
	s.joinViewerGroup(c)

	_, cancel := context.WithCancel(context.Background())
	s.viewerStartRequest("conv1", cancel)
	s.viewerCompleteRequest("conv1")

	_, cancel2 := context.WithCancel(context.Background())
	defer cancel2()
	if !s.viewerStartRequest("conv1", cancel2) {
		t.Error("should be able to start request after completion")
	}
}

func TestServerState_CancelRequest(t *testing.T) {
	s := newTestServerState(t)

	c := testWSClient("c1")
	s.joinViewerGroup(c)

	ctx, cancel := context.WithCancel(context.Background())
	s.viewerStartRequest("conv1", cancel)

	if !s.viewerCancelRequest("conv1") {
		t.Error("CancelRequest should return true for active request")
	}

	select {
	case <-ctx.Done():
		// expected — cancel func was called
	default:
		t.Error("cancel func should have been called")
	}

	_, cancel2 := context.WithCancel(context.Background())
	defer cancel2()
	if !s.viewerStartRequest("conv1", cancel2) {
		t.Error("should be able to start request after cancel")
	}

	if s.viewerCancelRequest("nonexistent") {
		t.Error("CancelRequest should return false for non-existent request")
	}
}

func TestServerState_Shells(t *testing.T) {
	s := newTestServerState(t)

	c := testWSClient("c1")
	s.joinViewerGroup(c)

	ctx := context.Background()
	_, cancel := context.WithCancel(ctx)

	if !s.viewerStartShell("sh1", cancel) {
		t.Error("first StartShell should return true")
	}
	_, cancel2 := context.WithCancel(ctx)
	if s.viewerStartShell("sh1", cancel2) {
		t.Error("duplicate StartShell should return false")
	}

	s.viewerCompleteShell("sh1")

	_, cancel3 := context.WithCancel(ctx)
	if !s.viewerStartShell("sh1", cancel3) {
		t.Error("StartShell after completion should succeed")
	}

	if !s.viewerCancelShell("sh1") {
		t.Error("CancelShell should return true")
	}

	// Start multiple shells and cancel all via leaveViewerGroup (which cancels all)
	_, cancel4 := context.WithCancel(ctx)
	_, cancel5 := context.WithCancel(ctx)
	s.viewerStartShell("sh2", cancel4)
	s.viewerStartShell("sh3", cancel5)

	// leaveViewerGroup with last client cancels all
	s.leaveViewerGroup("c1")

	// Rejoin and verify shells are cleared
	s.joinViewerGroup(c)
	_, cancel6 := context.WithCancel(ctx)
	defer cancel6()
	if !s.viewerStartShell("sh2", cancel6) {
		t.Error("sh2 should be available after session cleanup")
	}
}
