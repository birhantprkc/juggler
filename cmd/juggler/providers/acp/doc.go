//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package acp drives an external Agent Client Protocol (ACP) agent — Zed's
// JSON-RPC-2.0-over-stdio protocol; agents such as Gemini CLI's ACP mode,
// Claude Code's ACP mode, or any custom ACP agent — as a juggler LLM provider.
// Juggler is the ACP *client*: it spawns the agent subprocess and drives it,
// exposing it through the normal provider seam so it appears in the model
// picker like any other backend. Registration is additive (Register() calls
// provider.RegisterProvider), the same shape every built-in provider uses.
//
// # Wire protocol
//
// One JSON object per line on the agent's stdio (newline-delimited JSON-RPC
// 2.0). Both directions may send requests:
//
//   - client → agent requests: initialize, session/new, session/prompt.
//   - client → agent notifications: session/cancel.
//   - agent → client notifications: session/update (streamed turn content).
//   - agent → client requests: session/request_permission, fs/*, terminal/*.
//
// jsonrpc.go hand-rolls the framing and dispatcher (no third-party jsonrpc2
// dependency — keeps the core/parent go.mod pinning burden at zero). A single
// writer goroutine owns the agent's stdin; outbound requests carry a unique id
// correlated to a per-request reply channel; inbound requests and
// notifications route to the conversation via inboundHandler.
//
// # The tool-ownership inversion (why this provider is unusual)
//
// Every other juggler provider streams tool_use chunks that the *worker*
// executes, returning a ToolResult through the callback — juggler owns the
// loop and the tools. ACP inverts this: the *agent* owns and runs its own
// tools (edits, shell, search). Its tool_call / tool_call_update updates are
// display/telemetry — by the time we see them the agent has already acted.
//
// Consequences, and how this MVP handles them:
//
//  1. StructuredStreamCallback goes (almost) idle. Emitting a real tool_use
//     chunk to the worker's callback would make the worker execute a phantom
//     juggler tool. So agent tool activity is surfaced as transient activity
//     snapshots (ContentBlockTypeActivity — display-only, never stored, never
//     executed), not tool_use blocks. Persisted tool_use/tool_result display
//     blocks are Phase 2 and require a worker seam that accepts display-only
//     tool blocks.
//  2. The turn is driven off session/update notifications, not the callback's
//     return value.
//  3. The strategy layer is bypassed for ACP turns — iteration caps,
//     meta-tools, per-tool permission policy, and context-item injection do
//     not apply, because the agent runs its own loop. This is the main product
//     limitation of an ACP backend; it is by design, not a gap to paper over.
//
// # Capabilities (MVP)
//
// initialize declines fs and terminal capabilities, so the agent runs fully
// self-contained (its edits happen inside its own subprocess). The one live
// callback path is session/request_permission, bridged to a pluggable
// Approver (default: allow-once). Phase 2 negotiates fs/* + terminal/* on and
// routes them through cmd/juggler/ops so agent edits enter juggler's
// diff/checkpoint/audit trail.
//
// # Configuration
//
// Agents are configured exactly like MCP servers — a named {command, args, env}
// entry in acp.json (global at <ConfigDir>/acp.json, per-project at
// <project>/.juggler/acp.json, project overriding global), edited through the
// settings-panel "ACP agents" tab. Each enabled agent surfaces as a model in
// the picker under the ACP provider, keyed by its configured name. The command
// is resolved on PATH lazily at the first turn, so listing/init never depend on
// a given agent being installed. See config.go (schema + merge) and ops.go (the
// listAgents/getConfig/setConfig ops the settings tab calls).
//
// # File map
//
//   - jsonrpc.go     : JSON-RPC 2.0 transport (framing, dispatcher, single
//     writer, id→reply correlation).
//   - lifecycle.go   : subprocess spawn/teardown + stderr drain.
//   - session.go     : initialize + session/new handshake, prompt/cancel wire
//     types and calls.
//   - updates.go     : session/update → StreamChunk mapping.
//   - permission.go  : session/request_permission → Approver bridge.
//   - conversation.go: provider.Conversation impl + inbound handler.
//   - client.go      : provider.Provider impl, NewClient, ListModelsWithInfo.
//   - config.go      : acp.json schema, global/project merge, agent resolution.
//   - ops.go         : "acp" ops handler (listAgents/getConfig/setConfig) + RegisterOps.
//   - register.go    : Info() + Register() (provider registry hook).
package acp
