//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openrouter

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestListModelsClampsOutputCapAtOrAboveWindow pins the F2 source clamp: an
// OpenRouter catalog entry whose max_completion_tokens is at or above its
// context_length would leave zero input room, so listModels replaces the
// reported cap with the reserve derived from the window — the same answer the
// server would reach, so the listed number and the enforced one agree. A
// normal, smaller cap passes through untouched, and a model with no window at
// all has nothing to derive from and keeps the flat default.
func TestListModelsClampsOutputCapAtOrAboveWindow(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[
			{"id":"cap-equals-window","context_length":128000,"top_provider":{"max_completion_tokens":128000}},
			{"id":"cap-above-window","context_length":128000,"top_provider":{"max_completion_tokens":200000}},
			{"id":"no-cap-reported","context_length":128000,"top_provider":{}},
			{"id":"normal-cap","context_length":128000,"top_provider":{"max_completion_tokens":16384}}
		]}`))
	}))
	defer srv.Close()

	orig := baseURL
	baseURL = srv.URL
	defer func() { baseURL = orig }()

	infos, err := listModels(context.Background(), "key", nil)
	if err != nil {
		t.Fatalf("listModels: %v", err)
	}
	byID := map[string]int{}
	for _, info := range infos {
		byID[info.ID] = info.MaxOutputTokens
	}
	// A 128000 window derives a 20000 reserve (a fifth, capped at 20k).
	const derivedReserve = 20000
	for _, id := range []string{"cap-equals-window", "cap-above-window", "no-cap-reported"} {
		if got := byID[id]; got != derivedReserve {
			t.Errorf("%s MaxOutputTokens = %d, want the derived reserve %d", id, got, derivedReserve)
		}
	}
	if got := byID["normal-cap"]; got != 16384 {
		t.Fatalf("normal-cap MaxOutputTokens = %d, want 16384 preserved", got)
	}
}
