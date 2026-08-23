//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"juggler/cmd/juggler/worker"

	"github.com/gorilla/websocket"
)

// Engine liveness. The engine is the sole tool executor, and the worker's
// tool-command driver refuses to act unless the server says an engine is
// attached (worker/tool_commands.go). "Attached" must therefore mean the engine
// can still DO something — not merely that a socket was once upgraded with
// role=engine and its read loop has not returned.
//
// The failure these guard is a hidden WebView whose JS realm has stopped while
// its socket stays perfectly healthy: WebKit runs the WebSocket in the network
// process, so the transport keeps answering control frames long after the page
// (and its module worker) has been suspended or wedged. The server keeps
// reporting an engine, the worker keeps dispatching commands into it, nothing
// ever executes, and every tool in every conversation dies with "the tool engine
// never handled this command" until the whole app is restarted.

// muteDetectionBudget bounds how long a test waits for the server to notice a
// mute engine. It is a test-local patience limit, not a product constant: the
// production liveness window is set by the server and shortened through the
// seam below so these run fast.
const muteDetectionBudget = 3 * time.Second

// newEngineSocketServer stands up a real HTTP server carrying the production
// WebSocket handler, with just enough Server state for an engine-role upgrade to
// complete: the client hub and viewer group the realtime loop registers into,
// and a worker Manager for the SetEngineClient/ClearEngineClient calls.
//
// The upgrader is deliberately bare. The Origin policy is a separate concern
// from liveness, and a Go dialer sends no Origin header.
func newEngineSocketServer(t *testing.T) (*Server, *httptest.Server) {
	t.Helper()
	s := newTestServerState(t)
	s.workerManager = worker.NewManager()
	s.upgrader = websocket.Upgrader{}
	// Shorten the staleness window so a mute engine is condemned in test time
	// rather than production time. Still several heartbeat intervals wide.
	s.setEngineLivenessWindow(300 * time.Millisecond)
	ts := httptest.NewServer(http.HandlerFunc(s.handleWebSocket))
	t.Cleanup(ts.Close)
	return s, ts
}

// dialEngine opens a real WebSocket claiming the engine role. httptest listens
// on loopback, so engineRoleAllowed admits it and the token gate exempts it.
func dialEngine(t *testing.T, ts *httptest.Server) *websocket.Conn {
	t.Helper()
	url := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws?role=engine"
	conn, resp, err := websocket.DefaultDialer.Dial(url, nil)
	if resp != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		t.Fatalf("engine WS dial failed: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

// freezeRealm simulates a suspended engine: the socket stays open and the
// transport stays responsive — gorilla answers server pings from inside
// ReadMessage — but the realm above it never speaks again. This is the state a
// backgrounded WKWebView reaches, and the one no code currently detects.
func freezeRealm(conn *websocket.Conn) {
	go func() {
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}()
}

// waitUntil polls cond until it holds or the budget expires.
func waitUntil(budget time.Duration, cond func() bool) bool {
	deadline := time.Now().Add(budget)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	return cond()
}

// TestEngineSocket_MuteEngineIsDetected is the reproduction. An engine that
// registers and then stops participating — while its socket remains open and
// answers control frames — must stop counting as a connected engine, so the
// worker stops driving tools into it and a turn fails honestly with
// engine-not-available instead of blaming each tool in turn.
func TestEngineSocket_MuteEngineIsDetected(t *testing.T) {
	s, ts := newEngineSocketServer(t)
	conn := dialEngine(t, ts)

	if !waitUntil(muteDetectionBudget, s.IsEngineConnected) {
		t.Fatal("engine never registered — the mute case cannot be exercised")
	}

	freezeRealm(conn)

	if !waitUntil(muteDetectionBudget, func() bool { return !s.IsEngineConnected() }) {
		t.Fatalf("a mute engine stayed registered for %v: the socket is open and "+
			"answering pings, but nothing above the transport has spoken. The "+
			"worker keeps dispatching tool-commands into it and escalates every "+
			"tool to \"the tool engine never handled this command\" until restart",
			muteDetectionBudget)
	}
}

// TestEngineSocket_SilentEngineIsEvicted: noticing is not enough. The worker
// gates every tool-command dispatch on the engine callback still being
// registered, and that registration is only dropped when the socket closes — so
// a wedged engine must have its socket closed, or the worker goes on commanding
// a corpse. Eviction is also the cheap repair: a live realm behind a wedged link
// reconnects within a second.
func TestEngineSocket_SilentEngineIsEvicted(t *testing.T) {
	s, ts := newEngineSocketServer(t)
	conn := dialEngine(t, ts)

	if !waitUntil(muteDetectionBudget, s.IsEngineConnected) {
		t.Fatal("engine never registered")
	}
	freezeRealm(conn)

	// Let the liveness window lapse, then run one supervision tick.
	time.Sleep(400 * time.Millisecond)
	s.superviseEngine()

	if !waitUntil(muteDetectionBudget, func() bool { return s.engineClient.Load() == nil }) {
		t.Fatal("a silent engine kept its socket: the worker would still see an " +
			"engine attached and keep dispatching tool-commands into it")
	}

	// And the slot is reusable: a fresh engine takes over cleanly.
	dialEngine(t, ts)
	if !waitUntil(muteDetectionBudget, s.IsEngineConnected) {
		t.Fatal("a replacement engine could not register after an eviction")
	}
}

// TestWSClient_CloseIsSafeAgainstConcurrentSenders. Evicting a wedged engine
// means closing a client from a goroutine that does not own it, while broadcasts
// may be sending to that same client. Shutdown must therefore be signalled
// without closing the channel senders are writing to — otherwise every racing
// send is a send-on-closed-channel panic, and the client's own writes race the
// closer. Run under -race, this pins that.
func TestWSClient_CloseIsSafeAgainstConcurrentSenders(t *testing.T) {
	c := testWSClient("client-close-race")

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 200; j++ {
				c.Send(map[string]string{"type": "noise"})
			}
		}()
	}
	// Close from yet another goroutine, part-way through the traffic.
	wg.Add(1)
	go func() {
		defer wg.Done()
		time.Sleep(time.Millisecond)
		c.Close()
		c.Close() // idempotent
	}()
	wg.Wait()

	if c.Send(map[string]string{"type": "after-close"}) {
		t.Fatal("a closed client accepted a send")
	}
}

// TestEngineSupervisor_EscalatesToRecovery: eviction only repairs a broken link.
// When the realm itself is gone, nothing reconnects, and the supervisor must
// escalate to the recovery hook that reloads the engine host.
func TestEngineSupervisor_EscalatesToRecovery(t *testing.T) {
	s := newTestServerState(t)

	recovered := make(chan struct{}, maxEngineRecoveries+2)
	s.SetEngineRecovery(func() { recovered <- struct{}{} })

	// An engine we evicted, whose reconnect grace has long since lapsed.
	s.engineEvictedAt.Store(time.Now().Add(-2 * engineReconnectGrace).UnixNano())
	s.superviseEngine()

	select {
	case <-recovered:
	default:
		t.Fatal("an evicted engine that never came back must escalate to recovery")
	}

	// And it gives up rather than reloading forever.
	for i := 0; i < maxEngineRecoveries+2; i++ {
		s.engineEvictedAt.Store(time.Now().Add(-2 * engineReconnectGrace).UnixNano())
		s.superviseEngine()
	}
	if got := len(recovered); got > maxEngineRecoveries {
		t.Fatalf("recovery must stop after %d attempts, fired %d more times",
			maxEngineRecoveries, got)
	}
}

// TestEngineSupervisor_IgnoresAnEngineItNeverEvicted: an engine that has simply
// never connected belongs to startEngineHost's boot check, and a disconnect
// during shutdown belongs to nobody. The supervisor must only chase engines it
// killed itself, or it would fight both.
func TestEngineSupervisor_IgnoresAnEngineItNeverEvicted(t *testing.T) {
	s := newTestServerState(t)

	fired := make(chan struct{}, 1)
	s.SetEngineRecovery(func() { fired <- struct{}{} })

	s.superviseEngine() // no engine, no eviction on record

	select {
	case <-fired:
		t.Fatal("supervisor tried to recover an engine it never evicted")
	default:
	}
}

// TestEngineSocket_LiveEngineStaysConnected is the other half of the contract:
// whatever proves liveness must be satisfied by an engine that is merely idle.
// A user who reads for ten minutes without sending anything must not have their
// engine torn down underneath them.
func TestEngineSocket_LiveEngineStaysConnected(t *testing.T) {
	s, ts := newEngineSocketServer(t)
	conn := dialEngine(t, ts)

	if !waitUntil(muteDetectionBudget, s.IsEngineConnected) {
		t.Fatal("engine never registered")
	}

	// A live realm: drains its socket AND keeps proving it is running.
	freezeRealm(conn)
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		tick := time.NewTicker(50 * time.Millisecond)
		defer tick.Stop()
		for {
			select {
			case <-stop:
				return
			case <-tick.C:
				if err := conn.WriteJSON(map[string]string{"type": "engine-heartbeat"}); err != nil {
					return
				}
			}
		}
	}()

	if waitUntil(muteDetectionBudget, func() bool { return !s.IsEngineConnected() }) {
		t.Fatal("a live engine was dropped: liveness must be satisfied by an idle " +
			"but running realm, not by user traffic")
	}
}
