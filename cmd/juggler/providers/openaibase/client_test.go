//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaibase

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	provider "juggler/cmd/juggler/providers/registry"
)

func TestBearerTokenClientUsesAuthorizationHeader(t *testing.T) {
	var authHeader string
	var accountHeader string
	httpClient := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path != "/models" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		authHeader = r.Header.Get("Authorization")
		accountHeader = r.Header.Get("ChatGPT-Account-Id")
		var body bytes.Buffer
		_ = json.NewEncoder(&body).Encode(map[string]any{
			"object": "list",
			"data": []map[string]any{
				{"id": "gpt-5.2-codex", "object": "model", "created": 0, "owned_by": "openai"},
			},
		})
		header := make(http.Header)
		header.Set("Content-Type", "application/json")
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     header,
			Body:       io.NopCloser(&body),
		}, nil
	})}

	client, err := NewClient(Config{
		BearerToken: "oauth-token",
		Headers:     map[string]string{"ChatGPT-Account-Id": "acct_123"},
		Model:       "gpt-5.2-codex",
		BaseURL:     "https://example.test",
		HTTPClient:  httpClient,
	})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}

	_, err = client.ListModelsWithInfo(context.Background(), func(string) bool { return true }, func(string) (int, int) {
		return 128000, 16384
	}, nil, "test")
	if err != nil {
		t.Fatalf("ListModelsWithInfo: %v", err)
	}
	if authHeader != "Bearer oauth-token" {
		t.Fatalf("Authorization header = %q, want bearer token", authHeader)
	}
	if accountHeader != "acct_123" {
		t.Fatalf("ChatGPT-Account-Id header = %q, want acct_123", accountHeader)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) {
	return f(r)
}

func TestNewClientFromProviderConfigRequiresCredential(t *testing.T) {
	_, err := NewClientFromProviderConfig(provider.Config{Model: "gpt-4o"}, "", Quirks{})
	if err == nil {
		t.Fatal("expected missing credential error")
	}
	if !strings.Contains(err.Error(), "API key or bearer token") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestModelsUseResponsesAPI(t *testing.T) {
	for _, model := range []string{"gpt-5.2-codex", "gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"} {
		if !IsResponsesAPIModel(model) {
			t.Fatalf("%s should use Responses API", model)
		}
	}
	if IsResponsesAPIModel("gpt-4o") {
		t.Fatal("non-codex model should not require Responses API")
	}
}

func TestForceResponsesAPIQuirk(t *testing.T) {
	// A Chat-Completions model name normally routes to Chat Completions...
	plain := &Client{model: "gpt-5.5"}
	if plain.usesResponsesAPI() {
		t.Fatal("non-codex model without the quirk should route to Chat Completions")
	}
	// ...but the ForceResponsesAPI quirk overrides that routing.
	forced := &Client{model: "gpt-5.5", quirks: Quirks{ForceResponsesAPI: true}}
	if !forced.usesResponsesAPI() {
		t.Fatal("forced Responses API quirk should route non-codex model names to Responses")
	}
}
