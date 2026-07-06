//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"encoding/json"

	provider "juggler/cmd/juggler/providers/registry"
)

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
	Provider string `json:"provider"` // LLM provider name (e.g., "anthropic", "openai")
	Model    string `json:"model"`    // LLM model name (e.g., "claude-sonnet-4-20250514")
}

// MessageRequest represents an incoming message from the client
type MessageRequest struct {
	SystemPrompt   string             `json:"systemPrompt"`            // System prompt with instructions
	Messages       []provider.Message `json:"messages"`                // Array of unified Message types from frontend
	Tools          []ToolDefinition   `json:"tools,omitempty"`         // Tool definitions for LLM to use
	ConversationID string             `json:"conversationId"`          // Conversation ID for routing responses (required)
	ModelConfig    ModelConfig        `json:"modelConfig"`             // Model configuration (required)
	TransactionID  string             `json:"transactionId,omitempty"` // Transaction ID for stale response detection (echoed back)
	Cancel         bool               `json:"cancel,omitempty"`        // If true, cancel the active request
}

// ShellStartRequest represents a request to start a streaming shell command
type ShellStartRequest struct {
	Type    string `json:"type"`              // "shell-start"
	ShellID string `json:"shellId"`           // Unique ID for this shell execution
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
}

// MessageResponse represents a response to the client
type MessageResponse struct {
	Blocks         []provider.ContentBlock `json:"blocks,omitempty"`         // Structured response blocks
	ConversationID string                  `json:"conversationId,omitempty"` // Echo back conversation ID for routing
	TransactionID  string                  `json:"transactionId,omitempty"`  // Transaction ID for stale response detection
	Error          string                  `json:"error,omitempty"`
	InputTokens    int                     `json:"inputTokens,omitempty"`  // Input tokens used
	OutputTokens   int                     `json:"outputTokens,omitempty"` // Output tokens generated
	CachedTokens   int                     `json:"cachedTokens,omitempty"` // Prompt tokens served from cache (OpenAI)
	StopReason     string                  `json:"stopReason,omitempty"`   // Why LLM stopped: "end_turn", "tool_use", "max_tokens"
}

// ToolUseRequest is sent to frontend when a tool needs to be executed.
// The frontend executes the tool (with approval) and sends back ToolUseResponse.
type ToolUseRequest struct {
	Type           string         `json:"type"`           // "tool_use_request"
	RequestID      string         `json:"requestId"`      // Unique ID for correlating response
	ConversationID string         `json:"conversationId"` // Conversation ID
	ToolUseID      string         `json:"toolUseId"`      // Tool use ID from LLM
	ToolName       string         `json:"toolName"`       // Tool name
	ToolInput      map[string]any `json:"toolInput"`      // Tool input parameters
}

// ToolUseResponse is received from frontend with the tool execution result
type ToolUseResponse struct {
	Type         string                `json:"type"`         // "tool_use_response"
	RequestID    string                `json:"requestId"`    // Matches ToolUseRequest.RequestID
	Content      string                `json:"content"`      // Tool result content
	ResultStatus provider.ResultStatus `json:"resultStatus"` // Outcome: "success", "error", "denied", "cancelled"
	Category     string                `json:"category"`     // Tool category: "read", "write", "meta"
}

// ToolUseStarted is sent from frontend to server when user approves and the tool begins executing.
// This separates "waiting for approval" (no timeout) from "tool is running" (execution timeout applies).
type ToolUseStarted struct {
	Type      string `json:"type"`      // "tool_use_started"
	RequestID string `json:"requestId"` // Matches ToolUseRequest.RequestID
}

// ToolUseTimeout is sent to frontend when tool execution times out.
// This signals the frontend to dismiss any pending approval dialog.
type ToolUseTimeout struct {
	Type           string `json:"type"`           // "tool_use_timeout"
	RequestID      string `json:"requestId"`      // The request ID that timed out
	ConversationID string `json:"conversationId"` // Conversation ID
	ToolUseID      string `json:"toolUseId"`      // Tool use ID from LLM
}

// ShouldContinueRequest is sent to frontend to check if the tool loop should continue.
// The frontend evaluates the strategy's shouldContinue callback and sends back ShouldContinueResponse.
type ShouldContinueRequest struct {
	Type           string `json:"type"`           // "should_continue_request"
	RequestID      string `json:"requestId"`      // Unique ID for correlating response
	ConversationID string `json:"conversationId"` // Conversation ID
	TurnNumber     int    `json:"turnNumber"`     // Current turn number (1-indexed)
	ToolCallCount  int    `json:"toolCallCount"`  // Total tool calls executed so far
}

// ShouldContinueResponse is received from frontend with the iteration control decision
type ShouldContinueResponse struct {
	Type           string `json:"type"`           // "should_continue_response"
	RequestID      string `json:"requestId"`      // Matches ShouldContinueRequest.RequestID
	ShouldContinue bool   `json:"shouldContinue"` // Whether to continue the loop
	Message        string `json:"message"`        // Message to inject if stopping
}

// ProcessingHeartbeat is sent periodically while processing a conversation request.
// The frontend uses this to verify backend is still active and update spinner state.
type ProcessingHeartbeat struct {
	Type           string `json:"type"`           // "processing_heartbeat"
	ConversationID string `json:"conversationId"` // Which conversation is being processed
	Timestamp      int64  `json:"timestamp"`      // Unix timestamp in milliseconds
}
