//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"fmt"
	"net/http"
	"strings"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/providers/provider"
	"juggler/internal/jlog"
	"juggler/internal/userpaths"
)

// Raw credentials.json keys for non-API-key settings persisted via /api/config.
// Kept in sync with the producing packages (e.g. ollama.HostCredKey,
// claudecode.BinaryPathCredKey) — the frontend posts these literal names.
const (
	ollamaHostKey              = "ollama_host"
	llamacppHostKey            = "llamacpp_host"
	claudecodeBinaryPathKey    = "claudecode_binary_path"
	openaiCompatibleBaseURLKey = "openai_compatible_base_url"
	openaiCompatibleHeadersKey = "openai_compatible_headers"
	streamIdleTimeoutKey       = "stream_idle_timeout" // mirrors streamidle.CredKey
	// autoCompactDisabledKey stores the disabled state of automatic compaction,
	// so an absent/empty value means enabled (the default). "1" means disabled.
	// Mirrored by createAutoCompactGate in server/llm_caller.go.
	autoCompactDisabledKey = "auto_compact_disabled"
	// autoNameDisabledKey stores the disabled state of tab auto-naming, so an
	// absent/empty value means enabled (the default). "1" means disabled. Read
	// live by server/auto_name.go's autoNamer (gates the LLM namer) and mirrored
	// on the client by services/auto-name-setting.js (gates the new-tab rename
	// prompt vs. focusing the composer).
	autoNameDisabledKey = "auto_name_disabled"
	// autoNameInstructionKey stores an optional custom title instruction for the
	// tab auto-namer, replacing the built-in autoNameTitleInstruction. Empty ⇒ the
	// built-in one applies. The fixed data guard is appended server-side either way.
	autoNameInstructionKey = "auto_name_instruction"
)

// ConfigAPI handles configuration-related HTTP requests. It reads the
// project path through a provider func so that runtime project switches
// transparently retarget config I/O. onCredsChanged is invoked whenever
// the credentials store has been mutated, so the server can refresh and
// broadcast the provider list.
type ConfigAPI struct {
	pathProvider     func() string
	credStore        *core.CredentialsStore
	onCredsChanged   func()
	onPluginsChanged func()
	// AutoNameDefaultPrompt is the built-in tab auto-naming system prompt, echoed
	// to the client in the config GET so the settings UI shows it verbatim as the
	// custom-instruction placeholder — the exact prompt a custom one replaces.
	// Owned by server/auto_name.go and set by the server after construction;
	// empty for handlers that don't wire it (e.g. one-shot CLI tools).
	AutoNameDefaultPrompt string
}

// NewConfigAPI creates a new ConfigAPI. pathProvider must return the current
// project path on each call (empty string indicates no-project mode, in
// which case config reads/writes return errors). onCredsChanged is called
// after every credential mutation; may be nil for handlers that don't need
// to refresh the provider list (e.g. one-shot CLI tools).
func NewConfigAPI(pathProvider func() string, onCredsChanged func(), onPluginsChanged func()) (*ConfigAPI, error) {
	if pathProvider == nil {
		return nil, fmt.Errorf("pathProvider is required")
	}
	credStore, err := core.NewCredentialsStore()
	if err != nil {
		return nil, fmt.Errorf("failed to create credentials store: %w", err)
	}
	return &ConfigAPI{
		pathProvider:     pathProvider,
		credStore:        credStore,
		onCredsChanged:   onCredsChanged,
		onPluginsChanged: onPluginsChanged,
	}, nil
}

func (c *ConfigAPI) fireCredsChanged() {
	if c.onCredsChanged != nil {
		c.onCredsChanged()
	}
}

func (c *ConfigAPI) firePluginsChanged() {
	if c.onPluginsChanged != nil {
		c.onPluginsChanged()
	}
}

// projectPath returns the current project path, or "" if none.
func (c *ConfigAPI) projectPath() string { return c.pathProvider() }

// HandleGetConfig returns the current configuration (without sensitive data)
func (c *ConfigAPI) HandleGetConfig(w http.ResponseWriter, r *http.Request) {
	// Load current config
	cfg, err := core.LoadConfig(c.projectPath())
	if err != nil {
		WriteError(w, r, http.StatusInternalServerError, fmt.Sprintf("Failed to load config: %v", err))
		return
	}

	// Build keys map dynamically from registered providers
	keys := make(map[string]any)
	providerInfos := provider.ListProviderInfos()
	for _, info := range providerInfos {
		keys[info.Name] = c.credStore.HasKey(info.Name)
	}

	// Return config without exposing actual API keys (just show if they're set)
	response := map[string]any{
		"model": cfg.GetModel(),
		"keys":  keys,
		// Platform-correct config directory (XDG on Linux, ~/.juggler on
		// macOS/Windows) so the settings UI can name the real credentials
		// path instead of a hardcoded, wrong-on-Linux literal.
		"configDir": userpaths.ConfigDir(),
		"server": map[string]any{
			"host": cfg.Server.Host,
			"port": cfg.Server.Port,
		},
		"ollamaHost":              c.credStore.GetRawKey(ollamaHostKey),
		"llamacppHost":            c.credStore.GetRawKey(llamacppHostKey),
		"claudecodeBinaryPath":    c.credStore.GetRawKey(claudecodeBinaryPathKey),
		"openaiCompatibleBaseURL": c.credStore.GetRawKey(openaiCompatibleBaseURLKey),
		"openaiCompatibleHeaders": c.credStore.GetRawKey(openaiCompatibleHeadersKey),
		"streamIdleTimeout":       c.credStore.GetRawKey(streamIdleTimeoutKey),
		"autoCompactDisabled":     c.credStore.GetRawKey(autoCompactDisabledKey) == "1",
		"autoNameDisabled":        c.credStore.GetRawKey(autoNameDisabledKey) == "1",
		"autoNameInstruction":     c.credStore.GetRawKey(autoNameInstructionKey),
		"autoNameDefaultPrompt":   c.AutoNameDefaultPrompt,
	}

	WriteJSON(w, r, 0, response)
}

// HandleUpdateConfig updates the configuration
func (c *ConfigAPI) HandleUpdateConfig(w http.ResponseWriter, r *http.Request) {
	// Decode as generic map to handle dynamic provider keys
	req, ok := DecodeJSON[map[string]any](w, r)
	if !ok {
		return
	}

	// Track which providers now have keys
	providersWithKeys := []string{}

	// Get all registered providers to validate incoming keys
	providerInfos := provider.ListProviderInfos()
	configKeyToProvider := make(map[string]string)
	for _, info := range providerInfos {
		if info.ConfigKeyName == "" {
			continue
		}
		configKeyToProvider[info.ConfigKeyName] = info.Name
	}

	// Update API keys in credentials store (stored in ~/.juggler/credentials.json)
	// Process all fields that match provider config key names
	for key, value := range req {
		// Check if this key matches a provider's config key name
		if providerName, ok := configKeyToProvider[key]; ok {
			// This is a provider API key
			if apiKey, ok := value.(string); ok {
				// Empty string means delete, non-empty means save
				if err := c.credStore.SetAPIKey(providerName, apiKey); err != nil {
					WriteError(w, r, http.StatusInternalServerError, fmt.Sprintf("Failed to save %s API key: %v", providerName, err))
					return
				}
				if apiKey != "" {
					providersWithKeys = append(providersWithKeys, providerName)
				}
			}
		}
	}

	// Handle Ollama daemon host override (raw credential). Triggers a provider refresh via fireCredsChanged so the model
	// list re-fetches against the new host.
	if hostValue, ok := req[ollamaHostKey]; ok {
		if hostStr, ok := hostValue.(string); ok {
			if err := c.credStore.SetRawKey(ollamaHostKey, hostStr); err != nil {
				jlog.Error("Failed to save Ollama host: %v", err)
			}
		}
	}

	// Handle the llama-server host override (raw credential), same shape as the
	// Ollama one above: fireCredsChanged refreshes the provider list so the
	// model list (and its context window, queried live from /props) re-fetches
	// against the new host.
	if hostValue, ok := req[llamacppHostKey]; ok {
		if hostStr, ok := hostValue.(string); ok {
			if err := c.credStore.SetRawKey(llamacppHostKey, hostStr); err != nil {
				jlog.Error("Failed to save llama.cpp host: %v", err)
			}
		}
	}

	// Handle the Claude Code CLI binary-path override (raw credential). The
	// claudecode provider reads it live, ahead of auto-detection, so a path for
	// an obscure install location takes effect on the next turn. fireCredsChanged
	// (below) refreshes the provider list. Enabling the provider is left to the
	// settings UI's toggle (the frontend flips it when a path is saved).
	if pathValue, ok := req[claudecodeBinaryPathKey]; ok {
		if pathStr, ok := pathValue.(string); ok {
			if err := c.credStore.SetRawKey(claudecodeBinaryPathKey, strings.TrimSpace(pathStr)); err != nil {
				jlog.Error("Failed to save Claude Code binary path: %v", err)
			}
		}
	}

	// Handle the OpenAI-compatible gateway base URL and custom headers (raw
	// credentials). The openaicompat provider reads both live at client
	// construction; fireCredsChanged (below) refreshes the provider list so the
	// model catalogue re-fetches against the new gateway.
	if v, ok := req[openaiCompatibleBaseURLKey]; ok {
		if s, ok := v.(string); ok {
			if err := c.credStore.SetRawKey(openaiCompatibleBaseURLKey, strings.TrimSpace(s)); err != nil {
				jlog.Error("Failed to save OpenAI-compatible base URL: %v", err)
			}
		}
	}
	if v, ok := req[openaiCompatibleHeadersKey]; ok {
		if s, ok := v.(string); ok {
			if err := c.credStore.SetRawKey(openaiCompatibleHeadersKey, strings.TrimSpace(s)); err != nil {
				jlog.Error("Failed to save OpenAI-compatible headers: %v", err)
			}
		}
	}

	// Handle the global stream idle timeout (raw credential, whole seconds). The
	// streamidle resolver reads it live at each stream start, so a new value
	// takes effect on the next turn without a restart. Blank/invalid clears the
	// override (the provider watchdog falls back to its 180s default).
	if v, ok := req[streamIdleTimeoutKey]; ok {
		if s, ok := v.(string); ok {
			if err := c.credStore.SetRawKey(streamIdleTimeoutKey, strings.TrimSpace(s)); err != nil {
				jlog.Error("Failed to save stream idle timeout: %v", err)
			}
		}
	}

	// Handle the global auto-compaction off switch (raw credential). Stored as
	// the disabled state so an absent/empty key means enabled (default). Accepts
	// a bool or the string "1"/"" ; empty clears the key (back to default-on).
	// The gate resolver reads it live (GetRawKey re-reads disk), so a toggle
	// takes effect on the next turn without a restart.
	if v, ok := req[autoCompactDisabledKey]; ok {
		disabled := false
		switch t := v.(type) {
		case bool:
			disabled = t
		case string:
			disabled = strings.TrimSpace(t) == "1"
		}
		stored := ""
		if disabled {
			stored = "1"
		}
		if err := c.credStore.SetRawKey(autoCompactDisabledKey, stored); err != nil {
			jlog.Error("Failed to save auto-compaction setting: %v", err)
		}
	}

	// Handle the global tab auto-naming off switch (raw credential), same shape
	// as the auto-compaction switch: stored as the disabled state so an
	// absent/empty key means enabled (default). autoNamer reads it live, so a
	// toggle takes effect on the next auto-name attempt without a restart.
	if v, ok := req[autoNameDisabledKey]; ok {
		disabled := false
		switch t := v.(type) {
		case bool:
			disabled = t
		case string:
			disabled = strings.TrimSpace(t) == "1"
		}
		stored := ""
		if disabled {
			stored = "1"
		}
		if err := c.credStore.SetRawKey(autoNameDisabledKey, stored); err != nil {
			jlog.Error("Failed to save auto-naming setting: %v", err)
		}
	}

	// Handle the optional custom auto-name instruction (raw credential). Read
	// live by autoNamer as the first-attempt system prompt; blank clears it back
	// to the built-in prompt.
	if v, ok := req[autoNameInstructionKey]; ok {
		if s, ok := v.(string); ok {
			if err := c.credStore.SetRawKey(autoNameInstructionKey, strings.TrimSpace(s)); err != nil {
				jlog.Error("Failed to save auto-name instruction: %v", err)
			}
		}
	}

	// Update model in project config if provided
	if modelValue, ok := req["model"]; ok {
		if model, ok := modelValue.(string); ok && model != "" {
			cfg, err := core.LoadConfig(c.projectPath())
			if err != nil {
				WriteError(w, r, http.StatusInternalServerError, fmt.Sprintf("Failed to load config: %v", err))
				return
			}

			cfg.Model = model

			if err := cfg.Save(c.projectPath()); err != nil {
				WriteError(w, r, http.StatusInternalServerError, fmt.Sprintf("Failed to save config: %v", err))
				return
			}
		}
	}

	response := map[string]any{
		"success": true,
		"message": "Configuration updated successfully",
	}

	// If keys were added, include them in response so UI can auto-select
	if len(providersWithKeys) > 0 {
		response["providersWithKeys"] = providersWithKeys
	}

	c.fireCredsChanged()
	WriteJSON(w, r, 0, response)
}

// HandleGetPluginConfig returns the resolved plugin disabled/enabled lists
func (c *ConfigAPI) HandleGetPluginConfig(w http.ResponseWriter, r *http.Request) {
	cfg, err := core.LoadConfig(c.projectPath())
	if err != nil {
		WriteError(w, r, http.StatusInternalServerError, fmt.Sprintf("Failed to load config: %v", err))
		return
	}

	disabled := make([]string, 0, len(cfg.GetDisabledPlugins()))
	enabled := make(map[string]bool, len(cfg.GetEnabledPlugins()))
	for _, id := range cfg.GetEnabledPlugins() {
		enabled[id] = true
	}
	for _, id := range cfg.GetDisabledPlugins() {
		if !enabled[id] {
			disabled = append(disabled, id)
		}
	}

	WriteJSON(w, r, 0, map[string]any{
		"disabled": disabled,
		"enabled":  cfg.GetEnabledPlugins(),
	})
}

// HandleUpdatePluginConfig updates the plugin disabled/enabled lists
func (c *ConfigAPI) HandleUpdatePluginConfig(w http.ResponseWriter, r *http.Request) {
	req, ok := DecodeJSON[struct {
		Disabled []string `json:"disabled"`
		Enabled  []string `json:"enabled"`
	}](w, r)
	if !ok {
		return
	}

	cfg, err := core.LoadConfig(c.projectPath())
	if err != nil {
		WriteError(w, r, http.StatusInternalServerError, fmt.Sprintf("Failed to load config: %v", err))
		return
	}

	cfg.Plugins.Disabled = req.Disabled
	cfg.Plugins.Enabled = req.Enabled
	for _, id := range req.Enabled {
		found := false
		for _, disabledID := range cfg.Plugins.Disabled {
			if disabledID == id {
				found = true
				break
			}
		}
		if !found {
			cfg.Plugins.Disabled = append(cfg.Plugins.Disabled, id)
		}
	}

	if err := cfg.Save(c.projectPath()); err != nil {
		WriteError(w, r, http.StatusInternalServerError, fmt.Sprintf("Failed to save config: %v", err))
		return
	}

	c.firePluginsChanged()

	WriteJSON(w, r, 0, map[string]any{
		"success": true,
	})
}

// HandleSetProviderEnabled enables or disables a keyless provider
// POST /api/config/provider-enabled
// Body: { "provider": "claudecode", "enabled": true }
func (c *ConfigAPI) HandleSetProviderEnabled(w http.ResponseWriter, r *http.Request) {
	req, ok := DecodeJSON[struct {
		Provider string `json:"provider"`
		Enabled  bool   `json:"enabled"`
	}](w, r)
	if !ok {
		return
	}

	if req.Provider == "" {
		WriteError(w, r, http.StatusBadRequest, "Provider name is required")
		return
	}

	// Verify provider exists and is a toggle-style keyless provider.
	info, found := provider.GetProviderInfo(req.Provider)
	if found && info.EffectiveAuthType() != provider.AuthTypeToggle {
		WriteError(w, r, http.StatusBadRequest, "This provider cannot be enabled with a toggle")
		return
	}

	if !found {
		WriteError(w, r, http.StatusBadRequest, "Unknown provider")
		return
	}

	if err := c.credStore.SetProviderEnabled(req.Provider, req.Enabled); err != nil {
		WriteError(w, r, http.StatusInternalServerError, fmt.Sprintf("Failed to update provider: %v", err))
		return
	}

	c.fireCredsChanged()
	WriteJSON(w, r, 0, map[string]any{
		"success": true,
	})
}
