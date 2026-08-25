//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"sync"
	"syscall"
	"time"

	"juggler/internal/jlog"

	"github.com/gorilla/websocket"
)

const (
	// wsWriteTimeout bounds how long a single message write may block.
	//
	// A peer can accept a connection and then stop draining it — a suspended
	// laptop, dead wifi, a half-open TCP connection nothing has noticed. The
	// write then sits in the kernel socket buffer indefinitely, and the stall
	// propagates: the writer goroutine blocks, its 256-deep send buffer fills,
	// trySend blocks behind it, and any actor that calls Send inline blocks
	// behind that. One dead client stalls every live one, so the write needs a
	// bound even though there is nothing to usefully do when it expires.
	//
	// 60s sits well clear of the slowest legitimate write. The worst of those
	// is a remote viewer pulling a full-state resync, which runs to megabytes
	// on a large conversation — but remote peers negotiate permessage-deflate,
	// so the wire size is a fraction of the logical one, and the deadline
	// covers handing the message to the kernel, not its round trip. That
	// clears a multi-megabyte transfer on a link an order of magnitude worse
	// than a usable one. Shorter is tempting (it is also the bound on how long
	// a wedged client can stall an actor) but below ~30s a slow-but-alive
	// client on a big conversation is at risk, and killing it mid-resync
	// buys nothing: it reconnects and repeats the same transfer.
	wsWriteTimeout = 60 * time.Second

	// wsCloseWriteTimeout bounds the goodbye frame. Two bytes on a connection
	// that is going away regardless, so it gets a short budget — the only
	// thing waiting behind it is teardown.
	wsCloseWriteTimeout = 5 * time.Second

	// wsWriteBufferSize sizes the per-connection buffer gorilla frames
	// outgoing messages in.
	//
	// gorilla splits a compressed message across frames as soon as it outgrows
	// this buffer, and fragmented compressed frames are the shape WebKit has
	// historically mishandled — which matters here because every Juggler
	// viewer is WebKit (WKWebView on macOS, WebKitGTK on Linux) and remote
	// peers are exactly the ones that negotiate permessage-deflate. The
	// library's own guidance is to make the buffer larger than any expected
	// message. Juggler cannot honour that literally, since a full-state resync
	// runs to megabytes, but 32 KiB keeps ordinary traffic — sync deltas,
	// status, tool output chunks — inside a single frame, and costs one
	// syscall per 32 KiB rather than per kilobyte. Do not shrink it.
	wsWriteBufferSize = 32 * 1024
)

// newWSUpgrader builds the upgrader shared by viewer and engine connections.
//
// Deliberately no WriteBufferPool: a pool trades a get/put per message for
// buffers that idle connections do not hold, which pays off for many mostly
// quiet connections. Juggler is the opposite shape — a handful of connections
// (one engine, a few viewers) writing constantly for the length of a turn — so
// pooling would add churn to the hot path to reclaim a few hundred kilobytes.
func newWSUpgrader() websocket.Upgrader {
	return websocket.Upgrader{
		ReadBufferSize:  1024,
		WriteBufferSize: wsWriteBufferSize,
		CheckOrigin:     sameOriginCheck,
		// permessage-deflate (RFC 7692) is negotiated per-connection in
		// handleWebSocket — enabled only for remote (tunnel / LAN) peers, where
		// the link is the bottleneck, and left off for loopback (engine + local
		// viewer), where deflate is pure CPU cost. See handleWebSocket.
	}
}

// wsMessage represents a message to be written to the websocket.
// Either json (for WriteJSON) or raw (for WriteMessage) should be set, not both.
type wsMessage struct {
	json any    // For JSON-encoded messages
	raw  []byte // For raw text messages (streaming chunks)
}

// ClientRole identifies the type of WebSocket client
type ClientRole string

const (
	// ClientRoleViewer is a user browser that renders UI and sends user actions
	ClientRoleViewer ClientRole = "viewer"
	// ClientRoleEngine is the hidden headless browser that executes tools and renders context
	ClientRoleEngine ClientRole = "engine"
)

// WSClient wraps a WebSocket connection with a channel for serialized writes.
// A dedicated writer goroutine processes messages from the channel, ensuring
// only one goroutine writes to the connection at a time (required by gorilla/websocket).
type WSClient struct {
	ID        string     // Unique identifier for this client connection
	Role      ClientRole // Role: engine or viewer
	info      ClientInfo // Display metadata captured at connect (see clientInfoFromRequest)
	conn      *websocket.Conn
	send      chan wsMessage // Channel for outgoing messages
	closed    chan struct{}  // Closed to signal shutdown; see Close
	closeOnce sync.Once      // Ensures closed is closed only once
	stats     *wsStats       // Optional outbound byte accounting; nil = disabled
}

// generateClientID creates a unique client ID using crypto/rand
func generateClientID() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("client_%d", time.Now().UnixNano())
	}
	return fmt.Sprintf("client_%s", hex.EncodeToString(b))
}

// NewWSClient creates a new WSClient and starts its writer goroutine. info is
// display metadata for the connected-clients UI; stats may be nil (accounting
// disabled).
func NewWSClient(conn *websocket.Conn, role ClientRole, info ClientInfo, stats *wsStats) *WSClient {
	client := &WSClient{
		ID:     generateClientID(),
		Role:   role,
		info:   info,
		conn:   conn,
		send:   make(chan wsMessage, 256), // Buffered to prevent blocking senders
		closed: make(chan struct{}),
		stats:  stats,
	}
	go client.writePump()
	return client
}

// retryableWriteError reports whether a connection write failed for a
// TRANSIENT kernel-side reason that warrants retrying the same payload
// rather than declaring the connection dead. ENOBUFS means the socket
// buffer was momentarily full (observed on macOS loopback under the
// 9-lane test pool's burst load — and just as possible in production);
// treating it as fatal permanently severs one client's delivery while
// everything else keeps running, which presents as that viewer's doc
// frozen mid-turn with no error anywhere near the symptom.
func retryableWriteError(err error) bool {
	return errors.Is(err, syscall.ENOBUFS)
}

// writeDeadlineExceeded reports whether err is the write deadline expiring:
// the peer is holding a connection open without draining it. Unlike ENOBUFS
// this is never worth retrying — the socket is fine, the peer is not, and
// gorilla latches the first write error on a connection and answers every
// later write with it, so nothing more will go out either way. Closing lets
// the client reconnect, which is the only thing that recovers it.
//
// Matched through the net.Error interface rather than os.ErrDeadlineExceeded:
// gorilla substitutes its own net.Error implementation for the underlying
// error, and that type carries Timeout() but no Unwrap, so the sentinel does
// not match it.
func writeDeadlineExceeded(err error) bool {
	var netErr net.Error
	return errors.As(err, &netErr) && netErr.Timeout()
}

// writePump is the dedicated writer goroutine - only this goroutine writes to the connection
func (c *WSClient) writePump() {
	defer c.conn.Close()
	for {
		select {
		case msg := <-c.send:
			if !c.writeOne(msg) {
				return
			}
		case <-c.closed:
			// Shutting down. Flush whatever is already queued first — a close is
			// often preceded by a message that exists precisely to be read on the
			// way out (the hub's server_shutdown notice) — then say goodbye.
			for {
				select {
				case msg := <-c.send:
					if !c.writeOne(msg) {
						return
					}
					continue
				default:
				}
				break
			}
			_ = c.conn.SetWriteDeadline(time.Now().Add(wsCloseWriteTimeout))
			_ = c.conn.WriteMessage(websocket.CloseMessage,
				websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
			return
		}
	}
}

// writeOne writes a single queued message, reporting whether the pump may
// continue. Only writePump calls it, so the one-writer-per-connection rule
// gorilla requires still holds.
func (c *WSClient) writeOne(msg wsMessage) bool {
	payload := msg.raw
	if payload == nil {
		var mErr error
		if payload, mErr = json.Marshal(msg.json); mErr != nil {
			jlog.Error("WebSocket marshal error for client %p: %v", c, mErr)
			return true
		}
	}
	c.stats.record(statsOut, payload, c.Role)
	// Bounded retry on transient kernel backpressure. There is no
	// writability event to await at this layer, so a short escalating
	// backoff is the correct handling: ENOBUFS clears as the kernel
	// drains in milliseconds. Total worst-case wait ≈ 1s, after which
	// the error is treated as fatal like any other.
	for attempt := 0; ; attempt++ {
		// Armed fresh per attempt so the backoff below spends its own time
		// rather than the write's budget. SetWriteDeadline only records the
		// time; gorilla applies it to the socket inside its write lock, in the
		// same critical section as the write itself, so this cannot be
		// clobbered by the pong and close frames gorilla sends from the read
		// goroutine via WriteControl.
		_ = c.conn.SetWriteDeadline(time.Now().Add(wsWriteTimeout))
		err := c.conn.WriteMessage(websocket.TextMessage, payload)
		if err == nil {
			return true
		}
		if writeDeadlineExceeded(err) {
			jlog.Error("WebSocket write to client %p exceeded %s and was abandoned; "+
				"the peer stopped reading (%d queued). Closing so it can reconnect: %v",
				c, wsWriteTimeout, len(c.send), err)
			return false
		}
		if retryableWriteError(err) && attempt < 19 {
			time.Sleep(time.Duration(attempt+1) * 5 * time.Millisecond)
			continue
		}
		jlog.Error("WebSocket write error for client %p (attempt %d): %v", c, attempt+1, err)
		return false
	}
}

// trySend queues a message, blocking while the buffer is full but never past
// the client's close. Returns false once the client is closed.
//
// Shutdown is signalled by closing a separate `closed` channel rather than the
// send channel itself: a sender and a closer can run on any two goroutines (a
// broadcast racing the engine supervisor, say), and closing a channel from under
// a concurrent send is a data race that costs a panic per send — previously
// swallowed by a recover here, which hid the race without preventing it.
func (c *WSClient) trySend(msg wsMessage) bool {
	// Prefer the closed signal when both are ready, so a closed client stops
	// accepting work promptly rather than by chance.
	select {
	case <-c.closed:
		return false
	default:
	}
	select {
	case c.send <- msg:
		return true
	case <-c.closed:
		return false
	}
}

// Send queues a JSON message to be written to the websocket.
// Blocks if buffer is full. Returns false only if the client is closed.
func (c *WSClient) Send(msg any) bool {
	return c.trySend(wsMessage{json: msg})
}

// SendRaw queues a raw text message to be written to the websocket.
// Used for streaming chunks that don't need JSON encoding.
// Blocks if buffer is full. Returns false only if the client is closed.
func (c *WSClient) SendRaw(data []byte) bool {
	return c.trySend(wsMessage{raw: data})
}

// Close stops the writer goroutine and closes the connection. Safe to call
// multiple times, and from any goroutine — including one that is not the
// client's owner, which is how a wedged engine is evicted.
func (c *WSClient) Close() {
	c.closeOnce.Do(func() {
		close(c.closed)
	})
}

// QueuedWrites reports how many messages are waiting to be written to this
// client. A peer that has stopped reading shows up here as a backlog climbing
// toward the send channel's capacity, which is the difference between "quiet"
// and "not draining" — worth naming in any diagnostic about a client that has
// gone silent.
func (c *WSClient) QueuedWrites() int { return len(c.send) }

func (c *WSClient) ClientID() string       { return c.ID }
func (c *WSClient) ClientRole() ClientRole { return c.Role }
func (c *WSClient) ClientInfo() ClientInfo { return c.info }

// Sender is the interface for broadcasting messages to a WebSocket client.
// WSClient satisfies this interface.
type Sender interface {
	Send(msg any) bool
	SendRaw(data []byte) bool
}
