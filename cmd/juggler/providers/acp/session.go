//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package acp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"juggler/internal/jlog"
)

// acpProtocolVersion is the ACP schema version this client negotiates. ACP is
// young and evolving; this is the version verified against a reference agent in
// the Phase 0 spike. Bump it as the spec settles.
const acpProtocolVersion = 1

// --- initialize -------------------------------------------------------------

type initializeParams struct {
	ProtocolVersion    int                `json:"protocolVersion"`
	ClientCapabilities clientCapabilities `json:"clientCapabilities"`
}

// clientCapabilities advertises what the *client* (juggler) will do for the
// agent. MVP declines fs + terminal so the agent runs fully self-contained;
// Phase 2 flips these on and routes fs/* + terminal/* through cmd/juggler/ops.
type clientCapabilities struct {
	FS       fsCapability `json:"fs"`
	Terminal bool         `json:"terminal"`
}

type fsCapability struct {
	ReadTextFile  bool `json:"readTextFile"`
	WriteTextFile bool `json:"writeTextFile"`
}

type initializeResult struct {
	ProtocolVersion   int             `json:"protocolVersion"`
	AgentCapabilities json.RawMessage `json:"agentCapabilities,omitempty"`
	AuthMethods       json.RawMessage `json:"authMethods,omitempty"`
}

// --- session/new ------------------------------------------------------------

type newSessionParams struct {
	Cwd        string `json:"cwd"`
	MCPServers []any  `json:"mcpServers"`
}

type newSessionResult struct {
	SessionID string `json:"sessionId"`
}

// --- session/prompt ---------------------------------------------------------

type promptParams struct {
	SessionID string         `json:"sessionId"`
	Prompt    []contentBlock `json:"prompt"`
}

// contentBlock is one piece of a prompt (MVP: text only).
type contentBlock struct {
	Type string `json:"type"`
	Text string `json:"text,omitempty"`
}

type promptResult struct {
	StopReason string `json:"stopReason"`
}

// --- session/cancel (notification) ------------------------------------------

type cancelParams struct {
	SessionID string `json:"sessionId"`
}

// handshake runs initialize + session/new over a freshly-started transport and
// returns the agent's session id. The client capabilities decline fs +
// terminal (MVP self-contained agent).
func (c *conversation) handshake(ctx context.Context, t *transport) (string, error) {
	initRaw, err := t.call(ctx, "initialize", initializeParams{
		ProtocolVersion: acpProtocolVersion,
		ClientCapabilities: clientCapabilities{
			FS:       fsCapability{ReadTextFile: false, WriteTextFile: false},
			Terminal: false,
		},
	})
	if err != nil {
		return "", fmt.Errorf("acp initialize: %w", err)
	}
	var initRes initializeResult
	if err := json.Unmarshal(initRaw, &initRes); err != nil {
		return "", fmt.Errorf("acp initialize: decode result: %w", err)
	}
	if initRes.ProtocolVersion != acpProtocolVersion {
		// Not fatal — most disagreements are backward-compatible — but worth a
		// breadcrumb since the spec is in flux.
		jlog.Info("[acp] agent negotiated protocol version %d (client uses %d)", initRes.ProtocolVersion, acpProtocolVersion)
	}

	newRaw, err := t.call(ctx, "session/new", newSessionParams{
		Cwd:        c.client.workingDir,
		MCPServers: []any{},
	})
	if err != nil {
		return "", fmt.Errorf("acp session/new: %w", err)
	}
	var ns newSessionResult
	if err := json.Unmarshal(newRaw, &ns); err != nil {
		return "", fmt.Errorf("acp session/new: decode result: %w", err)
	}
	if ns.SessionID == "" {
		return "", errors.New("acp session/new: empty sessionId")
	}
	return ns.SessionID, nil
}
