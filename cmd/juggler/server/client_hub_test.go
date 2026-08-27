//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"fmt"
	"testing"
	"time"
)

// testRoleClient builds a WSClient with an explicit role, display info, and a
// buffered send channel, so the hub's broadcasts can be read without a real
// connection.
func testRoleClient(id string, role ClientRole, origin string) *WSClient {
	return &WSClient{ID: id, Role: role, info: ClientInfo{Origin: origin}, send: make(chan wsMessage, 256), closed: make(chan struct{})}
}

// nextClientsChanged reads the next clients-changed broadcast to a client,
// returning its count and descriptor list; fails if none arrives promptly.
func nextClientsChanged(t *testing.T, c *WSClient) (int, []clientDescriptor) {
	t.Helper()
	select {
	case msg := <-c.send:
		m, ok := msg.json.(map[string]any)
		if !ok {
			t.Fatalf("expected map message, got %T", msg.json)
		}
		if m["type"] != "clients-changed" {
			t.Fatalf("expected clients-changed, got %v", m["type"])
		}
		n, ok := m["count"].(int)
		if !ok {
			t.Fatalf("expected int count, got %T", m["count"])
		}
		list, ok := m["clients"].([]clientDescriptor)
		if !ok {
			t.Fatalf("expected []clientDescriptor clients, got %T", m["clients"])
		}
		return n, list
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for clients-changed")
		return 0, nil
	}
}

// nextClientsCount reads the next clients-changed broadcast and returns only its
// count.
func nextClientsCount(t *testing.T, c *WSClient) int {
	t.Helper()
	n, _ := nextClientsChanged(t, c)
	return n
}

// TestClientHub_ViewerCountExcludesEngine verifies the hub counts only viewer
// clients and broadcasts a clients-changed to viewers as they join and leave.
func TestClientHub_ViewerCountExcludesEngine(t *testing.T) {
	h := newClientHub()

	v1 := testRoleClient("v1", ClientRoleViewer, "local")
	h.register(v1)
	if got := nextClientsCount(t, v1); got != 1 {
		t.Fatalf("after first viewer join, count = %d, want 1", got)
	}

	v2 := testRoleClient("v2", ClientRoleViewer, "lan")
	h.register(v2)
	// Both existing viewers are notified of the new total, with a descriptor for
	// each connected viewer (ids and origins carried through).
	if got := nextClientsCount(t, v1); got != 2 {
		t.Fatalf("v1 saw count = %d, want 2", got)
	}
	count, list := nextClientsChanged(t, v2)
	if count != 2 {
		t.Fatalf("v2 saw count = %d, want 2", count)
	}
	origins := map[string]string{}
	for _, d := range list {
		origins[d.ID] = d.Origin
	}
	if origins["v1"] != "local" || origins["v2"] != "lan" {
		t.Fatalf("descriptor origins = %v, want v1=local v2=lan", origins)
	}

	// The engine is not a viewer: it must not change the count/list nor receive
	// the broadcast.
	engine := testRoleClient("engine", ClientRoleEngine, "local")
	h.register(engine)
	if got := h.viewerCount(); got != 2 {
		t.Fatalf("engine join changed viewer count to %d, want 2", got)
	}
	if got := h.viewerClients(); len(got) != 2 {
		t.Fatalf("viewerClients() returned %d, want 2 (engine excluded)", len(got))
	}
	select {
	case msg := <-engine.send:
		t.Fatalf("engine received an unexpected broadcast: %#v", msg)
	default:
	}

	// A viewer leaving re-broadcasts the decremented count to those remaining.
	h.unregister(v2)
	if got := nextClientsCount(t, v1); got != 1 {
		t.Fatalf("after v2 left, v1 saw count = %d, want 1", got)
	}
	if got := h.viewerCount(); got != 1 {
		t.Fatalf("viewerCount() = %d after v2 left, want 1", got)
	}
}

func TestClientHub_ViewerLimit(t *testing.T) {
	h := newClientHub()
	viewers := make([]*WSClient, 0, maxViewerClients)
	for i := 0; i < maxViewerClients; i++ {
		viewer := testRoleClient(fmt.Sprintf("viewer-%d", i), ClientRoleViewer, "local")
		if !h.register(viewer) {
			t.Fatalf("viewer %d was rejected below the limit", i+1)
		}
		viewers = append(viewers, viewer)
	}

	excess := testRoleClient("excess", ClientRoleViewer, "local")
	if h.register(excess) {
		t.Fatal("viewer above the limit was admitted")
	}
	if got := h.viewerCount(); got != maxViewerClients {
		t.Fatalf("viewerCount() = %d, want %d", got, maxViewerClients)
	}

	engine := testRoleClient("engine", ClientRoleEngine, "local")
	if !h.register(engine) {
		t.Fatal("engine was rejected by the viewer limit")
	}

	h.unregister(viewers[0])
	if !h.register(excess) {
		t.Fatal("viewer was rejected after a slot was released")
	}
}
