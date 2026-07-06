//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration_test

import (
	"context"
	"encoding/json"
	"fmt"
	"sync/atomic"
	"testing"
	"time"

	"juggler/cmd/juggler/worker"
	"juggler/tests/integration/helpers"
)

// waitForPendingItems polls until the thread ("" => root) has a queued message
// parked in pendingItems, or the timeout elapses. Lets a test deterministically
// wait for a busy-time send to land in the queue before releasing the in-flight
// turn (so the turn promotes the queued message rather than racing it in fresh).
func waitForPendingItems(ts *helpers.TestSession, threadItemID string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if ts.Worker.HasPendingItems(threadItemID) {
			return nil
		}
		time.Sleep(5 * time.Millisecond)
	}
	return fmt.Errorf("pending items never appeared for thread %q", threadItemID)
}

// waitForLLMCall polls until the mock sequence has recorded at least `want`
// calls (i.e. the worker dispatched the turn), or the timeout elapses.
func waitForLLMCall(seq *helpers.LLMSequence, want int, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if seq.CallCount() >= want {
			return nil
		}
		time.Sleep(5 * time.Millisecond)
	}
	return fmt.Errorf("LLM call count never reached %d (got %d)", want, seq.CallCount())
}

// TestImageAttachmentReachesProviderRequest is B1: a user message sent with an
// image attachment must (a) reach the provider as an image "part" referencing
// the asset by id+mime, and (b) carry the attachment ref on the user item in
// the doc. The capturing mock LLM (LLMSequence.LastRequest) records the exact
// request the worker built, so this asserts the real buildMessages → parts
// path end-to-end without a live provider.
func TestImageAttachmentReachesProviderRequest(t *testing.T) {
	t.Parallel()
	ts := helpers.SetupTestSession(t)
	ts.SetupMockEngine()

	seq := ts.SetLLMSequence(helpers.TextResponse("Got the image."))

	// A model must be set or send-message bails on validation. Capability
	// gating lives in the UI, not the worker — buildMessages emits parts for
	// any model — so a bare test model is sufficient to prove the wire shape.
	ts.GetDocument().SetMetadata("defaultModelConfig", map[string]any{
		"provider": "test",
		"model":    "test-model",
	})

	att := worker.AssetRef{
		ID:       "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		Mime:     "image/png",
		Filename: "pixel.png",
		Bytes:    95,
		Width:    1,
		Height:   1,
	}

	send, _ := json.Marshal(worker.SendMessageMessage{
		Type:        "send-message",
		Text:        "describe this image",
		Attachments: []worker.AssetRef{att},
	})
	ts.Manager.HandleMessage(ts.ConvID, "send-message", send, nil)

	// Dispatch is async (requestLLM sets activity; the reducer picks it up a
	// tick later), so fence on the LLM call actually happening rather than on
	// a worker state that is still idle the instant send returns.
	if err := waitForLLMCall(seq, 1, 5*time.Second); err != nil {
		t.Fatalf("LLM was never called after send: %v", err)
	}

	// (a) The captured provider request must carry the image part.
	req := seq.LastRequest()
	if req == nil {
		t.Fatal("no request captured by the mock LLM")
	}
	parts := helpers.ImagePartsInRequest(req)
	if len(parts) != 1 {
		t.Fatalf("expected exactly 1 image part in the request, got %d (req=%s)", len(parts), string(req))
	}
	if got, _ := parts[0]["assetId"].(string); got != att.ID {
		t.Errorf("image part assetId = %q, want %q", got, att.ID)
	}
	if got, _ := parts[0]["mime"].(string); got != att.Mime {
		t.Errorf("image part mime = %q, want %q", got, att.Mime)
	}

	// (b) The user item in the doc must carry the attachment ref.
	items := ts.GetDocument().GetItems()
	var user *worker.ConversationItem
	for i := range items {
		if items[i].Type == worker.ItemTypeUser {
			user = &items[i]
			break
		}
	}
	if user == nil {
		t.Fatalf("no user item in doc; items=%+v", items)
	}
	if len(user.Attachments) != 1 {
		t.Fatalf("user item carries %d attachments, want 1", len(user.Attachments))
	}
	if user.Attachments[0].ID != att.ID || user.Attachments[0].Mime != att.Mime {
		t.Errorf("doc attachment ref = %+v, want id=%q mime=%q",
			user.Attachments[0], att.ID, att.Mime)
	}
}

// TestTextMessageEmitsNoParts guards the backward-compatible path: a plain
// user message (no attachments) must produce a request with no image parts and
// a doc item with no attachment refs — byte-for-byte the legacy shape.
func TestTextMessageEmitsNoParts(t *testing.T) {
	t.Parallel()
	ts := helpers.SetupTestSession(t)
	ts.SetupMockEngine()

	seq := ts.SetLLMSequence(helpers.TextResponse("OK."))
	ts.GetDocument().SetMetadata("defaultModelConfig", map[string]any{
		"provider": "test",
		"model":    "test-model",
	})

	send, _ := json.Marshal(worker.SendMessageMessage{Type: "send-message", Text: "hello"})
	ts.Manager.HandleMessage(ts.ConvID, "send-message", send, nil)

	if err := waitForLLMCall(seq, 1, 5*time.Second); err != nil {
		t.Fatalf("LLM was never called after send: %v", err)
	}

	if parts := helpers.ImagePartsInRequest(seq.LastRequest()); len(parts) != 0 {
		t.Fatalf("plain text message produced %d image parts, want 0", len(parts))
	}
	for _, it := range ts.GetDocument().GetItems() {
		if it.Type == worker.ItemTypeUser && len(it.Attachments) != 0 {
			t.Fatalf("plain text user item carries attachments: %+v", it.Attachments)
		}
	}
}

// TestQueuedImageAttachmentReachesProviderRequest is the regression for the
// dropped-queued-image bug: a message sent with an image WHILE A TURN IS IN
// FLIGHT is queued ("type while busy") and promoted at the next boundary. The
// promoted turn must reach the provider carrying its image part — the queue
// path must not split the text from its attachments.
//
// The first LLM call is gated so the worker stays busy while the image message
// is sent; releasing it promotes the queued message and dispatches a second
// call, whose captured request must carry the image part.
func TestQueuedImageAttachmentReachesProviderRequest(t *testing.T) {
	t.Parallel()
	ts := helpers.SetupTestSession(t)
	ts.SetupMockEngine()

	ts.GetDocument().SetMetadata("defaultModelConfig", map[string]any{
		"provider": "test",
		"model":    "test-model",
	})

	// Two responses: the in-flight turn, then the promoted queued turn.
	seq := helpers.NewLLMSequence(
		helpers.TextResponse("working on the first message"),
		helpers.TextResponse("got the queued image"),
	)
	base := seq.AsCallFunc()

	// Gate the FIRST LLM call so the worker is genuinely busy when the image
	// message arrives. firstSeen fires once the turn is in flight; release lets
	// it complete.
	firstSeen := make(chan struct{})
	release := make(chan struct{})
	var gated int32
	gatedFn := func(ctx context.Context, req json.RawMessage, cb func(worker.StreamChunk)) (*worker.LLMResponse, error) {
		if atomic.CompareAndSwapInt32(&gated, 0, 1) {
			close(firstSeen)
			<-release
		}
		return base(ctx, req, cb)
	}
	ts.Manager.SetLLMCaller(gatedFn)
	ts.Worker.SetLLMCaller(gatedFn)

	// 1. Plain first message → starts a turn that blocks in the gated call.
	send1, _ := json.Marshal(worker.SendMessageMessage{Type: "send-message", Text: "first message"})
	ts.Manager.HandleMessage(ts.ConvID, "send-message", send1, nil)
	select {
	case <-firstSeen:
	case <-time.After(5 * time.Second):
		t.Fatal("first LLM call never started; worker never became busy")
	}

	// 2. While busy, send a second message carrying an image — must be QUEUED.
	att := worker.AssetRef{
		ID:       "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		Mime:     "image/png",
		Filename: "pixel.png",
		Bytes:    95,
		Width:    1,
		Height:   1,
	}
	send2, _ := json.Marshal(worker.SendMessageMessage{
		Type:        "send-message",
		Text:        "describe this queued image",
		Attachments: []worker.AssetRef{att},
	})
	ts.Manager.HandleMessage(ts.ConvID, "send-message", send2, nil)

	// Fence on the message actually landing in the queue, so releasing the turn
	// promotes it rather than racing it in as a fresh (non-busy) send.
	if err := waitForPendingItems(ts, "", 5*time.Second); err != nil {
		t.Fatalf("second send never queued: %v", err)
	}

	// 3. Release the first turn → worker promotes the queued message and
	//    dispatches a second LLM call for it.
	close(release)
	if err := waitForLLMCall(seq, 2, 5*time.Second); err != nil {
		t.Fatalf("queued message never drove a second LLM call: %v", err)
	}

	// The promoted turn's request MUST carry the image part. Before the fix,
	// enqueuePendingMessage built the queued item from bare text, so the
	// promoted item — and this request — had no attachment at all.
	reqs := seq.Requests()
	if len(reqs) < 2 {
		t.Fatalf("expected at least 2 captured requests, got %d", len(reqs))
	}
	parts := helpers.ImagePartsInRequest(reqs[1])
	if len(parts) != 1 {
		t.Fatalf("queued turn's request carried %d image parts, want 1 (req=%s)", len(parts), string(reqs[1]))
	}
	if got, _ := parts[0]["assetId"].(string); got != att.ID {
		t.Errorf("image part assetId = %q, want %q", got, att.ID)
	}

	// And the promoted user item in the doc must carry the attachment ref.
	var queued *worker.ConversationItem
	for _, it := range ts.GetDocument().GetItems() {
		if it.Type == worker.ItemTypeUser && it.Content == "describe this queued image" {
			item := it
			queued = &item
		}
	}
	if queued == nil {
		t.Fatal("promoted queued user item not found in doc")
	}
	if len(queued.Attachments) != 1 || queued.Attachments[0].ID != att.ID {
		t.Fatalf("promoted user item attachments = %+v, want one ref id=%q", queued.Attachments, att.ID)
	}
}
