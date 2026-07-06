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
	conn      *websocket.Conn
	send      chan wsMessage // Channel for outgoing messages; closed to signal shutdown
	closeOnce sync.Once      // Ensures send channel is closed only once
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

// NewWSClient creates a new WSClient and starts its writer goroutine. stats may
// be nil (accounting disabled).
func NewWSClient(conn *websocket.Conn, role ClientRole, stats *wsStats) *WSClient {
	client := &WSClient{
		ID:    generateClientID(),
		Role:  role,
		conn:  conn,
		send:  make(chan wsMessage, 256), // Buffered to prevent blocking senders
		stats: stats,
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
	for msg := range c.send {
		payload := msg.raw
		if payload == nil {
			var mErr error
			if payload, mErr = json.Marshal(msg.json); mErr != nil {
				jlog.Error("WebSocket marshal error for client %p: %v", c, mErr)
				continue
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
				break
			}
			if retryableWriteError(err) && attempt < 19 {
				time.Sleep(time.Duration(attempt+1) * 5 * time.Millisecond)
				continue
			}
			jlog.Error("WebSocket write error for client %p (attempt %d): %v", c, attempt+1, err)
			return
		}
	}
	// Channel closed - send close message
	_ = c.conn.WriteMessage(websocket.CloseMessage,
		websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
}

// trySend sends on the channel, blocking if buffer is full.
// Returns true if sent successfully, false if channel is closed.
func (c *WSClient) trySend(msg wsMessage) (sent bool) {
	defer func() {
		if recover() != nil {
			sent = false
		}
	}()
	c.send <- msg
	return true
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

// Close stops the writer goroutine and closes the connection.
// Safe to call multiple times.
func (c *WSClient) Close() {
	c.closeOnce.Do(func() {
		close(c.send)
	})
}

func (c *WSClient) ClientID() string       { return c.ID }
func (c *WSClient) ClientRole() ClientRole { return c.Role }

// Sender is the interface for broadcasting messages to a WebSocket client.
// WSClient satisfies this interface.
type Sender interface {
	Send(msg any) bool
	SendRaw(data []byte) bool
}
