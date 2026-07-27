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

	"juggler/internal/userpaths"
)

// ServerConfig is one entry under "mcpServers". The schema is deliberately close
// to the de-facto .mcp.json format so hand-migration from other agents is
// trivial.
type ServerConfig struct {
	Command   string            `json:"command,omitempty"`
	Args      []string          `json:"args,omitempty"`
	Env       map[string]string `json:"env,omitempty"`
	Transport string            `json:"transport,omitempty"` // "stdio" (default), "http"/"streamable", or "sse"
	URL       string            `json:"url,omitempty"`       // http/sse transports only
	Headers   map[string]string `json:"headers,omitempty"`   // http/sse transports only; e.g. {"Authorization": "Bearer …"}
	Enabled   *bool             `json:"enabled,omitempty"`   // manager-level kill switch; default true
	LazyTools bool              `json:"lazyTools,omitempty"` // phase 4; parsed but unused in phase 1
}

// IsEnabled reports whether the server should be started. Absent means enabled.
func (c ServerConfig) IsEnabled() bool { return c.Enabled == nil || *c.Enabled }

// transportKind returns the effective transport, defaulting to stdio.
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
// rather than silently dropping servers.
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
// accept the same shape the settings UI sends.
func coerceServerConfig(entry any) (ServerConfig, error) {
	data, err := json.Marshal(entry)
	if err != nil {
		return ServerConfig{}, err
	}
	var sc ServerConfig
	if err := json.Unmarshal(data, &sc); err != nil {
		return ServerConfig{}, err
	}
	return sc, nil
}
