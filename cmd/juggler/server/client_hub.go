//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// clientHub is the process-scoped actor that owns the set of all connected
// WebSocket clients. Use it for full-fleet broadcasts (project-changed,
// providers-update, session-changed, shutdown notices) — anything that
// needs to reach engine and every viewer regardless of project.
//
// Delivery is per-client and asynchronous: each registered client owns a
// mailbox.Mailbox, so the actor hands a broadcast off in one goroutine hop and
// a client that has stopped draining delays nobody but itself (see
// cmd/juggler/mailbox). The single exception is the shutdown notice, which is
// sent inline for the reason recorded at that site.

package server

import "juggler/cmd/juggler/mailbox"

type hubOpKind int

const (
	hubRegister hubOpKind = iota
	hubUnregister
	hubBroadcast
	hubViewerCount
	hubViewerList
	hubShutdown
)

type hubOp struct {
	kind       hubOpKind
	client     RealtimeClient
	msg        any
	doneCh     chan struct{}
	intResult  chan int
	listResult chan []clientDescriptor
}

// clientDescriptor is the wire shape of one connected viewer, sent to the other
// viewers (via clients-changed and GET /api/connectivity) so the UI can list who
// shares the session. The id lets each recipient exclude itself.
type clientDescriptor struct {
	ID          string `json:"id"`
	Origin      string `json:"origin"`
	Detail      string `json:"detail"`
	UserAgent   string `json:"userAgent"`
	ConnectedAt int64  `json:"connectedAt"`
}

type clientHub struct {
	ch chan hubOp
}

func newClientHub() *clientHub {
	h := &clientHub{ch: make(chan hubOp, 64)}
	go h.run()
	return h
}

// hubClient is one registered client and its outbound pipeline. The client
// itself is kept because the hub reports on it (role and display info feed
// clients-changed and GET /api/connectivity); the mailbox is how anything
// actually reaches it. Everything the hub sends goes through mb — a client's
// Send blocks while its send buffer is full, and calling it from the actor
// loop would stall every other client behind the slowest one.
type hubClient struct {
	c  RealtimeClient
	mb *mailbox.Mailbox[outboundMsg]
}

func (h *clientHub) run() {
	clients := make(map[string]hubClient)

	// remove drops a client and releases its delivery goroutines. Undelivered
	// messages go with it, which is right for a client that has left.
	remove := func(id string) {
		if hc, ok := clients[id]; ok {
			hc.mb.Stop()
			delete(clients, id)
		}
	}

	// viewerDescriptors returns one descriptor per connected user-facing (viewer)
	// client. The engine's hidden headless browser is not a viewer and is omitted.
	viewerDescriptors := func() []clientDescriptor {
		list := make([]clientDescriptor, 0, len(clients))
		for _, hc := range clients {
			if hc.c.ClientRole() != ClientRoleViewer {
				continue
			}
			info := hc.c.ClientInfo()
			list = append(list, clientDescriptor{
				ID:          hc.c.ClientID(),
				Origin:      info.Origin,
				Detail:      info.Detail,
				UserAgent:   info.UserAgent,
				ConnectedAt: info.ConnectedAt,
			})
		}
		return list
	}

	// broadcastViewers tells every viewer who is now connected, so each can show
	// how many OTHER clients share the session and describe them. Sent only to
	// viewers; the engine ignores it.
	broadcastViewers := func() {
		list := viewerDescriptors()
		msg := map[string]any{"type": "clients-changed", "count": len(list), "clients": list}
		for _, hc := range clients {
			if hc.c.ClientRole() == ClientRoleViewer {
				hc.mb.Enqueue(outboundMsg{json: msg})
			}
		}
	}

	for op := range h.ch {
		switch op.kind {
		case hubRegister:
			id := op.client.ClientID()
			// A re-register under a live id replaces the entry, so the old
			// pipeline is stopped rather than orphaned with its goroutines.
			remove(id)
			clients[id] = hubClient{c: op.client, mb: newClientMailbox(op.client)}
			if op.client.ClientRole() == ClientRoleViewer {
				broadcastViewers()
			}
		case hubUnregister:
			id := op.client.ClientID()
			if _, ok := clients[id]; ok {
				remove(id)
				if op.client.ClientRole() == ClientRoleViewer {
					broadcastViewers()
				}
			}
		case hubBroadcast:
			for _, hc := range clients {
				hc.mb.Enqueue(outboundMsg{json: op.msg})
			}
		case hubViewerCount:
			op.intResult <- len(viewerDescriptors())
		case hubViewerList:
			op.listResult <- viewerDescriptors()
		case hubShutdown:
			shutdownMsg := map[string]any{
				"type":    "server_shutdown",
				"message": "Server is shutting down",
			}
			for _, hc := range clients {
				// Sent inline, and deliberately not through the mailbox: the
				// notice exists to be read on the way out, and the ordering with
				// the Close below is what makes that work — writePump flushes
				// what is already queued when it sees the close. Enqueuing makes
				// the hand-off asynchronous, so the Close can land first and the
				// client goes down without ever hearing why. The stall a wedged
				// client can cause here reaches only teardown, which is bounded
				// by serverShutdownTimeout / quitGraceTimeout.
				hc.mb.Stop()
				hc.c.Send(shutdownMsg)
				hc.c.Close()
			}
			close(op.doneCh)
			return
		}
	}
}

func (h *clientHub) register(c RealtimeClient)   { h.ch <- hubOp{kind: hubRegister, client: c} }
func (h *clientHub) unregister(c RealtimeClient) { h.ch <- hubOp{kind: hubUnregister, client: c} }
func (h *clientHub) broadcast(msg any)           { h.ch <- hubOp{kind: hubBroadcast, msg: msg} }

// viewerCount returns the number of connected viewer (user-facing) clients,
// excluding the engine's hidden headless browser.
func (h *clientHub) viewerCount() int {
	r := make(chan int, 1)
	h.ch <- hubOp{kind: hubViewerCount, intResult: r}
	return <-r
}

// viewerClients returns a descriptor for each connected viewer client, for the
// connected-clients UI. Excludes the engine's hidden headless browser.
func (h *clientHub) viewerClients() []clientDescriptor {
	r := make(chan []clientDescriptor, 1)
	h.ch <- hubOp{kind: hubViewerList, listResult: r}
	return <-r
}

func (h *clientHub) shutdown() {
	done := make(chan struct{})
	h.ch <- hubOp{kind: hubShutdown, doneCh: done}
	<-done
}
