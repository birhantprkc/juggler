//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/server/handlers"
)

// llmCompleteTimeout bounds an HTTP-driven out-of-band completion. Slightly
// longer than the auto-namer's own bound to accommodate larger caps.
const llmCompleteTimeout = 30 * time.Second

// handleLLMComplete runs a single bounded out-of-band completion over
// QuickComplete. It backs the plugin generateText op and any UI micro-task.
//
// Body: {system?, prompt, model?, maxTokens?}. `model` is a union:
//   - omitted / "cheap" → the resolved cheap model (auto-derived from the
//     current default when unpinned); unresolvable ⇒ 400.
//   - "default"         → the resolved default model.
//   - {provider, model, thinking?} → used as-is, validated against the live list.
//
// Response: {text, usage:{inputTokens, outputTokens, cachedTokens}}. maxTokens
// is server-clamped by QuickComplete into a sane [floor, ceiling] band — the
// floor gives a reasoning cheap model room to think, so plugins never starve it
// into an empty reply.
func (s *Server) handleLLMComplete(w http.ResponseWriter, r *http.Request) {
	var req struct {
		System    string          `json:"system"`
		Prompt    string          `json:"prompt"`
		Model     json.RawMessage `json:"model"`
		MaxTokens int64           `json:"maxTokens"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		handlers.WriteJSON(w, r, http.StatusBadRequest, map[string]any{"error": "Invalid request body"})
		return
	}
	if strings.TrimSpace(req.Prompt) == "" {
		handlers.WriteJSON(w, r, http.StatusBadRequest, map[string]any{"error": "prompt is required"})
		return
	}

	modelRef, errMsg := s.resolveLLMCompleteModel(r.Context(), req.Model)
	if errMsg != "" {
		handlers.WriteJSON(w, r, http.StatusBadRequest, map[string]any{"error": errMsg})
		return
	}

	res, err := s.QuickComplete(r.Context(), QuickCompleteRequest{
		Model:  modelRef,
		System: req.System,
		Prompt: req.Prompt,
		// MaxTokens passed through verbatim: QuickComplete is the single authority
		// that clamps the output budget into [floor, ceiling], flooring it so a
		// reasoning cheap model is not starved into an empty reply.
		MaxTokens: req.MaxTokens,
		Timeout:   llmCompleteTimeout,
	})
	if err != nil {
		if errors.Is(err, ErrQuickCompleteBusy) {
			handlers.WriteJSON(w, r, http.StatusTooManyRequests, map[string]any{"error": "Too many concurrent completions, try again"})
			return
		}
		handlers.WriteJSON(w, r, http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}

	handlers.WriteJSON(w, r, 0, map[string]any{
		"text": res.Text,
		"usage": map[string]any{
			"inputTokens":  res.Usage.InputTokens,
			"outputTokens": res.Usage.OutputTokens,
			"cachedTokens": res.Usage.CachedTokens,
		},
	})
}

// resolveLLMCompleteModel resolves the request's `model` union to a concrete
// ModelRef, or returns a non-empty error message describing why it couldn't.
func (s *Server) resolveLLMCompleteModel(ctx context.Context, raw json.RawMessage) (core.ModelRef, string) {
	// Omitted / null ⇒ cheap.
	trimmed := strings.TrimSpace(string(raw))
	if len(raw) == 0 || trimmed == "null" {
		return s.resolveCheapAlias(ctx)
	}

	// String alias: "cheap" | "default".
	var alias string
	if err := json.Unmarshal(raw, &alias); err == nil {
		switch alias {
		case "", "cheap":
			return s.resolveCheapAlias(ctx)
		case "default":
			ref, _ := s.resolveDefaultModel(ctx)
			if ref.Provider == "" || ref.Model == "" {
				return core.ModelRef{}, "no default model available"
			}
			return ref, ""
		default:
			return core.ModelRef{}, "unknown model alias: " + alias
		}
	}

	// Explicit {provider, model, thinking?}.
	var obj struct {
		Provider string `json:"provider"`
		Model    string `json:"model"`
		Thinking string `json:"thinking"`
	}
	if err := json.Unmarshal(raw, &obj); err != nil || obj.Provider == "" || obj.Model == "" {
		return core.ModelRef{}, "invalid model: expected \"cheap\", \"default\", or {provider, model}"
	}
	concrete, ok := s.liveModelMatch(obj.Provider, obj.Model)
	if !ok {
		return core.ModelRef{}, "model not available: " + obj.Provider + "/" + obj.Model
	}
	return core.ModelRef{Provider: obj.Provider, Model: concrete, Thinking: obj.Thinking}, ""
}

// resolveCheapAlias resolves the "cheap" alias: the cheap model derived from the
// current default as primary. Unresolvable ⇒ a user-facing error message.
func (s *Server) resolveCheapAlias(ctx context.Context) (core.ModelRef, string) {
	primary, _ := s.resolveDefaultModel(ctx)
	ref, ok := s.resolveCheapModel(ctx, primary)
	if !ok {
		return core.ModelRef{}, "no cheap model available"
	}
	return ref, ""
}
