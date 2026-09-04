//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

// TestPartialCancelledResponseCarriesReportedUsage pins what a cancelled
// round-trip records. The blob it writes is the last one in the thread, so it is
// the blob the footer anchors on — and a provider that reported its prompt size
// mid-stream has already told us what that turn sent. Discarding it writes a
// blob that reports nothing, which the footer cannot render at all: the count
// disappears for a thread whose every earlier turn has one.
func TestPartialCancelledResponseCarriesReportedUsage(t *testing.T) {
	w := NewConversationWorker("conv-cancel-usage", "user:test")
	defer w.doc.Destroy()
	r := w.currentRun()

	// The provider reported this turn's input usage before the user stopped it.
	r.processStreamChunk(StreamChunk{
		Type:         provider.ContentBlockTypeUsage,
		InputTokens:  172743,
		CachedTokens: 168000,
	})

	res := r.partialCancelledResponse()
	if res == nil {
		t.Fatal("partialCancelledResponse returned nil")
	}
	if res.StopReason != "cancelled" {
		t.Fatalf("StopReason = %q, want cancelled", res.StopReason)
	}
	if res.InputTokens != 172743 {
		t.Fatalf("InputTokens = %d, want the 172743 the provider reported before the cancel", res.InputTokens)
	}
	if provider.TokenCount(res.CachedTokens) != 168000 {
		t.Fatalf("CachedTokens = %v, want the reported 168000", res.CachedTokens)
	}
}

// TestPartialCancelledResponseReportsNothingUnreported is the complement: a
// provider that streams no usage has told us nothing, and a cancel invents
// nothing. Input stays zero and the cache figure stays nil — unknown, not a
// reported zero, which would draw as a total cache miss.
func TestPartialCancelledResponseReportsNothingUnreported(t *testing.T) {
	w := NewConversationWorker("conv-cancel-no-usage", "user:test")
	defer w.doc.Destroy()
	r := w.currentRun()

	res := r.partialCancelledResponse()
	if res == nil {
		t.Fatal("partialCancelledResponse returned nil")
	}
	if res.InputTokens != 0 {
		t.Fatalf("InputTokens = %d, want 0 when the provider reported no usage", res.InputTokens)
	}
	if res.CachedTokens != nil {
		t.Fatalf("CachedTokens = %d, want nil (unreported) rather than a reported zero", *res.CachedTokens)
	}
}

// TestCancelledUsageSurvivesMidCallFinalize guards the measurement against the
// obvious place to clear it. finalizeStreaming ends the streamed blocks, and it
// runs MID-call too — a tool_use or provider-state chunk finalizes the blocks
// and the same API call carries on. Clearing usage there would lose it for
// exactly the turns that pause, which is most agentic ones.
func TestCancelledUsageSurvivesMidCallFinalize(t *testing.T) {
	w := NewConversationWorker("conv-cancel-midcall", "user:test")
	defer w.doc.Destroy()
	r := w.currentRun()

	r.processStreamChunk(StreamChunk{
		Type:         provider.ContentBlockTypeUsage,
		InputTokens:  90000,
		CachedTokens: 80000,
	})
	r.finalizeStreaming()

	if res := r.partialCancelledResponse(); res.InputTokens != 90000 {
		t.Fatalf("InputTokens = %d after a mid-call finalize, want the reported 90000", res.InputTokens)
	}
}

// TestCancelledUsageClearedAtRoundTripBoundary is the other half of the scope:
// the measurement describes the call that reported it, so the strategy loop's
// iteration boundary drops it. Without that, a cancel late in an agentic turn
// would report the prompt size of whichever earlier round-trip last streamed a
// usage chunk.
func TestCancelledUsageClearedAtRoundTripBoundary(t *testing.T) {
	w := NewConversationWorker("conv-cancel-scope", "user:test")
	defer w.doc.Destroy()
	r := w.currentRun()

	r.processStreamChunk(StreamChunk{
		Type:         provider.ContentBlockTypeUsage,
		InputTokens:  90000,
		CachedTokens: 80000,
	})
	r.resetStreamingUsage()

	res := r.partialCancelledResponse()
	if res.InputTokens != 0 || res.CachedTokens != nil {
		t.Fatalf("usage survived the round-trip boundary: input=%d cached=%v, want 0/nil",
			res.InputTokens, res.CachedTokens)
	}
}
