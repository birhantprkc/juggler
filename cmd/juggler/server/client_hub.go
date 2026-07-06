//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// clientHub is the process-scoped actor that owns the set of all connected
// WebSocket clients. Use it for full-fleet broadcasts (project-changed,
// providers-update, session-changed, shutdown notices) — anything that
// needs to reach engine and every viewer regardless of project.

package server

type hubOpKind int

const (
	hubRegister hubOpKind = iota
	hubUnregister
	hubBroadcast
	hubShutdown
)

type hubOp struct {
	kind   hubOpKind
	client RealtimeClient
	msg    any
	doneCh chan struct{}
}

type clientHub struct {
	ch chan hubOp
}

func newClientHub() *clientHub {
	h := &clientHub{ch: make(chan hubOp, 64)}
	go h.run()
	return h
}

func (h *clientHub) run() {
	clients := make(map[string]RealtimeClient)
	for op := range h.ch {
		switch op.kind {
		case hubRegister:
			clients[op.client.ClientID()] = op.client
		case hubUnregister:
			delete(clients, op.client.ClientID())
		case hubBroadcast:
			for _, c := range clients {
				c.Send(op.msg)
			}
		case hubShutdown:
			shutdownMsg := map[string]any{
				"type":    "server_shutdown",
				"message": "Server is shutting down",
			}
			for _, c := range clients {
				c.Send(shutdownMsg)
				c.Close()
			}
			close(op.doneCh)
			return
		}
	}
}

func (h *clientHub) register(c RealtimeClient)   { h.ch <- hubOp{kind: hubRegister, client: c} }
func (h *clientHub) unregister(c RealtimeClient) { h.ch <- hubOp{kind: hubUnregister, client: c} }
func (h *clientHub) broadcast(msg any)           { h.ch <- hubOp{kind: hubBroadcast, msg: msg} }

func (h *clientHub) shutdown() {
	done := make(chan struct{})
	h.ch <- hubOp{kind: hubShutdown, doneCh: done}
	<-done
}
