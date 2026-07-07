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

func (h *clientHub) run() {
	clients := make(map[string]RealtimeClient)

	// viewerDescriptors returns one descriptor per connected user-facing (viewer)
	// client. The engine's hidden headless browser is not a viewer and is omitted.
	viewerDescriptors := func() []clientDescriptor {
		list := make([]clientDescriptor, 0, len(clients))
		for _, c := range clients {
			if c.ClientRole() != ClientRoleViewer {
				continue
			}
			info := c.ClientInfo()
			list = append(list, clientDescriptor{
				ID:          c.ClientID(),
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
		for _, c := range clients {
			if c.ClientRole() == ClientRoleViewer {
				c.Send(msg)
			}
		}
	}

	for op := range h.ch {
		switch op.kind {
		case hubRegister:
			clients[op.client.ClientID()] = op.client
			if op.client.ClientRole() == ClientRoleViewer {
				broadcastViewers()
			}
		case hubUnregister:
			if _, ok := clients[op.client.ClientID()]; ok {
				delete(clients, op.client.ClientID())
				if op.client.ClientRole() == ClientRoleViewer {
					broadcastViewers()
				}
			}
		case hubBroadcast:
			for _, c := range clients {
				c.Send(op.msg)
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
