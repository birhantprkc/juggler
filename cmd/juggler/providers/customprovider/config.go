//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package customprovider holds the user's named custom endpoints: any number of
// gateways, tenants, regions or local servers, each with its own base URL,
// credentials, headers and model list, each appearing as its own provider in the
// model picker.
//
// Each entry registers as a separate provider id rather than as a model under
// one shared id (the shape ACP uses for its agents). That is what gives an entry
// its own credential slot — the credentials store is keyed by provider — and it
// keeps models.hidden and models.limits, which are keyed provider-then-model,
// able to name one endpoint's models without inventing composite model ids.
//
// The definitions live in a single global file. They are deliberately NOT
// project-scoped: a provider id is persisted into per-conversation documents and
// into the global default-model, cheap-model and settings stores alike, so an id
// that resolved to different endpoints in different projects would make those
// stores ambiguous.
package customprovider

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"juggler/cmd/juggler/providers/provider"
	"juggler/internal/userpaths"
)

// ProtocolOpenAI is the OpenAI Chat Completions wire protocol. It is the only
// protocol implemented; the field exists so an Anthropic-compatible protocol can
// be added later without migrating anyone's file.
const ProtocolOpenAI = "openai"

// idPrefix namespaces the provider id an instance registers under, so a
// user-chosen name can never collide with a built-in provider, present or
// future.
//
// It is a hyphen and not a colon on purpose: the settings UI interpolates a
// provider id into DOM element ids and finds them again with
// querySelector("#<id>-key") (providers-tab.js). A colon there parses as a CSS
// pseudo-class and throws, which would break the Providers tab for every custom
// endpoint.
const idPrefix = "custom-"

// Instance is one user-declared endpoint.
type Instance struct {
	// DisplayName is the label shown in the picker and settings. It is the only
	// human-facing name, and the only one that can be edited: the id is the key
	// every stored reference uses and never changes.
	DisplayName string `json:"displayName,omitempty"`
	// Protocol is the wire protocol. Empty means ProtocolOpenAI.
	Protocol string            `json:"protocol,omitempty"`
	BaseURL  string            `json:"baseURL,omitempty"`
	Headers  map[string]string `json:"headers,omitempty"`
	Enabled  *bool             `json:"enabled,omitempty"` // default true when absent
}

// IsEnabled reports whether the endpoint should be registered. Absent = enabled,
// matching how acp.json spells the same idea.
func (i Instance) IsEnabled() bool { return i.Enabled == nil || *i.Enabled }

// EffectiveProtocol resolves the blank protocol of an entry written before there
// was more than one.
func (i Instance) EffectiveProtocol() string {
	if i.Protocol == "" {
		return ProtocolOpenAI
	}
	return i.Protocol
}

// Config is the parsed custom-providers.json document.
type Config struct {
	Providers map[string]Instance `json:"customProviders"`
}

const configFileName = "custom-providers.json"

// configPath is <ConfigDir>/custom-providers.json — durable per-user state,
// alongside credentials, sessions, acp.json and mcp.json.
func configPath() string {
	return filepath.Join(userpaths.ConfigDir(), configFileName)
}

// RegisteredName is the provider id an instance registers under. The endpoint
// carried over from the days of a single custom provider keeps its bare,
// unprefixed id, because that is the id already written into conversations and
// into the default-model, cheap-model and settings stores.
func RegisteredName(id string) string {
	if id == LegacyID {
		return LegacyID
	}
	return idPrefix + id
}

// idPattern allows a lowercase letter followed by hyphen-separated
// alphanumeric runs: no leading digit, no leading, trailing or doubled hyphen.
// The result is safe as a DOM element id, as a CSS id selector, as part of a
// credential key, and as a JSON object key.
var idPattern = regexp.MustCompile(`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`)

const maxIDLength = 40

// ValidateID reports whether id is usable as a custom provider id. Unlike ACP,
// which validates names only in the browser, this runs server-side: these ids
// become provider ids that persist into conversations and settings, so a bad one
// is not a cosmetic problem.
func ValidateID(id string) error {
	if err := validateIDShape(id); err != nil {
		return err
	}
	// The collision that matters is on the registered name, since that is what
	// every store and the picker key on.
	if _, taken := provider.GetProviderInfo(RegisteredName(id)); taken {
		return fmt.Errorf("provider id %q is already in use", id)
	}
	return nil
}

// ValidateInstance checks one entry's fields. The id is checked separately by
// ValidateID, because an entry being edited keeps an id that is already
// registered and so would fail the collision test.
func ValidateInstance(inst Instance) error {
	if p := inst.EffectiveProtocol(); p != ProtocolOpenAI {
		return fmt.Errorf("unknown protocol %q", p)
	}
	raw := strings.TrimSpace(inst.BaseURL)
	if raw == "" {
		return fmt.Errorf("base URL is required")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("base URL %q is not a URL: %w", raw, err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("base URL %q must start with http:// or https://", raw)
	}
	if u.Host == "" {
		return fmt.Errorf("base URL %q has no host", raw)
	}
	return nil
}

// Load reads the instance definitions. A missing file is not an error (no custom
// providers configured); a malformed one returns the parse error so it surfaces
// loudly rather than silently dropping every endpoint the user configured.
func Load() (map[string]Instance, error) {
	data, err := os.ReadFile(configPath())
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]Instance{}, nil
		}
		return nil, err
	}
	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("%s: %w", configFileName, err)
	}
	if cfg.Providers == nil {
		cfg.Providers = map[string]Instance{}
	}
	return cfg.Providers, nil
}

// Save validates and writes the whole document. Every mutation rewrites the
// entire map, so callers must always send the full set.
//
// Written 0600, not the 0644 acp.json uses: an entry's headers are the natural
// place for a gateway's auth header, so this file is credential-adjacent even
// though the API key itself lives in the credentials store.
func Save(instances map[string]Instance) error {
	if instances == nil {
		instances = map[string]Instance{}
	}
	for id, inst := range instances {
		// An id already registered by this very instance is not a collision, so
		// only shape is checked here; ValidateID guards the add path.
		if err := validateIDShape(id); err != nil {
			return err
		}
		if err := ValidateInstance(inst); err != nil {
			return fmt.Errorf("%s: %w", id, err)
		}
	}

	data, err := json.MarshalIndent(Config{Providers: instances}, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')

	dir := userpaths.ConfigDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	// Temp file then rename, so an interrupted write leaves the previous
	// definitions intact rather than a truncated file that would unregister
	// every endpoint at the next start.
	tmp, err := os.CreateTemp(dir, configFileName+".*.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer func() { _ = os.Remove(tmpPath) }() // no-op once the rename succeeds

	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpPath, configPath())
}
