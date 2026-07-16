//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package acp

import (
	"encoding/json"
	"strings"
)

// Approver decides how to answer an agent's session/request_permission call —
// the one client callback that stays live during an ACP turn (see doc.go). MVP
// ships defaultApprover (allow-once); Phase 2 bridges this to the worker's
// approval round-trip so ACP tool approvals surface in juggler's UI.
type Approver interface {
	Approve(req PermissionRequest) PermissionOutcome
}

// PermissionRequest is the decision the agent is asking the client to make. The
// raw tool call is passed through verbatim so an Approver can inspect it
// without this package owning the agent's tool schema.
type PermissionRequest struct {
	ToolCall json.RawMessage
	Options  []permissionOption
}

// PermissionOutcome is an Approver's decision: pick one of the offered option
// ids, or decline (Selected == false → the agent sees "cancelled").
type PermissionOutcome struct {
	Selected bool
	OptionID string
}

// permissionOption is one choice the agent offers. Kind is one of allow_once,
// allow_always, reject_once, reject_always.
type permissionOption struct {
	OptionID string `json:"optionId"`
	Name     string `json:"name"`
	Kind     string `json:"kind"`
}

// requestPermissionParams is the session/request_permission payload.
type requestPermissionParams struct {
	SessionID string             `json:"sessionId"`
	ToolCall  json.RawMessage    `json:"toolCall"`
	Options   []permissionOption `json:"options"`
}

// permissionResponse is our reply. Outcome.Outcome is "selected" (with
// OptionID) or "cancelled".
type permissionResponse struct {
	Outcome permissionOutcomeWire `json:"outcome"`
}

type permissionOutcomeWire struct {
	Outcome  string `json:"outcome"`
	OptionID string `json:"optionId,omitempty"`
}

// permission option kinds.
const (
	kindAllowOnce   = "allow_once"
	kindAllowAlways = "allow_always"
)

// defaultApprover approves every request by selecting an "allow" option. It
// prefers allow_once over allow_always, and falls back to the first offered
// option if the agent labels none as an allow kind. With no options it
// declines. This is the MVP default: the user launched juggler pointed at this
// agent, so juggler is the trust boundary and auto-approval keeps a
// self-contained agent unblocked. Phase 2 replaces it with a user-facing bridge.
type defaultApprover struct{}

func (defaultApprover) Approve(req PermissionRequest) PermissionOutcome {
	if opt, ok := pickAllowOption(req.Options); ok {
		return PermissionOutcome{Selected: true, OptionID: opt}
	}
	return PermissionOutcome{Selected: false}
}

// pickAllowOption chooses the option to select: an allow_once if present, else
// an allow_always, else the first non-reject option. Reports ok=false when no
// options were offered, or when every option is a reject kind (nothing to
// allow) — the caller declines in that case.
func pickAllowOption(options []permissionOption) (string, bool) {
	if len(options) == 0 {
		return "", false
	}
	var allowAlways, firstNonReject string
	for _, o := range options {
		switch strings.ToLower(o.Kind) {
		case kindAllowOnce:
			return o.OptionID, true
		case kindAllowAlways:
			if allowAlways == "" {
				allowAlways = o.OptionID
			}
		}
		if firstNonReject == "" && !strings.HasPrefix(strings.ToLower(o.Kind), "reject") {
			firstNonReject = o.OptionID
		}
	}
	if allowAlways != "" {
		return allowAlways, true
	}
	if firstNonReject != "" {
		return firstNonReject, true
	}
	// Every option is a reject kind: there is nothing to "allow", so decline
	// rather than auto-select a reject (which the agent could read as a
	// deliberate choice). The caller maps ok=false to a cancelled outcome.
	return "", false
}
