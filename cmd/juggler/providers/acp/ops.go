//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package acp

import (
	"context"
	"fmt"
	"os/exec"
	"sort"
	"strings"

	"juggler/cmd/juggler/ops"
)

// RegisterOps registers the "acp" ops handler that backs the settings-panel
// "ACP agents" tab (listAgents / getConfig / setConfig). Call once at startup
// next to mcp.Register() in app/run.go (not from inside the ops package — that
// would import-cycle). Distinct from Register() in register.go, which registers
// the LLM provider; a build may call either independently.
func RegisterOps() {
	ops.Register("acp", func(scope ops.PathScope) ops.Operations {
		return &operations{scope: scope}
	})
}

// operations is the per-request ops handler; scope carries the active project.
type operations struct {
	scope ops.PathScope
}

// AgentStatus is one configured agent's row in the settings UI. Unlike an MCP
// server there is no persistent process to report on — agents are spawned
// per-conversation — so "status" is simply whether the command resolves on PATH
// right now: available (resolves), unavailable (missing/empty command), or
// disabled (turned off in config).
type AgentStatus struct {
	Name    string `json:"name"`
	Status  string `json:"status"` // "available" | "unavailable" | "disabled"
	Error   string `json:"error,omitempty"`
	Enabled bool   `json:"enabled"`
	Command string `json:"command,omitempty"`
}

// Execute dispatches an acp operation. Names mirror the JS ops-api wrappers
// (listAgents, getConfig, setConfig).
func (o *operations) Execute(_ context.Context, operation string, params map[string]any) (any, error) {
	project := o.scope.Root()
	switch operation {
	case "listAgents":
		return map[string]any{"agents": listAgentStatuses(project)}, nil
	case "getConfig":
		return o.getConfig(project)
	case "setConfig":
		return o.setConfig(project, params)
	default:
		return nil, fmt.Errorf("unknown acp operation: %s", operation)
	}
}

// listAgentStatuses returns every configured agent (enabled or not) with its
// resolved availability, sorted by name for a stable UI order.
func listAgentStatuses(project string) []AgentStatus {
	merged, err := loadMergedConfig(project)
	if err != nil {
		return nil
	}
	names := make([]string, 0, len(merged))
	for name := range merged {
		names = append(names, name)
	}
	sort.Strings(names)

	out := make([]AgentStatus, 0, len(names))
	for _, name := range names {
		ac := merged[name]
		st := AgentStatus{Name: name, Enabled: ac.IsEnabled(), Command: ac.Command}
		cmd := strings.TrimSpace(ac.Command)
		switch {
		case !ac.IsEnabled():
			st.Status = "disabled"
		case cmd == "":
			st.Status = "unavailable"
			st.Error = "No command configured."
		default:
			if _, err := exec.LookPath(cmd); err != nil {
				st.Status = "unavailable"
				st.Error = fmt.Sprintf("%q not found on PATH.", cmd)
			} else {
				st.Status = "available"
			}
		}
		out = append(out, st)
	}
	return out
}

// getConfig returns the merged config plus the raw per-file maps so the settings
// UI can show where each agent is defined (mirrors the mcp getConfig shape).
func (o *operations) getConfig(project string) (any, error) {
	merged, err := loadMergedConfig(project)
	if err != nil {
		return nil, err
	}
	global, err := readConfigFile(globalConfigPath())
	if err != nil {
		return nil, err
	}
	proj, err := readConfigFile(projectConfigPath(project))
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"merged":     merged,
		"global":     global.Agents,
		"project":    proj.Agents,
		"hasProject": project != "",
	}, nil
}

// setConfig writes agents to either the global or project acp.json. There is no
// manager to reconcile — the provider reads the merged config afresh when a
// conversation opens — so the write takes effect on the next turn.
func (o *operations) setConfig(project string, params map[string]any) (any, error) {
	target, _ := params["scope"].(string)
	if target == "" {
		target = "global"
	}
	agents, err := decodeAgents(params["agents"])
	if err != nil {
		return nil, err
	}

	var path string
	switch target {
	case "global":
		path = globalConfigPath()
	case "project":
		if project == "" {
			return nil, fmt.Errorf("no project loaded; cannot write project acp.json")
		}
		path = projectConfigPath(project)
	default:
		return nil, fmt.Errorf("unknown config scope %q (want 'global' or 'project')", target)
	}
	if err := writeConfigFile(path, agents); err != nil {
		return nil, err
	}
	return map[string]any{"agents": listAgentStatuses(project)}, nil
}

// decodeAgents coerces the JSON `agents` param (map[string]any) into typed
// AgentConfig entries via a JSON round-trip.
func decodeAgents(v any) (map[string]AgentConfig, error) {
	if v == nil {
		return map[string]AgentConfig{}, nil
	}
	raw, ok := v.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("'agents' must be an object")
	}
	out := make(map[string]AgentConfig, len(raw))
	for name, entry := range raw {
		ac, err := coerceAgentConfig(entry)
		if err != nil {
			return nil, fmt.Errorf("agent %q: %w", name, err)
		}
		out[name] = ac
	}
	return out, nil
}
