//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/internal/userpaths/userpathstest"
)

// newCheapModelServer wires a Server with nothing but an isolated cheap-model
// store. An explicit pin short-circuits both handlers before they consult the
// provider list, so no provider cache or discovery wait is needed here.
func newCheapModelServer(t *testing.T) *Server {
	t.Helper()
	userpathstest.Isolate(t)
	store, err := core.NewCheapModelStore()
	if err != nil {
		t.Fatalf("NewCheapModelStore: %v", err)
	}
	return &Server{serverStores: serverStores{cheapModelStore: store}}
}

// putCheapModel drives the PUT handler with a raw body.
func putCheapModel(t *testing.T, s *Server, body string) {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPut, "/api/cheap-model", strings.NewReader(body))
	s.handleSetCheapModel(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT status = %d, body = %s", rec.Code, rec.Body.String())
	}
}

// getCheapModel drives the GET handler and returns the decoded body. Absent and
// empty must stay distinguishable: absent is what "no tier" and "the model's
// default level" mean.
func getCheapModel(t *testing.T, s *Server) map[string]any {
	t.Helper()
	rec := httptest.NewRecorder()
	s.handleCheapModel(rec, httptest.NewRequest(http.MethodGet, "/api/cheap-model", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode GET response: %v", err)
	}
	return body
}

// TestCheapModelHandlerServiceTierRoundTrip locks the serving tier into the
// cheap model's HTTP contract, matching the default model's: PUT accepts it, the
// store keeps it, and GET returns it. The picker offers the tier on this row too,
// so dropping it here would silently bill a chosen speed as standard.
func TestCheapModelHandlerServiceTierRoundTrip(t *testing.T) {
	s := newCheapModelServer(t)

	putCheapModel(t, s, `{"provider":"openaicodex","model":"gpt-5-mini","thinking":"low","serviceTier":"priority"}`)

	stored, err := s.cheapModelStore.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	want := core.ModelRef{Provider: "openaicodex", Model: "gpt-5-mini", Thinking: "low", ServiceTier: "priority"}
	if stored != want {
		t.Fatalf("stored ref = %+v, want %+v", stored, want)
	}

	body := getCheapModel(t, s)
	if body["serviceTier"] != "priority" {
		t.Fatalf("GET serviceTier = %v, want \"priority\"", body["serviceTier"])
	}
	if body["thinking"] != "low" {
		t.Fatalf("GET thinking = %v, want \"low\"", body["thinking"])
	}
	if body["explicit"] != true {
		t.Fatalf("GET explicit = %v, want true", body["explicit"])
	}
}

// TestCheapModelHandlerOmitsAbsentServiceTier verifies standard serving is
// expressed as the ABSENCE of the field, never an empty string.
func TestCheapModelHandlerOmitsAbsentServiceTier(t *testing.T) {
	s := newCheapModelServer(t)

	putCheapModel(t, s, `{"provider":"anthropic","model":"claude-haiku"}`)

	body := getCheapModel(t, s)
	if _, present := body["serviceTier"]; present {
		t.Fatalf("standard serving must omit serviceTier, got %v", body["serviceTier"])
	}
	if _, present := body["thinking"]; present {
		t.Fatalf("the model's default level must omit thinking, got %v", body["thinking"])
	}
}

// TestCheapModelHandlerClearsServiceTier verifies re-saving without a tier drops
// the stored one, so reverting to standard serving leaves no paid tier behind.
func TestCheapModelHandlerClearsServiceTier(t *testing.T) {
	s := newCheapModelServer(t)

	putCheapModel(t, s, `{"provider":"openaicodex","model":"gpt-5-mini","serviceTier":"priority"}`)
	putCheapModel(t, s, `{"provider":"openaicodex","model":"gpt-5-mini"}`)

	stored, err := s.cheapModelStore.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if stored.ServiceTier != "" {
		t.Fatalf("ServiceTier = %q after clearing, want empty", stored.ServiceTier)
	}
	body := getCheapModel(t, s)
	if _, present := body["serviceTier"]; present {
		t.Fatalf("cleared tier must be absent from GET, got %v", body["serviceTier"])
	}
}

// TestResolveCheapModelKeepsServiceTier pins the tier's survival through
// resolution, not just storage: the pinned ref is what callers actually run
// with, so a tier lost between Load and the returned ref would never be spent.
func TestResolveCheapModelKeepsServiceTier(t *testing.T) {
	registerCheapTestProvider("cheaptest", "cheap-mini")
	s := newCheapResolveServer(t, []ProviderStatus{
		{Name: "cheaptest", Available: true, ModelsWithContext: []ModelWithContext{{ID: "cheap-mini"}}},
	})
	pinned := core.ModelRef{Provider: "cheaptest", Model: "cheap-mini", ServiceTier: "priority"}
	if err := s.cheapModelStore.Save(pinned); err != nil {
		t.Fatalf("Save: %v", err)
	}

	got, ok := s.resolveCheapModel(context.Background(), core.ModelRef{})
	if !ok {
		t.Fatal("expected the explicit pin to resolve")
	}
	if got != pinned {
		t.Fatalf("resolveCheapModel = %+v, want %+v", got, pinned)
	}
}
