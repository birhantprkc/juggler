//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package mcp is Juggler's Model Context Protocol client: it owns connections to
// external MCP servers (stdio child processes or remote http/sse endpoints),
// discovers their tools, and proxies tool calls. The engine surfaces discovered
// tools as first-class context items via the ops seam (see ops.go); this package
// never imports the engine or the web layer.
package mcp

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"juggler/internal/userpaths"
)

// ServerConfig is one entry under "mcpServers". The schema is deliberately close
// to the de-facto .mcp.json format so hand-migration from other agents is
// trivial.
type ServerConfig struct {
	Command   string            `json:"command,omitempty"`
	Args      []string          `json:"args,omitempty"`
	Env       map[string]string `json:"env,omitempty"`
	Transport string            `json:"transport,omitempty"` // "stdio" (default), "http", or "sse"
	URL       string            `json:"url,omitempty"`       // http/sse transports only
	Headers   map[string]string `json:"headers,omitempty"`   // http/sse transports only; e.g. {"Authorization": "Bearer …"}
	Enabled   *bool             `json:"enabled,omitempty"`   // manager-level kill switch; default true
	LazyTools bool              `json:"lazyTools,omitempty"` // phase 4; parsed but unused in phase 1

	// Type is the spelling the de-facto .mcp.json format uses for the same
	// choice Transport makes, and is what a config copied from another agent
	// carries. It is folded onto Transport by normalize() at parse time and
	// never written back, so no other code in this package reads it.
	Type string `json:"type,omitempty"`

	// Tools is a per-server visibility filter: it hides individual tools from the
	// model (and blocks calls to them) without disabling the whole server. Nil
	// means every discovered tool is exposed.
	Tools *ToolFilter `json:"tools,omitempty"`
	// DefaultArguments are argument keys merged into every call to this server and
	// hidden from the schema the model sees. The config value wins over anything
	// the model supplies, so routing keys (e.g. a memory bank id) are decided by
	// configuration, not by the model.
	DefaultArguments map[string]any `json:"defaultArguments,omitempty"`
}

// ToolFilter is a per-server tool visibility policy. Allow, when non-empty, is a
// strict allowlist — only listed tools are exposed. Deny removes tools from
// whatever Allow permits (so it also works on its own). Both match the raw MCP
// tool name exactly. An allowlist is the safer default: a new server version can
// add a destructive tool that a denylist would not catch.
type ToolFilter struct {
	Allow []string `json:"allow,omitempty"`
	Deny  []string `json:"deny,omitempty"`
}

// IsEnabled reports whether the server should be started. Absent means enabled.
func (c ServerConfig) IsEnabled() bool { return c.Enabled == nil || *c.Enabled }

// canonicalTransport folds the spellings a config can arrive with onto the three
// kinds buildTransport implements. Streamable HTTP is written four different ways
// across the ecosystem and they all mean the same endpoint, so they all become
// "http". An unrecognised value passes through (lowercased) rather than being
// coerced to a default: startServer then names it back in "unsupported transport
// %q", which is far more use than silently connecting to something else.
func canonicalTransport(transport string) string {
	switch t := strings.ToLower(strings.TrimSpace(transport)); t {
	case "http", "streamable", "streamable-http", "streamablehttp":
		return "http"
	default:
		return t
	}
}

// normalize folds Type onto Transport and canonicalises the result, so every
// later reader — and anything written back to disk — sees exactly one spelling.
// Transport wins when both are set and disagree: it is Juggler's own key, so an
// entry carrying both was edited here after being pasted from elsewhere.
func (c *ServerConfig) normalize() {
	if strings.TrimSpace(c.Transport) == "" {
		c.Transport = c.Type
	}
	c.Type = ""
	c.Transport = canonicalTransport(c.Transport)
}

// transportKind returns the effective transport, defaulting to stdio. Callers
// see canonical values: every path that produces a ServerConfig normalizes it
// first (readConfigFile, coerceServerConfig).
func (c ServerConfig) transportKind() string {
	if c.Transport == "" {
		return "stdio"
	}
	return c.Transport
}

// Config is the parsed mcp.json document.
type Config struct {
	Servers map[string]ServerConfig `json:"mcpServers"`
}

// mcpFileName is the config filename at both the global and per-project roots.
const mcpFileName = "mcp.json"

// globalConfigPath is <ConfigDir>/mcp.json — durable per-user state, alongside
// credentials and sessions.
func globalConfigPath() string {
	return filepath.Join(userpaths.ConfigDir(), mcpFileName)
}

// projectConfigPath is <project>/.juggler/mcp.json, matching how other
// per-project state under .juggler/ is stored. Empty projectRoot yields "".
func projectConfigPath(projectRoot string) string {
	if projectRoot == "" {
		return ""
	}
	return filepath.Join(projectRoot, ".juggler", mcpFileName)
}

// readConfigFile parses one mcp.json. A missing file is not an error (returns an
// empty config); a malformed file returns the parse error so it surfaces loudly
// rather than silently dropping servers. Every entry is normalized here, so this
// is the only place transport aliases have to be understood.
func readConfigFile(path string) (Config, error) {
	if path == "" {
		return Config{}, nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return Config{}, nil
		}
		return Config{}, err
	}
	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return Config{}, err
	}
	if cfg.Servers == nil {
		cfg.Servers = map[string]ServerConfig{}
	}
	for name, sc := range cfg.Servers {
		sc.normalize()
		cfg.Servers[name] = sc
	}
	return cfg, nil
}

// loadMergedConfig merges the global config with the project config, with
// project entries overriding global ones of the same name. The returned map is
// never nil. Either file being absent is fine; a malformed file returns its
// error so the caller can surface it.
func loadMergedConfig(projectRoot string) (map[string]ServerConfig, error) {
	global, err := readConfigFile(globalConfigPath())
	if err != nil {
		return nil, err
	}
	project, err := readConfigFile(projectConfigPath(projectRoot))
	if err != nil {
		return nil, err
	}
	merged := make(map[string]ServerConfig, len(global.Servers)+len(project.Servers))
	for name, sc := range global.Servers {
		merged[name] = sc
	}
	for name, sc := range project.Servers {
		merged[name] = sc // project wins
	}
	return merged, nil
}

// writeConfigFile serializes servers to the given mcp.json path, creating parent
// directories as needed. Used by the mcpSetConfig op.
func writeConfigFile(path string, servers map[string]ServerConfig) error {
	if servers == nil {
		servers = map[string]ServerConfig{}
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(Config{Servers: servers}, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return os.WriteFile(path, data, 0o644)
}

// coerceServerConfig converts one JSON-decoded server entry (map[string]any)
// into a typed ServerConfig via a JSON round-trip, so the mcpSetConfig op can
// accept the same shape the settings UI sends. Normalized like a parsed file, so
// an entry pasted into the API with "type" is stored under "transport".
func coerceServerConfig(entry any) (ServerConfig, error) {
	data, err := json.Marshal(entry)
	if err != nil {
		return ServerConfig{}, err
	}
	var sc ServerConfig
	if err := json.Unmarshal(data, &sc); err != nil {
		return ServerConfig{}, err
	}
	sc.normalize()
	return sc, nil
}
