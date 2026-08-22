//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package llamacpp

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"juggler/cmd/juggler/providers/openaibase"
	"juggler/cmd/juggler/providers/provider"
	"juggler/cmd/juggler/providers/utils"
)

// DefaultHost is the URL used when no explicit host is configured. 8080 is
// llama-server's own default port.
const DefaultHost = "http://127.0.0.1:8080"

// HostCredKey is the credentials.json field where the user-configured
// llama-server URL lives. Set via the settings panel; read by the shared
// LocalHost.
const HostCredKey = "llamacpp_host"

// DefaultContextWindow is advertised when the running server can't be queried
// (not up yet, metadata endpoints unreachable). A conservative non-zero value
// so a failed probe never advertises a 0-token window to the token budgeter.
//
// It is a floor, not a guess to settle for: the output reserve is derived from
// whatever window is advertised, so a server left on this value also caps every
// reply at a fifth of it. Exhaust the probes before falling back here.
const DefaultContextWindow = 8192

// server describes the local llama-server as a keyless, host-configurable
// OpenAI-compatible endpoint. The shared helper supplies host resolution, URL
// normalisation, the /v1 base URL, and the health-probe detector.
var server = openaibase.LocalHost{
	CredKey:     HostCredKey,
	EnvVar:      "LLAMACPP_HOST",
	DefaultHost: DefaultHost,
	HealthPath:  "/health",
}

// probeClient bounds the window probes (/v1/models, /props, /api/v0/models).
// All are cheap metadata reads a local server answers in milliseconds, and they
// only run after the health probe has proven the host reachable, so a short
// timeout is safe — it caps the wait when the server dies between probes, and
// window resolution falls back rather than stalling model discovery.
var probeClient = &http.Client{Timeout: time.Second}

// Register adds this provider to the global registry. Called explicitly from
// main; no init()-time side effects.
func Register() {
	openaibase.Register(openaibase.Descriptor{
		Name:            "llamacpp",
		DisplayName:     "llama.cpp (local)",
		Description:     "Runs a model locally via llama-server's OpenAI-compatible API. Start llama-server yourself first (Juggler doesn't launch it); point at a non-default host (LAN, remote workstation, custom port) below, otherwise defaults to http://127.0.0.1:8080. LM Studio also serves this API — set the host to http://127.0.0.1:1234 to use it, and Juggler will read the context window each model is loaded with.",
		AutoDetect:      server.AutoDetect(),
		DisplayProvider: "llama.cpp",
		ContextWindowFn: getContextWindowInfo,
		// Each model's real serving window lives in its /v1/models entry, which
		// the OpenAI SDK's model type drops.
		ListModelsOverride: listModels,
		BaseURLFunc:        server.BaseURLFunc(),
		APIKeyDefault:      "llamacpp", // placeholder so the OpenAI SDK accepts the request
	})
}

// modelEntry is the subset of one GET /v1/models entry we care about.
//
// meta.n_ctx is the server's slot_n_ctx: the window a single request can
// actually use, already divided by --parallel and capped to the model's
// training maximum. It is the same number /props reports, but stated per model,
// which is what a server hosting several models needs. meta is present only for
// a model the server has loaded — a router-mode llama-server lists its other
// presets without one, recording the arguments it will launch them with
// instead.
type modelEntry struct {
	ID      string   `json:"id"`
	Aliases []string `json:"aliases"`
	Meta    struct {
		NCtx int `json:"n_ctx"`
	} `json:"meta"`
	Status struct {
		Args []string `json:"args"`
	} `json:"status"`
}

// matches reports whether this entry is the model the caller named. A model is
// addressable by its id or by any of its configured aliases.
func (e modelEntry) matches(modelID string) bool {
	return e.ID == modelID || slices.Contains(e.Aliases, modelID)
}

// contextWindow returns the window this entry declares, or 0 when it declares
// none. A loaded model reports the measured window in meta; one that is merely
// configured is described only by the arguments it will be launched with.
func (e modelEntry) contextWindow() int {
	if e.Meta.NCtx > 0 {
		return e.Meta.NCtx
	}
	return ctxSizeFromArgs(e.Status.Args)
}

// getContextWindowInfo resolves the context window the local server will
// actually serve for one model, preferring the model's own /v1/models entry,
// then the single-model /props probe, then LM Studio's own model table. When
// none answers we advertise DefaultContextWindow rather than 0.
//
// The LM Studio probe comes last because it is the only one a llama-server
// never answers: ordering it behind the two native endpoints means a
// llama-server resolves exactly as it always has, without an extra request.
//
// Max output tokens is left at 0 (unknown) — neither server has an output cap
// distinct from the context window, so the caller derives the shared safety
// reserve from the window instead. That makes the window load-bearing twice
// over: understating it also shrinks every reply the model is allowed to give.
func getContextWindowInfo(modelID string) (int, int) {
	ctx := context.Background()
	if window := modelContextWindow(ctx, modelID, nil); window > 0 {
		return window, 0
	}
	if window := propsContextWindow(ctx, nil); window > 0 {
		return window, 0
	}
	if window := lmStudioWindows(ctx, nil)[modelID]; window > 0 {
		return window, 0
	}
	return DefaultContextWindow, 0
}

// modelContextWindow returns the window declared for one model id, or 0 when
// the server can't be reached or lists no such model.
func modelContextWindow(ctx context.Context, modelID string, headers map[string]string) int {
	if modelID == "" {
		return 0
	}
	entries, err := fetchModels(ctx, headers)
	if err != nil {
		return 0
	}
	for _, entry := range entries {
		if entry.matches(modelID) {
			return entry.contextWindow()
		}
	}
	return 0
}

// listModels replaces the standard SDK Models.List flow so each model is
// published with the window it will really serve, sourced from the entry the
// same request already returned. Models the server declares no window for share
// one /props probe: a llama-server old enough to omit meta from /v1/models
// hosts a single model, so its /props window is that model's window.
//
// When /props reveals nothing either, the server is LM Studio — which serves
// the /v1 surface without windows and has no /props — so its own model table
// is consulted for a window per model id.
func listModels(ctx context.Context, _ string, headers map[string]string) ([]provider.ModelInfo, error) {
	entries, err := fetchModels(ctx, headers)
	if err != nil {
		return nil, err
	}
	propsWindow, lmStudio := 0, map[string]int(nil)
	if slices.ContainsFunc(entries, func(e modelEntry) bool { return e.contextWindow() <= 0 }) {
		propsWindow = propsContextWindow(ctx, headers)
		// One shared probe for the whole list, and only when something still
		// needs it: every model LM Studio serves lacks a window above, so the
		// alternative is an identical request per model.
		if propsWindow <= 0 {
			lmStudio = lmStudioWindows(ctx, headers)
		}
	}
	models := make([]provider.ModelInfo, 0, len(entries))
	for _, entry := range entries {
		window := entry.contextWindow()
		if window <= 0 {
			window = propsWindow
		}
		if window <= 0 {
			window = lmStudio[entry.ID]
		}
		// Only a window the server actually reported counts as API-sourced; the
		// conservative constant is a fallback and is labelled as one.
		fromAPI := window > 0
		if window <= 0 {
			window = DefaultContextWindow
		}
		models = append(models, provider.ModelInfo{
			ID:            entry.ID,
			DisplayName:   utils.ModelDisplayName(entry.ID),
			ContextWindow: window,
			FromAPI:       fromAPI,
		})
	}
	return models, nil
}

// fetchModels reads the server's model table from the OpenAI-compatible
// /v1/models endpoint, which both a single-model and a router-mode llama-server
// serve.
func fetchModels(ctx context.Context, headers map[string]string) ([]modelEntry, error) {
	var models struct {
		Data []modelEntry `json:"data"`
	}
	if err := getJSON(ctx, server.Host()+"/v1/models", headers, &models); err != nil {
		return nil, fmt.Errorf("list llama.cpp models: %w", err)
	}
	return models.Data, nil
}

// propsContextWindow probes llama-server's native GET /props for the window it
// serves, returning 0 when that reveals nothing.
//
// It reveals nothing in router (multi-model) mode: a router owns no model of
// its own to describe, and answers with a placeholder whose n_ctx is 0. That is
// why a model's own /v1/models entry is consulted first — trusting /props alone
// silently pins every model on such a server to DefaultContextWindow.
func propsContextWindow(ctx context.Context, headers map[string]string) int {
	var props struct {
		DefaultGenerationSettings struct {
			NCtx int `json:"n_ctx"`
		} `json:"default_generation_settings"`
	}
	if err := getJSON(ctx, server.Host()+"/props", headers, &props); err != nil {
		return 0
	}
	if props.DefaultGenerationSettings.NCtx <= 0 {
		return 0
	}
	return props.DefaultGenerationSettings.NCtx
}

// lmStudioEntry is the subset of one GET /api/v0/models entry we care about.
//
// LM Studio serves the same OpenAI-compatible /v1 surface as llama-server but
// publishes no window there, and it does not implement /props at all — so both
// of the probes above come back empty and only this endpoint knows the answer.
//
// LoadedContextLength is the window the model is currently loaded with, and is
// the one to enforce: MaxContextLength is the architecture's ceiling, which a
// model is routinely loaded far below. Believing the ceiling would admit
// requests the server then silently truncates, since LM Studio's default
// context-overflow policy drops the middle of the conversation rather than
// refusing the request.
type lmStudioEntry struct {
	ID                  string `json:"id"`
	MaxContextLength    int    `json:"max_context_length"`
	LoadedContextLength int    `json:"loaded_context_length"`
}

// contextWindow returns the window this entry declares, or 0 when it declares
// none. A loaded model states the window it was actually loaded with; one that
// is merely downloaded describes only what its architecture could support.
func (e lmStudioEntry) contextWindow() int {
	if e.LoadedContextLength > 0 {
		return e.LoadedContextLength
	}
	return e.MaxContextLength
}

// lmStudioWindows reads the windows LM Studio declares for every model it
// lists, keyed by model id. Returns nil when the endpoint is absent or
// unreadable, which is the ordinary case for a real llama-server.
//
// LM Studio answers 200 to any path it does not implement, so a decode that
// yields no usable entries is indistinguishable from a 404 here — both simply
// produce an empty map and leave the caller's remaining fallbacks to apply.
func lmStudioWindows(ctx context.Context, headers map[string]string) map[string]int {
	var models struct {
		Data []lmStudioEntry `json:"data"`
	}
	if err := getJSON(ctx, server.Host()+"/api/v0/models", headers, &models); err != nil {
		return nil
	}
	windows := make(map[string]int, len(models.Data))
	for _, entry := range models.Data {
		if window := entry.contextWindow(); window > 0 {
			windows[entry.ID] = window
		}
	}
	return windows
}

// ctxSizeFromArgs derives the per-request window from the command line a
// router-mode server records for a model it has not loaded yet, so a configured
// model advertises its real size before first use instead of the conservative
// default. --ctx-size is the whole context, shared by --parallel slots, so a
// request gets its quotient.
//
// The result is what the user asked for, not what the server measured:
// llama-server rounds the window up to a whole batch and caps it at the model's
// training maximum, so a preset configured beyond that maximum reads high until
// the model is loaded and meta reports the truth. Returns 0 when the arguments
// set no size, leaving the caller's fallbacks to apply.
func ctxSizeFromArgs(args []string) int {
	ctxSize := intArg(args, "-c", "--ctx-size")
	if ctxSize <= 0 {
		return 0
	}
	if parallel := intArg(args, "-np", "--parallel"); parallel > 1 {
		return ctxSize / parallel
	}
	return ctxSize
}

// intArg returns the value given to the first of these flag spellings that
// appears, accepting both "--flag value" and "--flag=value", or 0 when absent
// or non-numeric.
func intArg(args []string, flags ...string) int {
	for i, arg := range args {
		for _, flag := range flags {
			if arg == flag && i+1 < len(args) {
				return parsePositiveInt(args[i+1])
			}
			if value, found := strings.CutPrefix(arg, flag+"="); found {
				return parsePositiveInt(value)
			}
		}
	}
	return 0
}

func parsePositiveInt(raw string) int {
	n, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || n <= 0 {
		return 0
	}
	return n
}

func getJSON(ctx context.Context, url string, headers map[string]string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	resp, err := probeClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("GET %s: %s", url, resp.Status)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}
