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
	"sync"
	"syscall"
	"time"

	"juggler/internal/jlog"

	"github.com/gorilla/websocket"
)

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
		err := c.conn.WriteMessage(websocket.TextMessage, payload)
		if err == nil {
			return true
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
