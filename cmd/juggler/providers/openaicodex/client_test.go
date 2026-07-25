//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaicodex

import (
	"context"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"

	"juggler/cmd/juggler/providers/openaibase"
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

func TestCodexThinkingSpecHasNoColdCacheFallback(t *testing.T) {
	replaceReasoningSpecs(map[string]openaibase.ThinkingSpec{})
	t.Cleanup(func() { replaceReasoningSpecs(map[string]openaibase.ThinkingSpec{}) })

	for _, model := range []string{"gpt-5.2-codex", "gpt-5.6-sol", "codex-max"} {
		if got := codexThinkingSpec(model); len(got.Options()) != 0 || got.Default != "" {
			t.Errorf("codexThinkingSpec(%q) = %+v, want zero spec without /models metadata", model, got)
		}
	}
}

func TestReplaceReasoningSpecsDropsStaleModels(t *testing.T) {
	replaceReasoningSpecs(map[string]openaibase.ThinkingSpec{
		"old-model": openaibase.EffortSpec("medium", "low", "medium", "high"),
	})
	replaceReasoningSpecs(map[string]openaibase.ThinkingSpec{
		"new-model": openaibase.EffortSpec("high", "high", "xhigh"),
	})
	t.Cleanup(func() { replaceReasoningSpecs(map[string]openaibase.ThinkingSpec{}) })

	if got := codexThinkingSpec("old-model"); len(got.Options()) != 0 {
		t.Fatalf("old-model retained stale levels after catalog replacement: %v", got.Options())
	}
	if got := codexThinkingSpec("new-model"); !slices.Equal(got.Options(), []string{"high", "xhigh"}) || got.Default != "high" {
		t.Fatalf("new-model spec = %+v, want replacement catalog values", got)
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
				{"slug":"gpt-5.5","visibility":"list","context_window":272000,"max_output_tokens":32768,"priority":1,
					"default_reasoning_level":"high",
					"supported_reasoning_levels":[{"effort":"low"},{"effort":"medium"},{"effort":"high"},{"effort":"xhigh"},{"effort":"max"}]},
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
	if len(models) != 8 {
		t.Fatalf("got %d models, want 8", len(models))
	}
	if models[0].ID != "gpt-5.5" || models[0].ContextWindow != 272000 || models[0].MaxOutputTokens != 32768 || !models[0].FromAPI {
		t.Fatalf("unexpected first model: %+v", models[0])
	}
	// Thinking levels come verbatim from the backend's supported_reasoning_levels,
	// not a slug heuristic: xhigh/max must survive, in order, with the API default.
	if !slices.Equal(models[0].ThinkingLevels, []string{"low", "medium", "high", "xhigh", "max"}) {
		t.Fatalf("gpt-5.5 thinking levels = %v, want API-declared [low medium high xhigh max]", models[0].ThinkingLevels)
	}
	if models[0].DefaultThinkingLevel != "high" {
		t.Fatalf("gpt-5.5 default thinking level = %q, want API-declared high", models[0].DefaultThinkingLevel)
	}
	if models[1].ID != "gpt-5.3-codex" || models[1].ContextWindow != 192000 || models[1].MaxOutputTokens != DefaultMaxOutputTokens {
		t.Fatalf("unexpected second model: %+v", models[1])
	}
	// A model that declares no supported_reasoning_levels advertises no reasoning
	// control — we no longer manufacture levels it never claimed.
	if len(models[1].ThinkingLevels) != 0 {
		t.Fatalf("gpt-5.3-codex thinking levels = %v, want none (API declared none)", models[1].ThinkingLevels)
	}
	// The wire gate resolves its spec through codexThinkingSpec, which must read
	// the same API-declared levels listModels just cached — so a turn requesting
	// xhigh is sent, not silently dropped.
	if got := codexThinkingSpec("gpt-5.5").Options(); !slices.Equal(got, []string{"low", "medium", "high", "xhigh", "max"}) {
		t.Fatalf("codexThinkingSpec(gpt-5.5) = %v, want cached API levels including xhigh", got)
	}
	fallbackIDs := map[string]bool{}
	for _, model := range models[2:] {
		fallbackIDs[model.ID] = !model.FromAPI
	}
	for _, id := range []string{"gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"} {
		if !fallbackIDs[id] {
			t.Fatalf("missing static fallback %s in %+v", id, models)
		}
		for _, model := range models[2:] {
			if model.ID == id && (len(model.ThinkingLevels) != 0 || model.DefaultThinkingLevel != "") {
				t.Fatalf("static fallback %s advertised guessed thinking metadata: %+v", id, model)
			}
		}
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
