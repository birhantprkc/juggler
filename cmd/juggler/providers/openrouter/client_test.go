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
// context_length would leave zero input room, so listModels drops the reported
// cap and falls back to the default output cap. A normal, smaller cap passes
// through untouched.
func TestListModelsClampsOutputCapAtOrAboveWindow(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[
			{"id":"cap-equals-window","context_length":128000,"top_provider":{"max_completion_tokens":128000}},
			{"id":"cap-above-window","context_length":128000,"top_provider":{"max_completion_tokens":200000}},
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
	if got := byID["cap-equals-window"]; got != DefaultMaxOutputTokens {
		t.Fatalf("cap-equals-window MaxOutputTokens = %d, want default %d", got, DefaultMaxOutputTokens)
	}
	if got := byID["cap-above-window"]; got != DefaultMaxOutputTokens {
		t.Fatalf("cap-above-window MaxOutputTokens = %d, want default %d", got, DefaultMaxOutputTokens)
	}
	if got := byID["normal-cap"]; got != 16384 {
		t.Fatalf("normal-cap MaxOutputTokens = %d, want 16384 preserved", got)
	}
}
