//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import "juggler/cmd/juggler/mcp"

// StartMCP wires the MCP manager to this server and starts discovering the
// project's servers. Call it as soon as the project is known — before the engine
// connects, not after — and again whenever the project changes.
//
// Order matters, and both halves are load-bearing:
//
//   - The change hook goes in FIRST. A server that finishes connecting before the
//     hook exists fires its notification into a nil hook, and nothing ever
//     re-sends it: the engine would keep its empty tool snapshot for the whole
//     session while the settings UI, which reads the manager directly, shows every
//     tool. Both are sent to the same actor mailbox from this goroutine, so FIFO
//     ordering is the guarantee.
//   - Discovery starts EARLY so servers are connecting during the seconds the
//     engine spends booting, rather than starting only when the engine asks for
//     the tool list it is about to send.
func (s *Server) StartMCP() {
	// A changed tool snapshot (a server became ready, crashed, or sent
	// tools/list_changed) reuses the extension hot-reload broadcast, so connected
	// engines reload their registries and pick up the new set. The tool set
	// changed, not any extension file, so the module cache is left alone: the
	// reload re-reads the snapshot from the server.
	mcp.SetChangeHook(func() {
		s.broadcastPluginChanged("config/mcp", false)
	})
	mcp.StartDiscovery(s.ProjectPath())
}
