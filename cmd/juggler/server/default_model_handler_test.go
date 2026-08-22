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

// newDefaultModelServer wires a Server with nothing but an isolated
// default-model store. An explicitly stored default short-circuits
// resolveDefaultModel before it consults the provider list, so no provider
// cache or discovery wait is needed here.
func newDefaultModelServer(t *testing.T) *Server {
	t.Helper()
	userpathstest.Isolate(t)
	store, err := core.NewDefaultModelStore()
	if err != nil {
		t.Fatalf("NewDefaultModelStore: %v", err)
	}
	return &Server{serverStores: serverStores{defaultModelStore: store}}
}

// putDefaultModel drives the PUT handler with a raw body.
func putDefaultModel(t *testing.T, s *Server, body string) {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPut, "/api/default-model", strings.NewReader(body))
	s.handleSetDefaultModel(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT status = %d, body = %s", rec.Code, rec.Body.String())
	}
}

// getDefaultModel drives the GET handler and returns the decoded body, with
// presence flags for the two optional fields — absent and empty must stay
// distinguishable, since absent is what "no tier" and "default level" mean.
func getDefaultModel(t *testing.T, s *Server) map[string]any {
	t.Helper()
	rec := httptest.NewRecorder()
	s.handleDefaultModel(rec, httptest.NewRequest(http.MethodGet, "/api/default-model", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode GET response: %v", err)
	}
	return body
}

// TestDefaultModelHandlerServiceTierRoundTrip locks the serving tier into the
// HTTP contract: PUT accepts it, the store keeps it, and GET returns it. A tier
// costs materially more than standard serving, so this is the only route by
// which one is ever preselected — it must survive the trip intact rather than
// being silently dropped, which would bill the user's chosen speed as standard
// with nothing on screen to say so.
func TestDefaultModelHandlerServiceTierRoundTrip(t *testing.T) {
	s := newDefaultModelServer(t)

	putDefaultModel(t, s, `{"provider":"openaicodex","model":"gpt-5","thinking":"high","serviceTier":"priority"}`)

	stored, err := s.defaultModelStore.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	want := core.ModelRef{Provider: "openaicodex", Model: "gpt-5", Thinking: "high", ServiceTier: "priority"}
	if stored != want {
		t.Fatalf("stored ref = %+v, want %+v", stored, want)
	}

	body := getDefaultModel(t, s)
	if body["serviceTier"] != "priority" {
		t.Fatalf("GET serviceTier = %v, want \"priority\"", body["serviceTier"])
	}
	if body["thinking"] != "high" {
		t.Fatalf("GET thinking = %v, want \"high\"", body["thinking"])
	}
	if body["explicit"] != true {
		t.Fatalf("GET explicit = %v, want true", body["explicit"])
	}
}

// TestDefaultModelHandlerOmitsAbsentServiceTier verifies standard serving is
// expressed as the ABSENCE of the field, never an empty string — the same shape
// the request path uses, where an empty tier omits the wire param entirely.
func TestDefaultModelHandlerOmitsAbsentServiceTier(t *testing.T) {
	s := newDefaultModelServer(t)

	putDefaultModel(t, s, `{"provider":"anthropic","model":"claude"}`)

	body := getDefaultModel(t, s)
	if _, present := body["serviceTier"]; present {
		t.Fatalf("standard serving must omit serviceTier, got %v", body["serviceTier"])
	}
	if _, present := body["thinking"]; present {
		t.Fatalf("the model's default level must omit thinking, got %v", body["thinking"])
	}
}

// TestDefaultModelHandlerClearsServiceTier verifies re-saving without a tier
// drops the stored one, so reverting to standard serving is possible and does
// not leave a paid tier behind.
func TestDefaultModelHandlerClearsServiceTier(t *testing.T) {
	s := newDefaultModelServer(t)

	putDefaultModel(t, s, `{"provider":"openaicodex","model":"gpt-5","serviceTier":"priority"}`)
	putDefaultModel(t, s, `{"provider":"openaicodex","model":"gpt-5"}`)

	stored, err := s.defaultModelStore.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if stored.ServiceTier != "" {
		t.Fatalf("ServiceTier = %q after clearing, want empty", stored.ServiceTier)
	}
	body := getDefaultModel(t, s)
	if _, present := body["serviceTier"]; present {
		t.Fatalf("cleared tier must be absent from GET, got %v", body["serviceTier"])
	}
}
