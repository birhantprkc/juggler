//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import "testing"

// providerWith builds a provider entry with one or more models.
func providerWith(name string, available bool, modelIDs ...string) ProviderStatus {
	var models []ModelWithContext
	for _, id := range modelIDs {
		models = append(models, ModelWithContext{ID: id})
	}
	return ProviderStatus{Name: name, Available: available, ModelsWithContext: models}
}

func TestPreferredAvailableModel(t *testing.T) {
	tests := []struct {
		name         string
		providers    []ProviderStatus
		wantOK       bool
		wantProvider string
		wantModel    string
	}{
		{
			name:   "no providers",
			wantOK: false,
		},
		{
			name: "none available",
			providers: []ProviderStatus{
				providerWith("claudecode", false, "sonnet"),
				providerWith("openai", false, "gpt"),
			},
			wantOK: false,
		},
		{
			name: "available but no models is skipped",
			providers: []ProviderStatus{
				providerWith("claudecode", true), // available, zero models
				providerWith("openai", true, "gpt-4"),
			},
			wantOK:       true,
			wantProvider: "openai",
			wantModel:    "gpt-4",
		},
		{
			name: "claudecode wins over codex and others",
			providers: []ProviderStatus{
				providerWith("openaicodex", true, "gpt-5-codex"),
				providerWith("anthropic", true, "claude-api"),
				providerWith("claudecode", true, "opus", "sonnet"),
			},
			wantOK:       true,
			wantProvider: "claudecode",
			wantModel:    "opus", // first model
		},
		{
			name: "codex wins when claudecode absent",
			providers: []ProviderStatus{
				providerWith("anthropic", true, "claude-api"),
				providerWith("openaicodex", true, "gpt-5-codex"),
			},
			wantOK:       true,
			wantProvider: "openaicodex",
			wantModel:    "gpt-5-codex",
		},
		{
			name: "unlisted providers ordered by name",
			providers: []ProviderStatus{
				providerWith("openai", true, "gpt-4"),
				providerWith("deepseek", true, "deepseek-chat"),
				providerWith("ollama", true, "llama"),
			},
			wantOK:       true,
			wantProvider: "deepseek",
			wantModel:    "deepseek-chat",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ref, ok := preferredAvailableModel(tt.providers)
			if ok != tt.wantOK {
				t.Fatalf("ok = %v, want %v", ok, tt.wantOK)
			}
			if !ok {
				return
			}
			if ref.Provider != tt.wantProvider || ref.Model != tt.wantModel {
				t.Fatalf("got %s/%s, want %s/%s", ref.Provider, ref.Model, tt.wantProvider, tt.wantModel)
			}
		})
	}
}
