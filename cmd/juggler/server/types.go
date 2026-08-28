//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import "encoding/json"

// ToolDefinition represents a tool that the LLM can use
type ToolDefinition struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"input_schema"`       // Raw JSON schema
	Category    string          `json:"category,omitempty"` // Tool category: "read", "write", "meta"
}

// ModelConfig represents LLM provider and model configuration: a concrete
// (Provider, Model) pair.
type ModelConfig struct {
	Provider string `json:"provider"`           // LLM provider name (e.g., "anthropic", "openai")
	Model    string `json:"model"`              // LLM model name (e.g., "claude-sonnet-4-20250514")
	Thinking string `json:"thinking,omitempty"` // Thinking level in the provider's own vocabulary; empty ⇒ provider default
	// ServiceTier is the optional serving class, named by the id the model
	// advertised (e.g. "priority"); empty ⇒ standard serving.
	ServiceTier string `json:"serviceTier,omitempty"`
}

// ViewerFault is an uncaught fault reported by a viewer page.
//
// A viewer runs in a window whose console cannot be opened in a release build,
// so without this a fault in the UI leaves no trace anywhere: the page renders
// something wrong, or stops rendering, and the log it would be diagnosed from
// records a server that did its job. The engine reports its own faults the same
// way (see engine-worker-runtime.js); this is the viewer's half.
type ViewerFault struct {
	Type    string `json:"type"`             // "viewer-fault"
	Source  string `json:"source"`           // What was running, e.g. "observe:tool-action-message"
	Message string `json:"message"`          // The error's message
	Stack   string `json:"stack,omitempty"`  // Stack trace, when the throw carried one
	ConvID  string `json:"convId,omitempty"` // Conversation it happened under, when known
	Detail  string `json:"detail,omitempty"` // Anything else that narrows it down
}

// ShellStartRequest represents a request to start a streaming shell command
type ShellStartRequest struct {
	Type    string `json:"type"`              // "shell-start"
	ShellID string `json:"shellId"`           // Unique ID for this shell execution
	ConvId  string `json:"convId,omitempty"`  // Conversation that owns this shell (spill-file bucket)
	Command string `json:"command"`           // Shell command to execute
	Cwd     string `json:"cwd,omitempty"`     // Working directory
	Timeout int    `json:"timeout,omitempty"` // Timeout in milliseconds
}

// ShellCancelRequest represents a request to cancel a running shell command
type ShellCancelRequest struct {
	Type    string `json:"type"`    // "shell-cancel"
	ShellID string `json:"shellId"` // ID of shell to cancel
}

// GenericWSMessage is used to determine message type before parsing
type GenericWSMessage struct {
	Type string `json:"type,omitempty"`
	// WorkerMsgType is the inner type carried by a "worker-message" envelope
	// (worker.WorkerMessage). Probed here so a routing decision that depends on
	// which worker message this is can be made before the envelope is parsed;
	// empty for every other message type.
	WorkerMsgType string `json:"workerMsgType,omitempty"`
}
