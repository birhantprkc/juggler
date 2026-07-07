//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"encoding/json"

	"juggler/cmd/juggler/worker"
	"juggler/internal/jlog"
)

// ClientInfo is descriptive metadata about a connected client, captured once at
// connect time, so the OTHER clients sharing the session can be shown who is
// connected and how. Purely presentational — nothing keys off it.
type ClientInfo struct {
	Origin      string // "local" (same machine), "lan", or "remote"
	Detail      string // LAN IP, or the remote transport label; empty for local
	UserAgent   string // raw User-Agent, when the transport carried one
	ConnectedAt int64  // connection time, unix milliseconds
}

// RealtimeClient is the transport-independent server-side client surface used
// by the WebSocket protocol. A client may be backed by a real WebSocket
// or by a WebRTC DataChannel; the JSON message protocol above it is identical.
type RealtimeClient interface {
	Sender
	Close()
	ClientID() string
	ClientRole() ClientRole
	ClientInfo() ClientInfo
}

// runRealtimeClientLoop runs the WS message protocol on top of any
// ordered, reliable text transport. msgCh carries raw inbound JSON text frames;
// done is closed when the transport reader ends.
func (s *Server) runRealtimeClientLoop(ctx context.Context, client RealtimeClient, msgCh <-chan []byte, done <-chan struct{}) {
	role := client.ClientRole()

	// Track engine client and register on worker manager. WebRTC currently only
	// accepts viewer clients, but keeping this generic preserves the protocol seam.
	if role == ClientRoleEngine {
		if wsClient, ok := client.(*WSClient); ok {
			s.engineClient.Store(wsClient)
		}
		s.workerManager.SetEngineClient(client.ClientID(), func(convID string, msg []byte) {
			envelope := worker.FormatWorkerMessage(convID, msg)
			if envelope != nil {
				client.SendRaw(envelope)
			}
		})
		jlog.Debug("Internal browser connected")
		defer func() {
			s.workerManager.ClearEngineClient(client.ClientID())
			if wsClient, ok := client.(*WSClient); ok && s.engineClient.CompareAndSwap(wsClient, nil) {
				jlog.Debug("Internal browser disconnected")
			}
		}()
	}

	// Send session ready signal to client. It carries the client's own
	// server-assigned id so the UI can exclude itself from the connected-clients
	// list it receives via clients-changed.
	client.Send(map[string]string{"type": "session", "clientId": client.ClientID()})

	// Register with server state for broadcasts. Done AFTER the session send so
	// the client already knows its own id before the first clients-changed
	// broadcast (which registering triggers) can reach it.
	s.registerClient(client)
	defer s.unregisterClient(client)

	// Seed providers snapshot. `ready` is false until the first refresh has
	// computed real availability, so clients don't mistake the empty/stale connect
	// seed for a settled "no providers configured" result.
	client.Send(map[string]any{
		"type":      "providers-update",
		"providers": s.cachedProviders(),
		"ready":     s.providersReadyNow(),
	})

	// Join viewer group for multi-view broadcasting.
	s.joinViewerGroup(client)
	defer s.leaveViewerGroup(client.ClientID())

	clientCtx, cancelClient := context.WithCancel(ctx)
	defer cancelClient()

	shellStartChan := make(chan ShellStartRequest, 100)
	shellCancelChan := make(chan string, 100)
	shellCompleteChan := make(chan string, 100)

	for {
		select {
		case <-done:
			if s.workerManager != nil {
				s.workerManager.ClientDisconnected(client.ClientID())
			}
			return

		case msgBytes, ok := <-msgCh:
			if !ok {
				if s.workerManager != nil {
					s.workerManager.ClientDisconnected(client.ClientID())
				}
				return
			}
			var generic GenericWSMessage
			if err := json.Unmarshal(msgBytes, &generic); err != nil {
				jlog.Error("Realtime: failed to parse message: %v", err)
				continue
			}

			s.stats.record(statsIn, msgBytes, role)

			switch generic.Type {
			case "shell-start":
				shellReq, ok := unmarshalWS[ShellStartRequest](msgBytes, "shell-start")
				if !ok {
					continue
				}
				select {
				case shellStartChan <- shellReq:
				default:
					jlog.Error("Realtime: shell-start channel full, dropping")
				}

			case "shell-cancel":
				shellCancel, ok := unmarshalWS[ShellCancelRequest](msgBytes, "shell-cancel")
				if !ok {
					continue
				}
				select {
				case shellCancelChan <- shellCancel.ShellID:
				default:
				}

			case "engine-bridge":
				if role != ClientRoleEngine {
					continue
				}
				s.viewerSendRawToAll(msgBytes)

			case "session-changed":
				s.broadcastToAll(map[string]any{"type": "session-changed"})

			case "worker-message":
				if s.workerManager == nil {
					continue
				}
				wm, ok := unmarshalWS[worker.WorkerMessage](msgBytes, "worker-message")
				if !ok {
					continue
				}
				convID := wm.ConversationID
				sendCallback := func(msg []byte) {
					envelope := worker.FormatWorkerMessage(convID, msg)
					if envelope != nil {
						client.SendRaw(envelope)
					}
				}
				s.workerManager.HandleMessageWithClient(wm.ConversationID, client.ClientID(), wm.WorkerMsgType, wm.Payload, sendCallback)

			default:
				jlog.Error("Realtime: unrecognized message type %q", generic.Type)
			}

		case shellID := <-shellCancelChan:
			if s.viewerCancelShell(shellID) {
				jlog.Info("Cancelled shell: %s", shellID)
			} else {
				// Not necessarily a bug (the shell may have completed just as the
				// cancel arrived), but never swallow it silently: a cancel that
				// misses a still-running shell orphans its process until timeout.
				jlog.Info("shell-cancel for %s matched no active shell (completed already, or tracking lost)", shellID)
			}

		case shellID := <-shellCompleteChan:
			// Diagnostic for the "tool stuck in running" wedge: pairs with the
			// shell-start line below (match on shellID) so a hung bash shows up as
			// a shell-start with no matching shell-complete.
			jlog.Debug("Shell complete: shellID=%s", shellID)
			s.viewerCompleteShell(shellID)

		case shellReq := <-shellStartChan:
			jlog.Debug("Shell start: shellID=%s", shellReq.ShellID)
			ctx, cancel := context.WithCancel(clientCtx)
			if !s.viewerStartShell(shellReq.ShellID, cancel) {
				cancel()
				jlog.Error("Shell start REJECTED (ID already in use): shellID=%s", shellReq.ShellID)
				// Route the rejection to the requester (not the viewer group) so
				// the engine's shellExecuteStreaming settles. Matches the
				// output-delivery path in processShellRequest.
				client.Send(map[string]any{
					"type":    "shell-output",
					"shellId": shellReq.ShellID,
					"done":    true,
					"error":   "Shell ID already in use",
				})
				continue
			}
			go s.processShellRequest(ctx, shellReq, client, shellCompleteChan)
		}
	}
}
