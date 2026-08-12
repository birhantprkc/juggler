//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"testing"
	"time"

	provider "juggler/cmd/juggler/providers/registry"
)

func loadBlobMap(t *testing.T, s *TransactionStore, convID, txnID string) map[string]any {
	t.Helper()
	data, err := s.Load(convID, txnID)
	if err != nil {
		t.Fatalf("Load(%s): %v", txnID, err)
	}
	var blob map[string]any
	if err := json.Unmarshal(data, &blob); err != nil {
		t.Fatalf("parse blob: %v", err)
	}
	return blob
}

// TestSaveBlobCacheUsagePresence pins the blob contract for cache usage:
// nil pointers (provider reported nothing) leave the keys out entirely, while
// provider-reported values — including an explicit 0 — are written verbatim.
// An absent key means "unknown", so a backend that omits usage details can
// never masquerade as a 0-token cache miss in the transaction log.
func TestSaveBlobCacheUsagePresence(t *testing.T) {
	dir := t.TempDir()
	s := NewTransactionStore(func(string) (string, bool) { return dir, true })

	save := func(txnID string, resp *LLMResponse) {
		t.Helper()
		if err := s.SaveBlob(TransactionBlobInput{
			ConversationID: "conv-blob",
			TxnID:          txnID,
			Response:       resp,
			StartTime:      time.Now(),
		}); err != nil {
			t.Fatalf("SaveBlob(%s): %v", txnID, err)
		}
	}

	// Unreported: keys must be absent.
	save("txn-unreported", &LLMResponse{InputTokens: 100, OutputTokens: 5, StopReason: "end_turn"})
	blob := loadBlobMap(t, s, "conv-blob", "txn-unreported")
	if v, ok := blob["cachedTokens"]; ok {
		t.Fatalf("cachedTokens = %v, want key absent when the provider reported no cache usage", v)
	}
	if v, ok := blob["cacheWriteTokens"]; ok {
		t.Fatalf("cacheWriteTokens = %v, want key absent when the provider reported no cache usage", v)
	}

	// Explicit zero: a real report, preserved as 0.
	save("txn-zero", &LLMResponse{
		InputTokens: 100, OutputTokens: 5, StopReason: "end_turn",
		CachedTokens:     provider.Reported(0),
		CacheWriteTokens: provider.Reported(0),
	})
	blob = loadBlobMap(t, s, "conv-blob", "txn-zero")
	if v, ok := blob["cachedTokens"].(float64); !ok || v != 0 {
		t.Fatalf("cachedTokens = %v, want explicit 0", blob["cachedTokens"])
	}
	if v, ok := blob["cacheWriteTokens"].(float64); !ok || v != 0 {
		t.Fatalf("cacheWriteTokens = %v, want explicit 0", blob["cacheWriteTokens"])
	}

	// Non-zero report: written verbatim.
	save("txn-hit", &LLMResponse{
		InputTokens: 172485, OutputTokens: 9, StopReason: "end_turn",
		CachedTokens: provider.Reported(168448),
	})
	blob = loadBlobMap(t, s, "conv-blob", "txn-hit")
	if v, ok := blob["cachedTokens"].(float64); !ok || v != 168448 {
		t.Fatalf("cachedTokens = %v, want 168448", blob["cachedTokens"])
	}
}
