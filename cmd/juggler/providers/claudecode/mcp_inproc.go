//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// In-process MCP server for the claudecode provider. Handles the JSONRPC
// methods the CLI invokes via stdio control_request{subtype:mcp_message}:
// initialize, tools/list, tools/call. initialize and tools/list are
// synchronous; tools/call is asynchronous — we surface the call to the
// worker via the existing StructuredStreamCallback path and respond later
// when the worker hands back the tool-result on the next StreamMessage
// invocation.

package claudecode

import (
	"encoding/json"
	"fmt"

	provider "juggler/cmd/juggler/providers/registry"
)

// mcpServerName is the name we register our in-process server under in
// the --mcp-config JSON. The CLI uses it to disambiguate which server a
// given mcp_message belongs to.
const mcpServerName = "juggler"

// mcpToolDef is the slim ToolDefinition shape the CLI expects from
// tools/list — name, description, inputSchema. Wider provider.Tool fields
// are flattened down here. Defined as raw JSON to side-step pulling the
// full provider.Tool shape into the protocol layer.
type mcpToolDef struct {
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	InputSchema json.RawMessage `json:"inputSchema,omitempty"`
}

// toolDefsToMCPList converts the provider's tool definitions into the
// MCP-spec tools/list payload. Field names map 1:1 except inputSchema
// (camelCase on the wire, since MCP follows JSONRPC convention).
//
// Tool names are advertised UNPREFIXED. The CLI adds the
// `mcp__<server-name>__` prefix itself when exposing tools to the LLM,
// based on the server name in --mcp-config. Prefixing on our side too
// would produce names like `mcp__juggler__mcp__juggler__bash` and the
// CLI reports "Unknown tool" when the LLM tries to call them.
func toolDefsToMCPList(tools []provider.ToolDefinition) ([]json.RawMessage, error) {
	out := make([]json.RawMessage, 0, len(tools))
	for _, t := range tools {
		def := mcpToolDef{
			Name:        t.Name,
			Description: t.Description,
			InputSchema: t.InputSchema,
		}
		raw, err := json.Marshal(def)
		if err != nil {
			return nil, fmt.Errorf("marshal tool %q: %w", t.Name, err)
		}
		out = append(out, raw)
	}
	return out, nil
}

// mcpInitializeResult is the canonical initialize response we send back
// when the CLI handshakes against our in-process server. The protocol
// version matches MCP 2024-11-05 (the version Claude Code's CLI accepts).
func mcpInitializeResult() MCPInitializeResult {
	return MCPInitializeResult{
		ProtocolVersion: "2024-11-05",
		Capabilities: map[string]any{
			"tools": map[string]any{"listChanged": false},
		},
		ServerInfo: MCPServerInfo{
			Name:    mcpServerName,
			Version: "1.0.0",
		},
	}
}

// jsonrpcSuccess wraps a result payload in a JSONRPC 2.0 success envelope
// matching the originating ID. Caller marshals the returned envelope into
// the control_response.response.mcp_response field.
func jsonrpcSuccess(id json.RawMessage, result any) (json.RawMessage, error) {
	resBytes, err := json.Marshal(result)
	if err != nil {
		return nil, err
	}
	env := JSONRPCMessage{JSONRPC: "2.0", ID: id, Result: resBytes}
	return json.Marshal(env)
}

// jsonrpcFailure wraps an error in a JSONRPC 2.0 error envelope. The CLI
// will surface this to the LLM as a tool failure (treated like IsError
// content for tools/call, or just a method failure for tools/list etc.).
func jsonrpcFailure(id json.RawMessage, code int, message string) (json.RawMessage, error) {
	env := JSONRPCMessage{
		JSONRPC: "2.0",
		ID:      id,
		Error:   &JSONRPCError{Code: code, Message: message},
	}
	return json.Marshal(env)
}

// mcpToolsCallSuccess builds the JSONRPC envelope for a successful
// tools/call response. Content text + IsError mirror MCP's spec; the CLI
// uses IsError to decide whether to surface as a failed tool to the LLM.
func mcpToolsCallSuccess(id json.RawMessage, content string, isError bool) (json.RawMessage, error) {
	return jsonrpcSuccess(id, MCPToolsCallResult{
		Content: []MCPContentBlock{{Type: "text", Text: content}},
		IsError: isError,
	})
}
