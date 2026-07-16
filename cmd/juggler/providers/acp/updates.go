//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package acp

import (
	"encoding/json"
	"strings"

	provider "juggler/cmd/juggler/providers/registry"
)

// sessionUpdateParams is the payload of a session/update notification.
type sessionUpdateParams struct {
	SessionID string        `json:"sessionId"`
	Update    sessionUpdate `json:"update"`
}

// sessionUpdate is the discriminated union of streamed turn events. The
// sessionUpdate field selects the variant; the rest are populated per variant.
type sessionUpdate struct {
	SessionUpdate string `json:"sessionUpdate"`

	// agent_message_chunk / agent_thought_chunk / user_message_chunk
	Content *updateContent `json:"content,omitempty"`

	// tool_call / tool_call_update
	ToolCallID string          `json:"toolCallId,omitempty"`
	Title      string          `json:"title,omitempty"`
	Kind       string          `json:"kind,omitempty"`
	Status     string          `json:"status,omitempty"`
	RawInput   json.RawMessage `json:"rawInput,omitempty"`
}

// updateContent is one content block inside a message/thought chunk.
type updateContent struct {
	Type string `json:"type"`
	Text string `json:"text,omitempty"`
}

// session/update variant names.
const (
	updAgentMessageChunk = "agent_message_chunk"
	updAgentThoughtChunk = "agent_thought_chunk"
	updUserMessageChunk  = "user_message_chunk"
	updToolCall          = "tool_call"
	updToolCallUpdate    = "tool_call_update"
	updPlan              = "plan"
)

// toStreamChunk maps one session/update variant to a juggler StreamChunk, or
// reports ok=false when the variant carries nothing to surface.
//
// The tool-ownership inversion (see doc.go) governs the tool variants: the
// agent already ran the tool, so tool_call / tool_call_update become
// *transient status chunks* (ContentBlockTypeStatus), never tool_use chunks —
// a tool_use chunk would make the worker execute a phantom juggler tool.
func toStreamChunk(u sessionUpdate) (provider.StreamChunk, bool) {
	switch u.SessionUpdate {
	case updAgentMessageChunk:
		text := contentText(u.Content)
		if text == "" {
			return provider.StreamChunk{}, false
		}
		return provider.StreamChunk{Type: provider.ContentBlockTypeText, Content: text}, true

	case updAgentThoughtChunk:
		text := contentText(u.Content)
		if text == "" {
			return provider.StreamChunk{}, false
		}
		return provider.StreamChunk{Type: provider.ContentBlockTypeThinking, Content: text}, true

	case updToolCall:
		return provider.StreamChunk{
			Type:    provider.ContentBlockTypeStatus,
			Content: toolCallSummary(u),
		}, true

	case updToolCallUpdate:
		// Only surface terminal transitions; intermediate churn is noise.
		if !isTerminalToolStatus(u.Status) {
			return provider.StreamChunk{}, false
		}
		return provider.StreamChunk{
			Type:    provider.ContentBlockTypeStatus,
			Content: toolCallSummary(u),
		}, true

	case updPlan:
		return provider.StreamChunk{
			Type:    provider.ContentBlockTypeStatus,
			Content: "Updated plan",
		}, true

	default:
		// user_message_chunk (echo of our own prompt), available_commands_update,
		// and any unknown future variant: nothing to surface.
		return provider.StreamChunk{}, false
	}
}

// isOutputText reports whether a chunk's content should count toward the turn's
// output-token estimate (agent-generated text and thinking do; transient status
// does not).
func isOutputText(t provider.ContentBlockType) bool {
	return t == provider.ContentBlockTypeText || t == provider.ContentBlockTypeThinking
}

func contentText(c *updateContent) string {
	if c == nil {
		return ""
	}
	return c.Text
}

func isTerminalToolStatus(status string) bool {
	switch strings.ToLower(status) {
	case "completed", "failed", "cancelled", "canceled", "error":
		return true
	default:
		return false
	}
}

// toolCallSummary builds a short human label for a tool_call/update status
// chunk, e.g. "⚙ edit: Write foo.go" — display only, never parsed.
func toolCallSummary(u sessionUpdate) string {
	var b strings.Builder
	b.WriteString("⚙ ")
	label := u.Title
	if label == "" {
		label = u.Kind
	}
	if label == "" {
		label = "tool"
	}
	b.WriteString(label)
	if u.Status != "" {
		b.WriteString(" (")
		b.WriteString(u.Status)
		b.WriteString(")")
	}
	return b.String()
}
