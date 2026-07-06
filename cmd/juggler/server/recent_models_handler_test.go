//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/internal/userpaths/userpathstest"
)

// getRecentModels drives the GET handler and returns the decoded list.
func getRecentModels(t *testing.T, s *Server) []core.ModelRef {
	t.Helper()
	rec := httptest.NewRecorder()
	s.handleRecentModels(rec, httptest.NewRequest(http.MethodGet, "/api/recent-models", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Models []core.ModelRef `json:"models"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode GET response: %v", err)
	}
	return body.Models
}

// postRecentModel drives the POST handler for one pick.
func postRecentModel(t *testing.T, s *Server, providerName, model string) {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/recent-models",
		strings.NewReader(`{"provider":"`+providerName+`","model":"`+model+`"}`))
	s.handleRecentModels(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST status = %d, body = %s", rec.Code, rec.Body.String())
	}
}

// TestRecentModelsHandlerRoundTrip locks the HTTP contract: GET is empty
// initially, POST records most-recent-first, and a repeat pick dedups to the
// front. The server has no concept of provider availability, so recording is
// inherently decoupled from whether the model currently works.
func TestRecentModelsHandlerRoundTrip(t *testing.T) {
	userpathstest.Isolate(t)
	store, err := core.NewRecentModelsStore()
	if err != nil {
		t.Fatalf("NewRecentModelsStore: %v", err)
	}
	s := &Server{recentModelsStore: store}

	if got := getRecentModels(t, s); len(got) != 0 {
		t.Fatalf("expected empty list initially, got %v", got)
	}

	postRecentModel(t, s, "anthropic", "claude")
	postRecentModel(t, s, "openaicodex", "gpt-5")

	got := getRecentModels(t, s)
	want := []core.ModelRef{
		{Provider: "openaicodex", Model: "gpt-5"},
		{Provider: "anthropic", Model: "claude"},
	}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("after two POSTs got %v, want %v", got, want)
	}

	// Re-pick the older model — it should jump to the front, not duplicate.
	postRecentModel(t, s, "anthropic", "claude")
	got = getRecentModels(t, s)
	want = []core.ModelRef{
		{Provider: "anthropic", Model: "claude"},
		{Provider: "openaicodex", Model: "gpt-5"},
	}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("after dedup POST got %v, want %v", got, want)
	}
}

// TestRecentModelsHandlerNilStore tolerates a server with no store wired,
// returning an empty list rather than erroring.
func TestRecentModelsHandlerNilStore(t *testing.T) {
	s := &Server{}
	if got := getRecentModels(t, s); len(got) != 0 {
		t.Fatalf("expected empty list from nil store, got %v", got)
	}
}
