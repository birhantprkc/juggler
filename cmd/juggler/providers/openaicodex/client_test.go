//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaicodex

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	provider "juggler/cmd/juggler/providers/registry"
)

func TestRegisterProviderInfo(t *testing.T) {
	Register()
	info, ok := provider.GetProviderInfo("openaicodex")
	if !ok {
		t.Fatal("openaicodex provider not registered")
	}
	if info.EffectiveAuthType() != provider.AuthTypeOAuthBearer {
		t.Fatalf("auth type = %q, want %q", info.EffectiveAuthType(), provider.AuthTypeOAuthBearer)
	}
	if info.AuthSource != "codex_cli" {
		t.Fatalf("auth source = %q, want codex_cli", info.AuthSource)
	}
	if info.ConfigKeyName != "" {
		t.Fatalf("ConfigKeyName = %q, want empty for OAuth provider", info.ConfigKeyName)
	}
}

func TestListModelsParsesCodexCatalog(t *testing.T) {
	originalBaseURL := baseURL
	baseURL = ""
	t.Cleanup(func() { baseURL = originalBaseURL })

	var authHeader string
	var accountHeader string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/models" {
			t.Fatalf("path = %q, want /models", r.URL.Path)
		}
		if r.URL.Query().Get("client_version") == "" {
			t.Fatal("client_version query was not set")
		}
		authHeader = r.Header.Get("Authorization")
		accountHeader = r.Header.Get("ChatGPT-Account-Id")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"models": [
				{"slug":"hidden-model","visibility":"hidden","context_window":1,"priority":0},
				{"slug":"gpt-5.5","visibility":"list","context_window":272000,"max_output_tokens":32768,"priority":1},
				{"slug":"gpt-5.3-codex","visibility":"list","max_context_window":192000,"priority":2}
			]
		}`))
	}))
	defer server.Close()
	baseURL = server.URL

	models, err := listModels(context.Background(), "token", map[string]string{"ChatGPT-Account-Id": "acct_123"})
	if err != nil {
		t.Fatalf("listModels: %v", err)
	}
	if authHeader != "Bearer token" {
		t.Fatalf("Authorization header = %q, want bearer token", authHeader)
	}
	if accountHeader != "acct_123" {
		t.Fatalf("ChatGPT-Account-Id header = %q, want acct_123", accountHeader)
	}
	if len(models) != 2 {
		t.Fatalf("got %d models, want 2", len(models))
	}
	if models[0].ID != "gpt-5.5" || models[0].ContextWindow != 272000 || models[0].MaxOutputTokens != 32768 || !models[0].FromAPI {
		t.Fatalf("unexpected first model: %+v", models[0])
	}
	if models[1].ID != "gpt-5.3-codex" || models[1].ContextWindow != 192000 || models[1].MaxOutputTokens != DefaultMaxOutputTokens {
		t.Fatalf("unexpected second model: %+v", models[1])
	}
}

func TestUsageStatsCallsCodexEndpoint(t *testing.T) {
	originalBaseURL := baseURL
	baseURL = ""
	t.Cleanup(func() { baseURL = originalBaseURL })

	var authHeader string
	var accountHeader string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/usage" {
			t.Fatalf("path = %q, want /usage", r.URL.Path)
		}
		authHeader = r.Header.Get("Authorization")
		accountHeader = r.Header.Get("ChatGPT-Account-Id")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"plan_type": "pro",
			"rate_limit": {
				"primary_window": {"used_percent": 42, "reset_at": 2000, "limit_window_seconds": 18000}
			}
		}`))
	}))
	defer server.Close()
	baseURL = server.URL

	stats, err := usageStats(context.Background(), "token", map[string]string{"ChatGPT-Account-Id": "acct_123"})
	if err != nil {
		t.Fatalf("usageStats: %v", err)
	}
	if authHeader != "Bearer token" {
		t.Fatalf("Authorization header = %q, want bearer token", authHeader)
	}
	if accountHeader != "acct_123" {
		t.Fatalf("ChatGPT-Account-Id header = %q, want acct_123", accountHeader)
	}
	if stats.Plan != "pro" || len(stats.Stats) != 1 || derefPct(stats.Stats[0].UsedPercent) != 42 {
		t.Fatalf("unexpected stats: %+v", stats)
	}
}
