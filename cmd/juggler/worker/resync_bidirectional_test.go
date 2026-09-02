//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

// Reconnect resync is a two-way exchange, and these tests pin both halves.
//
// A client's outbound Yjs updates are discarded while its socket is down —
// nothing queues them — so the ops it made during the outage exist only in its
// own doc. The worker's answer to a resync-request therefore carries its own
// state vector alongside the delta the client is missing, and the client uses
// that vector to send back exactly the ops the worker lacks. Without it, an
// edit made while disconnected never reaches the worker, which is the source of
// truth and the thing that persists to disk.
//
// A second ConversationDocument stands in for the browser client: it holds the
// same CRDT and the same encode/decode primitives the browser's Yjs does, so
// the round trip exercised here is the real one.

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

const (
	sharedContent        = "shared before the link dropped"
	workerOfflineContent = "worker wrote this while the client was away"
	clientOfflineContent = "client wrote this while the socket was down"
)

// waitForResyncResponse drains a client stream until it sees a resync-response.
func waitForResyncResponse(t *testing.T, mc *msgChan) ResyncResponseMessage {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case raw := <-mc.ch:
			var probe struct {
				Type string `json:"type"`
			}
			if json.Unmarshal(raw, &probe) != nil || probe.Type != "resync-response" {
				continue
			}
			var msg ResyncResponseMessage
			if err := json.Unmarshal(raw, &msg); err != nil {
				t.Fatalf("resync-response did not decode: %v", err)
			}
			return msg
		case <-deadline:
			t.Fatal("timed out waiting for resync-response")
			return ResyncResponseMessage{}
		}
	}
}

// docHasContent reports whether a doc holds an item with the given content.
func docHasContent(doc *ConversationDocument, content string) bool {
	for _, it := range doc.GetItems() {
		if it.Content == content {
			return true
		}
	}
	return false
}

// isDelta reports whether an update carries only new ops rather than full
// state: replayed into an empty document it must NOT reconstruct the items the
// two peers already shared. A full-state encoding would; a delta's ops depend on
// structs the empty doc lacks, so they stay pending and materialise nothing.
func isDelta(t *testing.T, update []byte, alreadyShared string) bool {
	t.Helper()
	fresh := NewConversationDocument("conv-fresh", "user:fresh")
	if err := fresh.ApplySyncUpdate(update); err != nil {
		t.Fatalf("replaying update into a fresh doc failed: %v", err)
	}
	return !docHasContent(fresh, alreadyShared)
}

// sendResyncRequest asks the worker for a catch-up on behalf of clientID.
func sendResyncRequest(t *testing.T, w *ConversationWorker, clientID string, vector []byte) {
	t.Helper()
	payload, err := json.Marshal(ResyncRequestMessage{Type: "resync-request", StateVector: vector})
	if err != nil {
		t.Fatalf("marshalling resync-request: %v", err)
	}
	w.SendFromClient(clientID, "resync-request", payload)
}

// TestResyncExchangesBothDirections is the whole handshake end to end: a client
// and the worker each write while the link is down, and after the exchange each
// holds the other's op — with only deltas on the wire in both directions.
func TestResyncExchangesBothDirections(t *testing.T) {
	w := NewConversationWorker("conv-resync", "user:test")
	w.currentRun().Start(context.Background())
	defer w.currentRun().Stop()

	mc := newMsgChan()
	w.SetCallback("client-1", mc.callback)

	// While connected: the worker writes and the client is in step with it.
	w.Document().AppendMessage(ConversationItem{
		Type: ItemTypeAssistant, ItemID: "shared", Content: sharedContent,
	})
	client := NewConversationDocument("conv-resync", "user:client")
	if err := client.ApplySyncUpdate(w.Document().ToState()); err != nil {
		t.Fatalf("initial sync failed: %v", err)
	}
	if !docHasContent(client, sharedContent) {
		t.Fatal("client did not pick up the shared item on the initial sync")
	}
	// Calibrate the delta oracle against a known full-state encoding, so the
	// delta assertions below cannot pass vacuously.
	if isDelta(t, w.Document().ToState(), sharedContent) {
		t.Fatal("delta oracle is broken: full state must reconstruct the shared item")
	}
	// Calibrate the delta oracle on a known full-state encoding, so the
	// delta assertions below cannot pass vacuously.
	if isDelta(t, w.Document().ToState(), sharedContent) {
		t.Fatal("delta oracle is broken: full state must reconstruct the shared item")
	}

	// The link drops. Both sides keep writing; neither write crosses.
	w.Document().AppendMessage(ConversationItem{
		Type: ItemTypeAssistant, ItemID: "worker-offline", Content: workerOfflineContent,
	})
	client.AppendMessage(ConversationItem{
		Type: ItemTypeUser, ItemID: "client-offline", Content: clientOfflineContent,
	})

	// Reconnect: the client asks for what it missed.
	sendResyncRequest(t, w, "client-1", client.GetStateVector())
	resp := waitForResyncResponse(t, mc)

	if len(resp.StateVector) == 0 {
		t.Fatal("resync-response carried no state vector — the client cannot compute what the worker lacks")
	}
	if !isDelta(t, resp.Bytes, sharedContent) {
		t.Fatal("worker→client half sent full state, not a delta")
	}

	// Inbound half: the client catches up on the worker's write.
	if err := client.ApplySyncUpdate(resp.Bytes); err != nil {
		t.Fatalf("applying the worker's delta failed: %v", err)
	}
	if !docHasContent(client, workerOfflineContent) {
		t.Fatal("client did not receive the op the worker made while it was away")
	}

	// Outbound half: the client answers with exactly what the worker lacks.
	reply := client.GetStateUpdate(resp.StateVector)
	if len(reply) == 0 {
		t.Fatal("client had nothing to send back, but it holds an op the worker never saw")
	}
	if !isDelta(t, reply, sharedContent) {
		t.Fatal("client→worker half sent full state, not a delta")
	}
	syncPayload, err := json.Marshal(YjsSyncMessage{Type: "yjs-sync", Bytes: reply})
	if err != nil {
		t.Fatalf("marshalling yjs-sync: %v", err)
	}
	w.SendFromClient("client-1", "yjs-sync", syncPayload)
	quiesce(t, w, mc)

	if !workerDocHasItem(w, "client-offline") {
		t.Fatal("the edit made while the socket was down never reached the worker")
	}
}

// TestResyncAnswersEvenWithNothingToSend pins the case that matters most for the
// outbound half: a client that missed nothing still needs the worker's state
// vector, because it may hold ops the worker has never seen. Answering only when
// the inbound delta is non-empty would strand exactly those ops.
func TestResyncAnswersEvenWithNothingToSend(t *testing.T) {
	w := NewConversationWorker("conv-resync-uptodate", "user:test")
	w.currentRun().Start(context.Background())
	defer w.currentRun().Stop()

	mc := newMsgChan()
	w.SetCallback("client-1", mc.callback)

	w.Document().AppendMessage(ConversationItem{
		Type: ItemTypeAssistant, ItemID: "shared", Content: sharedContent,
	})
	client := NewConversationDocument("conv-resync-uptodate", "user:client")
	if err := client.ApplySyncUpdate(w.Document().ToState()); err != nil {
		t.Fatalf("initial sync failed: %v", err)
	}

	// The worker writes nothing during the outage; the client does.
	client.AppendMessage(ConversationItem{
		Type: ItemTypeUser, ItemID: "client-offline", Content: clientOfflineContent,
	})

	sendResyncRequest(t, w, "client-1", client.GetStateVector())
	resp := waitForResyncResponse(t, mc)
	if len(resp.StateVector) == 0 {
		t.Fatal("resync-response carried no state vector")
	}

	reply := client.GetStateUpdate(resp.StateVector)
	syncPayload, err := json.Marshal(YjsSyncMessage{Type: "yjs-sync", Bytes: reply})
	if err != nil {
		t.Fatalf("marshalling yjs-sync: %v", err)
	}
	w.SendFromClient("client-1", "yjs-sync", syncPayload)
	quiesce(t, w, mc)

	if !workerDocHasItem(w, "client-offline") {
		t.Fatal("an up-to-date client's offline edit never reached the worker")
	}
}

// TestResyncResponseTargetsRequester pins that the catch-up goes to the client
// that reconnected and nobody else: it is that client's delta, and on a big
// conversation it is large.
func TestResyncResponseTargetsRequester(t *testing.T) {
	w := NewConversationWorker("conv-resync-target", "user:test")
	w.currentRun().Start(context.Background())
	defer w.currentRun().Stop()

	asker := newMsgChan()
	w.SetCallback("client-asking", asker.callback)
	bystander := newMsgChan()
	w.SetCallback("client-bystander", bystander.callback)

	w.Document().AppendMessage(ConversationItem{
		Type: ItemTypeAssistant, ItemID: "shared", Content: sharedContent,
	})

	fresh := NewConversationDocument("conv-resync-target", "user:client")
	sendResyncRequest(t, w, "client-asking", fresh.GetStateVector())
	waitForResyncResponse(t, asker)

	// Had it been broadcast, the bystander's copy would already be queued: the
	// registry fans out to every client in one op, before the asker's arrived.
	for {
		select {
		case raw := <-bystander.ch:
			var probe struct {
				Type string `json:"type"`
			}
			if json.Unmarshal(raw, &probe) == nil && probe.Type == "resync-response" {
				t.Fatal("resync-response reached a client that never asked for it")
			}
		default:
			return
		}
	}
}
