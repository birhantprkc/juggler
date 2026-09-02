//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

// What a reconnecting engine costs.
//
// The engine's realm outlives its socket, so a link drop leaves it holding
// every document it had. The seed the server sends on reattach used to ignore
// that and push full state for every loaded conversation — the entire CRDT,
// every time, wasted almost always. On a large conversation it was worse than
// wasteful: the message exceeded what the client would accept, the connection
// died mid-write, the engine reconnected, and the same state went out again, so
// the conversation could not be used again at all.
//
// These pin the shape that replaced it: an offer that carries nothing, answered
// by whichever party knows what is actually missing.

import (
	"context"
	"testing"
)

// TestReattachOffersRatherThanPushingState is the regression test for the
// reported failure. The seed must not put the document on the wire: a
// conversation large enough to break the connection breaks it on every
// reconnect, which is what made one unusable permanently.
func TestReattachOffersRatherThanPushingState(t *testing.T) {
	w, _ := startAttachableWorker(t)

	engine := newMsgChan()
	w.SetCallback("engine", engine.callback)
	quiesce(t, w, engine)

	w.SendFromClient("engine", "resync-to-origin", nil)

	frames := framesUntilBarrier(t, w, engine)
	if !frames.saw("resync-offer") {
		t.Fatal("reattach sent no resync-offer; the engine is never told the conversation is loaded here")
	}
	if frames.saw("yjs-sync") {
		t.Fatal("reattach pushed document state; the engine must be offered the conversation, not sent it")
	}
}

// TestAnEngineAnsweringTheOfferGetsOnlyADelta is the payoff: the engine that
// kept its document across the drop names what it lacks and is answered with
// exactly that, however large the conversation is.
func TestAnEngineAnsweringTheOfferGetsOnlyADelta(t *testing.T) {
	w, engineDoc := startAttachableWorker(t)

	engine := newMsgChan()
	w.SetCallback("engine", engine.callback)

	// The worker moved on while the engine's socket was down.
	w.Document().AppendMessage(ConversationItem{
		Type: ItemTypeAssistant, ItemID: "missed", Content: missedContent,
	})
	quiesce(t, w, engine)

	// Reattach, then answer the offer the way the engine does.
	w.SendFromClient("engine", "resync-to-origin", nil)
	if !framesUntilBarrier(t, w, engine).saw("resync-offer") {
		t.Fatal("reattach sent no resync-offer to answer")
	}
	sendResyncRequest(t, w, "engine", engineDoc.GetStateVector())

	resp := waitForResyncResponse(t, engine)
	if !isDelta(t, resp.Bytes, attachedContent) {
		t.Fatal("the answer carried full state; an engine that named its vector must be sent only what it lacks")
	}
	if err := engineDoc.ApplySyncUpdate(resp.Bytes); err != nil {
		t.Fatalf("applying the delta failed: %v", err)
	}
	if !docHasContent(engineDoc, missedContent) {
		t.Fatal("the delta did not carry the op the engine was missing")
	}
}

// TestAnEngineWithNoDocumentStillReachesFullState covers the other engine: one
// that genuinely restarted and holds nothing. It has no vector to offer, and an
// absent vector must still mean the whole document — otherwise a recreated
// engine would sit next to a conversation it can never execute a tool in.
func TestAnEngineWithNoDocumentStillReachesFullState(t *testing.T) {
	w, _ := startAttachableWorker(t)

	engine := newMsgChan()
	w.SetCallback("engine", engine.callback)
	quiesce(t, w, engine)

	// A restarted engine ignores the offer and loads the conversation the
	// ordinary way, which is an init with an empty vector.
	w.SendFromClient("engine", "resync-to-origin", nil)
	if !framesUntilBarrier(t, w, engine).saw("resync-offer") {
		t.Fatal("reattach sent no resync-offer")
	}

	empty := NewConversationDocument("conv-attach", "user:restarted-engine")
	w.SendFromClient("engine", "init", initPayload(t, "conv-attach", empty.GetStateVector()))

	update := waitForYjsSync(t, engine)
	if isDelta(t, update, attachedContent) {
		t.Fatal("an engine holding nothing was answered with a delta; it must get the whole document")
	}
	if err := empty.ApplySyncUpdate(update); err != nil {
		t.Fatalf("applying full state failed: %v", err)
	}
	if !docHasContent(empty, attachedContent) {
		t.Fatal("full state did not carry the document")
	}
}

// TestReattachOfAnUninitializedWorkerSaysNothing keeps the guard that was there
// before: a worker whose document is not loaded has nothing to offer, and
// handleInit's own broadcast covers the engine once init runs.
func TestReattachOfAnUninitializedWorkerSaysNothing(t *testing.T) {
	w := NewConversationWorker("conv-uninitialized", "user:test")
	w.currentRun().Start(context.Background())
	t.Cleanup(w.currentRun().Stop)

	engine := newMsgChan()
	w.SetCallback("engine", engine.callback)

	w.SendFromClient("engine", "resync-to-origin", nil)

	if framesUntilBarrier(t, w, engine).saw("resync-offer") {
		t.Fatal("a worker with no document loaded offered one anyway")
	}
}
