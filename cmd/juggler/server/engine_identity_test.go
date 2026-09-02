//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// Whose engine is this? The engine slot goes to the newest arrival, and an
// engine dials its server's address forever — so an engine that outlives its
// server finds whatever binds that address next and is adopted by it. The
// stranger then receives the work meant for the real engine and does nothing
// with it, which is a run that hangs until its caller gives up rather than an
// error anyone can see.
//
// The per-process API token is the only thing that tells the two apart, and the
// node host sends it. These pin that a mismatched token is refused, that our own
// is admitted, and that an engine sending none is still admitted — the webview
// host's socket lives in a worker with no token to send, and loopback is what
// has always vouched for it.

// dialEngineToken opens an engine-role WebSocket carrying the given token
// (omitted entirely when empty), and reports whether the server kept it. A
// rejection arrives after the upgrade, so the dial itself succeeds either way
// and the first read is what tells them apart.
func dialEngineToken(t *testing.T, ts *httptest.Server, token string) bool {
	t.Helper()
	target := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws?role=engine"
	if token != "" {
		target += "&token=" + url.QueryEscape(token)
	}
	conn, resp, err := websocket.DefaultDialer.Dial(target, nil)
	if resp != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		t.Fatalf("engine WS dial failed: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })

	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, _, readErr := conn.ReadMessage()
	return readErr == nil
}

func TestEngineUpgradeRefusesAnotherInstancesToken(t *testing.T) {
	s, ts := newEngineSocketServer(t)
	s.apiToken = "this-instance"

	if dialEngineToken(t, ts, "the-instance-that-died") {
		t.Fatal("an engine carrying another instance's token was let in")
	}
	if s.IsEngineConnected() {
		t.Fatal("a refused engine still took the engine slot")
	}
}

func TestEngineUpgradeAcceptsOurOwnTokenAndNone(t *testing.T) {
	for _, tc := range []struct {
		name  string
		token string
	}{
		{"our own token", "this-instance"},
		{"no token at all", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, ts := newEngineSocketServer(t)
			s.apiToken = "this-instance"

			if !dialEngineToken(t, ts, tc.token) {
				t.Fatal("the engine was refused")
			}
			if !s.IsEngineConnected() {
				t.Fatal("the engine connected but never took the engine slot")
			}
		})
	}
}
