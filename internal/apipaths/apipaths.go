//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package apipaths names the HTTP endpoints that are spoken across a process
// boundary, so that each one is spelled in exactly one place.
//
// Most API paths belong to a single process: the server registers the route and
// the viewer's JavaScript calls it, and a rename is caught the moment the app is
// exercised. The handful here are different. Each is registered by the server
// (cmd/juggler/server/routes.go), called by a SECOND Go process — the desktop
// app opening a window, or another juggler instance probing the lock holder —
// and named a third time in apiAuthExempt (cmd/juggler/server/api_auth.go),
// which must let those callers through because neither of them holds the
// per-instance API token.
//
// Three namings that must agree, in two binaries, with the compiler blind to
// all of it: a rename that reached the route but missed the gate would leave a
// route silently locked (or, worse in the other direction, silently open), and
// the failure would show up as a window that will not remember its size rather
// than as anything a build or a test could see. Naming them once removes the
// possibility rather than documenting it.
package apipaths

// Prefix is the root every API route hangs off. The server mounts its routes on
// a subrouter for it, so a registration there names the path with Prefix
// removed (see the apiRoute helper in cmd/juggler/server/routes.go).
const Prefix = "/api"

const (
	// Health answers "is a Juggler server listening here at all". Probed by the
	// integration harness while waiting for a spawned server to accept.
	Health = Prefix + "/health"

	// HealthActive reports whether any conversation is actively running a turn.
	// Read by the desktop app before it closes a window or quits, so a turn in
	// flight can be confirmed rather than silently discarded (busy_guard.go).
	HealthActive = Prefix + "/health/active"

	// HealthInstance identifies the process holding a project's lock: pid,
	// project path, and whether it dies with its parent. Probed by ANOTHER
	// juggler process deciding whether to attach to it, wait for it, or spawn
	// (core/lockfile.go), which is why it cannot require a token — the prober
	// has never loaded the page that carries one.
	HealthInstance = Prefix + "/health/instance"

	// Shutdown asks a lock-holding instance to stop gracefully. The other half
	// of HealthInstance, and called by the same cross-instance path.
	Shutdown = Prefix + "/shutdown"

	// SessionWindowState is one window role's saved frame, stored with the
	// project's session. Read and written by the desktop app around the viewer
	// page's lifetime — before it has loaded, and as it closes.
	SessionWindowState = Prefix + "/session/window-state"

	// SessionPinboardBoards creates and deletes the board a detached window
	// holds. The desktop app DELETEs one as that window closes, having no page
	// and so no token; that method on this path is the only write the token gate
	// lets through unauthenticated.
	SessionPinboardBoards = Prefix + "/session/pinboard/boards"

	// WebRTCSignal carries the SDP exchange that bootstraps a DataChannel. The
	// offering peer is by definition not yet connected, so it holds no token.
	WebRTCSignal = Prefix + "/webrtc/signal"

	// WebSocket is the viewer's live connection. The upgrade authenticates
	// itself — the token rides as a ?token= query param, since a WebSocket
	// handshake cannot carry a custom header — so the middleware steps aside
	// for it (see websocket_loop.go).
	WebSocket = Prefix + "/ws"
)
