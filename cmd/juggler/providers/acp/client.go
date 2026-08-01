//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package acp

import (
	"context"
	"os"

	provider "juggler/cmd/juggler/providers/registry"
)

// Client implements provider.Provider for the ACP backend. It is the config
// template — the selected agent name (its model id) plus the working directory
// used to locate the per-project acp.json — while the per-conversation state
// (the live subprocess and session id) lives on each conversation handle
// returned by OpenConversation. The concrete agent command is resolved lazily
// from config when a turn first runs, so listing and initialization never
// depend on a particular agent being present.
type Client struct {
	model      string // the selected agent's name (== its model id), "" when only listing
	workingDir string
	approver   Approver
}

// NewClient is the provider initializer registered with the registry. It does
// no agent resolution — that is deferred to the first turn — so a stale or
// placeholder model (as passed when merely listing models) never fails init.
func NewClient(cfg provider.Config) (provider.Provider, error) {
	return &Client{
		model:      cfg.Model,
		workingDir: projectDir(cfg.ProjectPath),
		approver:   defaultApprover{},
	}, nil
}

// projectDir is the root used to locate the per-project acp.json and as the
// spawned agent's working directory. The authoritative source is the project
// the server has open (cfgProjectPath, from Server.ProjectPath()); it falls
// back to the legacy env seam and then the process cwd only when no project is
// carried (e.g. model-listing calls that pass a bare Config).
func projectDir(cfgProjectPath string) string {
	if cfgProjectPath != "" {
		return cfgProjectPath
	}
	if wd := os.Getenv("JUGGLER_PROJECT_PATH"); wd != "" {
		return wd
	}
	if wd, err := os.Getwd(); err == nil {
		return wd
	}
	return ""
}

// Name returns the provider's registry name.
func (c *Client) Name() string { return providerName }

// ListModelsWithInfo returns one model per enabled agent in the merged
// acp.json (global + per-project), each identified by its configured name. ACP
// agents advertise "modes" rather than an OpenAI-style model list; enumerating
// a live agent's modes would require spawning it, which listing must not do, so
// one model per configured agent is the surface. Context window is unknown
// (0 → the UI shows nothing rather than a guess).
func (c *Client) ListModelsWithInfo(_ context.Context) ([]provider.ModelInfo, error) {
	names := enabledAgentNames(c.workingDir)
	models := make([]provider.ModelInfo, 0, len(names))
	for _, name := range names {
		models = append(models, provider.ModelInfo{
			ID:          name,
			DisplayName: name,
			FromAPI:     false,
		})
	}
	return models, nil
}

// OpenConversation returns a fresh ACP conversation handle bound to this
// client. The agent is resolved from config and spawned lazily on the first
// Submit, so an unknown/misconfigured agent surfaces as a clear turn error
// rather than failing to open.
func (c *Client) OpenConversation(_ context.Context, convID string) (provider.Conversation, error) {
	return &conversation{
		client:   c,
		convID:   convID,
		approver: c.approver,
		initLock: newLock(),
	}, nil
}
