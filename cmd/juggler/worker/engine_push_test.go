//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"sync/atomic"
	"testing"
	"time"
)

// TestCallbackRegistry_EngineTargeting is the deterministic unit check for the
// engine-targeted send: sendToEngine reaches only the client marked via
// setEngine, and becomes a no-op once that client is removed.
func TestCallbackRegistry_EngineTargeting(t *testing.T) {
	r := newCallbackRegistry()
	defer r.stop()

	engineCh := make(chan []byte, 4)
	viewerCh := make(chan []byte, 4)
	r.set("engine", func(b []byte) { engineCh <- b })
	r.set("viewer", func(b []byte) { viewerCh <- b })
	r.setEngine("engine")

	r.sendToEngine([]byte("state"))
	select {
	case b := <-engineCh:
		if string(b) != "state" {
			t.Fatalf("engine received %q, want %q", b, "state")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("engine did not receive sendToEngine")
	}
	select {
	case b := <-viewerCh:
		t.Fatalf("viewer must NOT receive an engine-targeted send, got %q", b)
	case <-time.After(150 * time.Millisecond):
	}

	// After the engine detaches, sendToEngine is a no-op (no panic, no delivery).
	r.remove("engine")
	r.sendToEngine([]byte("state2"))
	select {
	case b := <-engineCh:
		t.Fatalf("a detached engine received %q", b)
	case <-time.After(150 * time.Millisecond):
	}
}

// TestToolTurnPushesStateToEngine is the behavioural guard for the tool-execution
// wedge fix. When a turn produces tool-actions, the worker pushes full document
// state to the engine (the single tool executor) so it is a loaded peer that can
// run the reducer — rather than relying on the engine to auto-load reactively on
// an incidental sync, which was racy and left approved tools stuck forever.
//
// We register both an "engine" client and a plain "viewer" client. Both receive
// the worker's normal broadcasts; only the engine additionally receives the
// targeted full-state push. So after a tool-producing turn the engine must have
// received strictly more yjs-sync messages than the viewer. Without the fix the
// counts are equal.
func TestToolTurnPushesStateToEngine(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	initPayload, _ := json.Marshal(InitMessage{
		Type:         "init",
		Conversation: SerializedConversation{ID: "test-conv", CurrentStrategyID: "default"},
		Config:       WorkerConfig{ProjectPath: t.TempDir()},
	})
	w.handleInit(initPayload)

	var engineSyncs, viewerSyncs atomic.Int64
	countYjsSync := func(c *atomic.Int64) func([]byte) {
		return func(b []byte) {
			var m struct {
				Type string `json:"type"`
			}
			if json.Unmarshal(b, &m) == nil && m.Type == "yjs-sync" {
				c.Add(1)
			}
		}
	}
	// Register AFTER handleInit so neither sees the init broadcast — the only
	// asymmetry we measure is the per-tool-turn engine push.
	w.SetCallback("viewer", countYjsSync(&viewerSyncs))
	w.SetCallback("engine", countYjsSync(&engineSyncs))
	w.SetEngineClientID("engine")

	w.setMockResponses([]MockResponse{
		{
			Blocks: []LLMResponseBlock{
				{Type: "tool_use", ID: "tu-1", Name: "bash", Input: json.RawMessage(`{"command":"ls"}`)},
			},
			StopReason: "tool_use",
		},
	})

	done := make(chan struct{})
	go func() {
		ctxResp, _ := json.Marshal(map[string]any{
			"type": "render-context-items-result", "systemPrompt": "sys", "contexts": []any{},
		})
		toolsResp, _ := json.Marshal(map[string]any{"type": "tools-result", "tools": []any{}})
		for {
			if !w.contextReply.inject(done, ctxResp) {
				return
			}
			if !w.toolsReply.inject(done, toolsResp) {
				return
			}
		}
	}()

	// Drives one turn that emits a bash tool_use, creating an async tool-action
	// and parking (no executor in the test). The push fires inside that turn.
	w.runStrategyLoop("do a tool", false)
	close(done)

	// Await mailbox-delivery quiescence: the engine must end up with strictly
	// more yjs-syncs than the viewer (the extra full-state push).
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if engineSyncs.Load() > viewerSyncs.Load() {
			return // fix verified: engine got the extra push the viewer did not
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("engine was not pushed conversation state on a tool turn (wedge): engine=%d viewer=%d",
		engineSyncs.Load(), viewerSyncs.Load())
}
