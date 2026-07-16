//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package acp

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"

	"juggler/internal/userpaths"
)

// AgentConfig is one entry under "acpAgents". It mirrors the MCP ServerConfig
// shape (command + args + env + enabled) deliberately, so the two settings
// surfaces feel identical and a user who knows how to add an MCP server already
// knows how to add an ACP agent.
type AgentConfig struct {
	Command string            `json:"command,omitempty"`
	Args    []string          `json:"args,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
	Enabled *bool             `json:"enabled,omitempty"` // default true when absent
}

// IsEnabled reports whether the agent should appear as a model. Absent = enabled.
func (c AgentConfig) IsEnabled() bool { return c.Enabled == nil || *c.Enabled }

// Config is the parsed acp.json document.
type Config struct {
	Agents map[string]AgentConfig `json:"acpAgents"`
}

// acpFileName is the config filename at both the global and per-project roots.
const acpFileName = "acp.json"

// globalConfigPath is <ConfigDir>/acp.json — durable per-user state, alongside
// credentials, sessions, and mcp.json.
func globalConfigPath() string {
	return filepath.Join(userpaths.ConfigDir(), acpFileName)
}

// projectConfigPath is <project>/.juggler/acp.json, matching how other
// per-project state under .juggler/ is stored. Empty projectRoot yields "".
func projectConfigPath(projectRoot string) string {
	if projectRoot == "" {
		return ""
	}
	return filepath.Join(projectRoot, ".juggler", acpFileName)
}

// readConfigFile parses one acp.json. A missing file is not an error (returns an
// empty config); a malformed file returns the parse error so it surfaces loudly
// rather than silently dropping agents.
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
	if cfg.Agents == nil {
		cfg.Agents = map[string]AgentConfig{}
	}
	return cfg, nil
}

// loadMergedConfig merges the global config with the project config, with
// project entries overriding global ones of the same name. The returned map is
// never nil. Either file being absent is fine; a malformed file returns its
// error so the caller can surface it.
func loadMergedConfig(projectRoot string) (map[string]AgentConfig, error) {
	global, err := readConfigFile(globalConfigPath())
	if err != nil {
		return nil, err
	}
	project, err := readConfigFile(projectConfigPath(projectRoot))
	if err != nil {
		return nil, err
	}
	merged := make(map[string]AgentConfig, len(global.Agents)+len(project.Agents))
	for name, ac := range global.Agents {
		merged[name] = ac
	}
	for name, ac := range project.Agents {
		merged[name] = ac // project wins
	}
	return merged, nil
}

// writeConfigFile serializes agents to the given acp.json path, creating parent
// directories as needed. Used by the setConfig op.
func writeConfigFile(path string, agents map[string]AgentConfig) error {
	if agents == nil {
		agents = map[string]AgentConfig{}
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(Config{Agents: agents}, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return os.WriteFile(path, data, 0o644)
}

// coerceAgentConfig converts one JSON-decoded agent entry (map[string]any) into
// a typed AgentConfig via a JSON round-trip, so the setConfig op can accept the
// same shape the settings UI sends.
func coerceAgentConfig(entry any) (AgentConfig, error) {
	data, err := json.Marshal(entry)
	if err != nil {
		return AgentConfig{}, err
	}
	var ac AgentConfig
	if err := json.Unmarshal(data, &ac); err != nil {
		return AgentConfig{}, err
	}
	return ac, nil
}

// resolvedAgent is a configured agent whose command has been located on PATH,
// ready to spawn.
type resolvedAgent struct {
	path string
	args []string
	env  map[string]string
}

// resolveAgent looks up the named agent in the merged config and resolves its
// command on PATH. Errors are user-facing (surfaced at turn time): unknown
// name, disabled, no command, or command-not-found.
func resolveAgent(projectRoot, name string) (resolvedAgent, error) {
	merged, err := loadMergedConfig(projectRoot)
	if err != nil {
		return resolvedAgent{}, fmt.Errorf("acp: read config: %w", err)
	}
	ac, ok := merged[name]
	if !ok {
		return resolvedAgent{}, fmt.Errorf("acp: no agent named %q is configured", name)
	}
	if !ac.IsEnabled() {
		return resolvedAgent{}, fmt.Errorf("acp: agent %q is disabled", name)
	}
	cmd := strings.TrimSpace(ac.Command)
	if cmd == "" {
		return resolvedAgent{}, fmt.Errorf("acp: agent %q has no command configured", name)
	}
	path, err := exec.LookPath(cmd)
	if err != nil {
		return resolvedAgent{}, fmt.Errorf("acp: agent %q command %q not found on PATH: %w", name, cmd, err)
	}
	return resolvedAgent{path: path, args: ac.Args, env: ac.Env}, nil
}

// enabledAgentNames returns the sorted names of every enabled agent with a
// non-empty command — the model set the provider advertises.
func enabledAgentNames(projectRoot string) []string {
	merged, err := loadMergedConfig(projectRoot)
	if err != nil {
		return nil
	}
	names := make([]string, 0, len(merged))
	for name, ac := range merged {
		if ac.IsEnabled() && strings.TrimSpace(ac.Command) != "" {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	return names
}

// anyAgentConfigured reports whether at least one enabled agent with a command
// exists for the env-scoped project. Backs the provider AutoDetect, which the
// registry snapshots once (sync.Once) at first use — so this decides the ACP
// provider's visibility at startup only. An agent added mid-session is surfaced
// by the settings tab enabling the provider directly, not by this re-running.
func anyAgentConfigured() bool {
	return len(enabledAgentNames(os.Getenv("JUGGLER_PROJECT_PATH"))) > 0
}
