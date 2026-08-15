//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ollama

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	provider "juggler/cmd/juggler/providers/registry"
)

// TestLiveOllamaFinalCompactionShape is a manual, daemon-backed check of the
// ForcedToolChoiceUnsupported capability against a real tool-incapable model.
// It is skipped unless JUGGLER_OLLAMA_LIVE=1 and a reachable daemon serves the
// model (default gemma3:1b, override with JUGGLER_OLLAMA_MODEL), so it never
// runs in CI. It proves the two halves that flag asserts: a forced tool call
// fails or returns nothing, while the same request as plain text returns a
// usable summary.
//
// Run it with the daemon up:
//
//	ollama serve &            # if not already running
//	ollama pull gemma3:1b
//	JUGGLER_OLLAMA_LIVE=1 go test ./cmd/juggler/providers/ollama/ \
//	    -run TestLiveOllamaFinalCompactionShape -v
func TestLiveOllamaFinalCompactionShape(t *testing.T) {
	if os.Getenv("JUGGLER_OLLAMA_LIVE") != "1" {
		t.Skip("set JUGGLER_OLLAMA_LIVE=1 with a running Ollama daemon to run this live test")
	}
	if resp, err := http.Get(DefaultHost + "/api/tags"); err != nil {
		t.Skipf("no reachable Ollama daemon at %s: %v", DefaultHost, err)
	} else {
		_ = resp.Body.Close()
	}

	model := os.Getenv("JUGGLER_OLLAMA_MODEL")
	if model == "" {
		model = "gemma3:1b"
	}

	Register()
	info, _ := provider.GetProviderInfo("ollama")
	if !info.ForcedToolChoiceUnsupported {
		t.Fatal("ollama not flagged ForcedToolChoiceUnsupported; the worker would forward a forced tool choice to it")
	}
	prov, err := provider.InitializeProvider("ollama", provider.Config{
		Model: model,
		BudgetContract: provider.BudgetContract{
			AllowUnknownLimits: true,
			ContextAdmission:   info.ContextAdmission,
		},
	})
	if err != nil {
		t.Fatalf("initialize ollama provider: %v", err)
	}
	conv, err := prov.OpenConversation(context.Background(), "oob-live-compaction")
	if err != nil {
		t.Fatalf("open conversation: %v", err)
	}
	defer func() { _ = conv.Close() }()

	const transcript = "User asked for a hello-world program in Go. The assistant supplied package main " +
		"with fmt.Println(\"hello\"). The user then asked about error handling; the assistant explained " +
		"errors.Is and wrapping with %w. Current state: the snippet compiles and runs."

	submit := func(t *testing.T, req provider.MessageRequest) (string, error) {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
		defer cancel()
		var b strings.Builder
		_, err := conv.Submit(ctx, req, func(chunk provider.StreamChunk) (*provider.ToolResult, error) {
			if chunk.Type == provider.ContentBlockTypeText {
				b.WriteString(chunk.Content)
			}
			return nil, nil
		})
		return strings.TrimSpace(b.String()), err
	}

	// A forced single-tool request: one summary tool plus a forced tool choice,
	// the shape the worker withholds from this provider.
	toolReq := provider.MessageRequest{
		SystemPrompt: "Create the final handoff summary. Return the summary via submit_summary.",
		Messages:     []provider.Message{{Type: "user", Content: transcript}},
		Tools: []provider.ToolDefinition{{
			Name:        "submit_summary",
			Description: `Return the final summary in the required "summary" string.`,
			InputSchema: json.RawMessage(`{"type":"object","properties":{"summary":{"type":"string"}},"required":["summary"]}`),
		}},
		ToolChoice:         &provider.ToolChoice{Mode: provider.ToolChoiceTool, Name: "submit_summary"},
		BypassContextGuard: true,
	}
	toolText, toolErr := submit(t, toolReq)
	t.Logf("tool-bearing final: err=%v text=%q", toolErr, toolText)
	// A forced tool call is unreliable on local models, and breaks three
	// different ways: a hard rejection (gemma3 gguf 400s), empty output (the
	// reporter's mlx builds), or the tool arguments leaking back as literal JSON
	// text (qwen3 gguf). Any of those is "not a clean summary" — which is exactly
	// why this provider is flagged and runs its turns unforced.
	toolClean := toolErr == nil && toolText != "" && !strings.HasPrefix(strings.TrimSpace(toolText), "{")
	if toolClean {
		t.Fatalf("tool-bearing final produced a clean summary on %s; expected a local model that errors, empties, or leaks JSON on a forced tool call — pick such a model to reproduce the bug", model)
	}

	// The same request without tools — the shape this provider is given instead.
	textReq := provider.MessageRequest{
		SystemPrompt:       "Create the final handoff summary from this transcript. Return only the summary.",
		Messages:           []provider.Message{{Type: "user", Content: transcript}},
		BypassContextGuard: true,
	}
	plainText, plainErr := submit(t, textReq)
	t.Logf("tool-free final: err=%v text=%q", plainErr, plainText)
	if plainErr != nil {
		t.Fatalf("tool-free final failed: %v", plainErr)
	}
	if plainText == "" {
		t.Fatal("tool-free final returned empty output; the plain-text final would not have recovered")
	}
	if strings.HasPrefix(strings.TrimSpace(plainText), "{") {
		t.Fatalf("tool-free final looks JSON-polluted, want clean prose: %q", plainText)
	}
}
