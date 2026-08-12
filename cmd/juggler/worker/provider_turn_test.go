//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"testing"

	provider "juggler/cmd/juggler/providers/registry"
)

// TestHandleProviderTurn_FinalizesCost is the cost-accounting invariant: an
// autonomous turn spends real tokens (a wake/monitor can drive a
// multi-million-token agentic loop), so it must be billed exactly like a
// solicited turn — every landed item stamped with one shared transactionId,
// and a transaction blob persisted carrying the turn's usage. The footer reads
// the latest blob's inputTokens, so without this the wake turn is unaccounted.
func TestHandleProviderTurn_FinalizesCost(t *testing.T) {
	w := NewConversationWorker("conv-autonomous-cost", "user:test")
	defer w.doc.Destroy()

	dir := t.TempDir()
	w.txnStore = NewTransactionStore(func(string) (string, bool) { return dir, true })

	before := len(w.doc.GetItems())
	payload, _ := json.Marshal(ProviderTurnMessage{
		Type: "provider-turn",
		Blocks: []LLMResponseBlock{
			{Type: provider.ContentBlockTypeThinking, Content: "pondering"},
			{Type: provider.ContentBlockTypeText, Content: "wake done"},
		},
		StopReason:             "end_turn",
		InputTokens:            100621,
		InputTokensApproximate: true,
		OutputTokens:           2261,
		CachedTokens:           provider.Reported(96818),
		CacheWriteTokens:       provider.Reported(3801),
		Autonomous:             true,
	})

	w.handleProviderTurn(payload)

	items := w.doc.GetItems()
	if len(items) != before+2 {
		t.Fatalf("expected 2 new items, got %d new", len(items)-before)
	}
	txnID := items[before].TransactionID
	if txnID == "" {
		t.Fatal("landed item has no transactionId — autonomous turn was not finalized")
	}
	if items[before+1].TransactionID != txnID {
		t.Fatalf("items carry different txnIds (%q vs %q) — one transaction per turn expected",
			items[before].TransactionID, items[before+1].TransactionID)
	}

	data, err := w.txnStore.Load("conv-autonomous-cost", txnID)
	if err != nil {
		t.Fatalf("transaction blob not persisted for autonomous turn: %v", err)
	}
	var blob struct {
		InputTokens            int    `json:"inputTokens"`
		InputTokensApproximate bool   `json:"inputTokensApproximate"`
		OutputTokens           int    `json:"outputTokens"`
		CachedTokens           int    `json:"cachedTokens"`
		CacheWriteTokens       int    `json:"cacheWriteTokens"`
		StopReason             string `json:"stopReason"`
	}
	if err := json.Unmarshal(data, &blob); err != nil {
		t.Fatalf("parse blob: %v", err)
	}
	if blob.InputTokens != 100621 || !blob.InputTokensApproximate || blob.OutputTokens != 2261 ||
		blob.CachedTokens != 96818 || blob.CacheWriteTokens != 3801 || blob.StopReason != "end_turn" {
		t.Fatalf("blob usage = %+v, want approximate in=100621 out=2261 cacheRead=96818 cacheWrite=3801 end_turn", blob)
	}
}

// TestHandleProviderTurn_LandsAutonomousAssistantTurn is the increment-1
// invariant: a turn the provider surfaced out-of-band (an autonomous
// wake/monitor turn delivered as a `provider-turn` inbound message) lands in
// the root conversation as a normal thinking+assistant turn. Tool_use blocks
// are deferred (no approval pipeline yet) and must be skipped, not crash.
func TestHandleProviderTurn_LandsAutonomousAssistantTurn(t *testing.T) {
	w := NewConversationWorker("conv-autonomous", "user:test")
	defer w.doc.Destroy()

	before := len(w.doc.GetItems())

	payload, err := json.Marshal(ProviderTurnMessage{
		Type: "provider-turn",
		Blocks: []LLMResponseBlock{
			{Type: provider.ContentBlockTypeThinking, Content: "pondering the wake"},
			{Type: provider.ContentBlockTypeText, Content: "monitor fired: build is green"},
			{Type: provider.ContentBlockTypeToolUse, Name: "Bash"}, // deferred — must be skipped
		},
		StopReason: "end_turn",
		Autonomous: true,
	})
	if err != nil {
		t.Fatalf("marshal provider-turn: %v", err)
	}

	w.handleProviderTurn(payload)

	items := w.doc.GetItems()
	if len(items) != before+2 {
		t.Fatalf("expected 2 new items (thinking + assistant), got %d new (%d total)", len(items)-before, len(items))
	}
	gotThinking := items[before]
	gotAssistant := items[before+1]
	if gotThinking.Type != ItemTypeThinking || gotThinking.Content != "pondering the wake" {
		t.Errorf("thinking item = {%s, %q}, want {%s, %q}", gotThinking.Type, gotThinking.Content, ItemTypeThinking, "pondering the wake")
	}
	if gotAssistant.Type != ItemTypeAssistant || gotAssistant.Content != "monitor fired: build is green" {
		t.Errorf("assistant item = {%s, %q}, want {%s, %q}", gotAssistant.Type, gotAssistant.Content, ItemTypeAssistant, "monitor fired: build is green")
	}
}

// TestHandleProviderTurn_ToolUseOnlyInsertsNothing asserts a turn carrying only
// a (deferred) tool_use block lands no items and does not panic — the claudecode
// drain stops on tool_use today, but the handler must be defensive.
func TestHandleProviderTurn_ToolUseOnlyInsertsNothing(t *testing.T) {
	w := NewConversationWorker("conv-autonomous-toolonly", "user:test")
	defer w.doc.Destroy()

	before := len(w.doc.GetItems())
	payload, _ := json.Marshal(ProviderTurnMessage{
		Type:       "provider-turn",
		Blocks:     []LLMResponseBlock{{Type: provider.ContentBlockTypeToolUse, Name: "Bash"}},
		StopReason: "tool_use",
		Autonomous: true,
	})

	w.handleProviderTurn(payload)

	if got := len(w.doc.GetItems()); got != before {
		t.Fatalf("expected no new items for a tool_use-only turn, got %d new", got-before)
	}
}
