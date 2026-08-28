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

// TestEngineSocket_ToolExecutionReportsDoNotProveLiveness. The tool-execution
// report is emitted by a timer whose only precondition is that the engine's
// executing set is non-empty, so a tool that claimed `running` and then hung
// keeps it arriving for as long as the wedge lasts. If that stamped liveness,
// the one message guaranteed to keep flowing during a wedge would be the one
// vouching hardest for the engine. Liveness has to mean the realm is getting
// somewhere, and only the heartbeat says that.
func TestEngineSocket_ToolExecutionReportsDoNotProveLiveness(t *testing.T) {
	s, ts := newEngineSocketServer(t)
	conn := dialEngine(t, ts)

	if !waitUntil(muteDetectionBudget, s.IsEngineConnected) {
		t.Fatal("engine never registered")
	}
	freezeRealm(conn)

	// A wedged engine that still reports its stuck executing set, and nothing else.
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
				if err := conn.WriteJSON(map[string]any{
					"type":           "worker-message",
					"conversationId": "conv-wedged",
					"workerMsgType":  "tool-execution-report",
					"payload":        map[string]any{"seq": 1, "executing": []any{}},
				}); err != nil {
					return
				}
			}
		}
	}()

	if !waitUntil(muteDetectionBudget, func() bool { return !s.IsEngineConnected() }) {
		t.Fatal("tool-execution reports kept a wedged engine registered: a tool " +
			"hung inside execute() emits these forever, so accepting them as " +
			"liveness makes the wedge invisible for as long as it lasts")
	}
}

// TestEngineSocket_OtherWorkerMessagesStillProveLiveness is the guard against
// over-correcting: the exemption is one message type, not the whole
// worker-message envelope. An engine doing real work down that channel must
// still count as alive.
func TestEngineSocket_OtherWorkerMessagesStillProveLiveness(t *testing.T) {
	s, ts := newEngineSocketServer(t)
	conn := dialEngine(t, ts)

	if !waitUntil(muteDetectionBudget, s.IsEngineConnected) {
		t.Fatal("engine never registered")
	}
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
				if err := conn.WriteJSON(map[string]any{
					"type":           "worker-message",
					"conversationId": "conv-busy",
					"workerMsgType":  "engine-trace",
					"payload":        map[string]any{"event": "execute-start"},
				}); err != nil {
					return
				}
			}
		}
	}()

	if waitUntil(muteDetectionBudget, func() bool { return !s.IsEngineConnected() }) {
		t.Fatal("an engine tracing real tool activity was dropped as silent")
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

// A reconnect loop is the failure the escalation ladder above cannot see. The
// ladder advances only through evictSilentEngine — an engine whose socket
// stayed open while its realm went quiet — so an engine that dies loudly and
// comes straight back never touches it. That is precisely the shape a message
// the client refuses produces: the connection dies, the client reconnects, the
// server sends the same message again, and the log fills with transport errors
// while nothing says the pattern is a loop.

// TestAReconnectLoopIsReportedOnce covers the counting itself: the loop is
// named the moment it stops being plausible recovery, and then stays quiet, so
// the report does not become part of the flood it exists to explain.
func TestAReconnectLoopIsReportedOnce(t *testing.T) {
	s := newTestServerState(t)
	at := time.Now()

	// Reconnects a second apart, as the client's settled backoff produces.
	for i := 0; i < maxEngineAttachesPerWindow; i++ {
		if s.noteEngineAttachedAt(at.Add(time.Duration(i) * time.Second)) {
			t.Fatalf("connection %d was called a loop; that many is still ordinary recovery", i+1)
		}
	}

	tripped := at.Add(time.Duration(maxEngineAttachesPerWindow) * time.Second)
	if !s.noteEngineAttachedAt(tripped) {
		t.Fatalf("connection %d was not reported; %d in %v is a loop",
			maxEngineAttachesPerWindow+1, maxEngineAttachesPerWindow+1, engineFlapWindow)
	}
	for i := 1; i <= 5; i++ {
		if s.noteEngineAttachedAt(tripped.Add(time.Duration(i) * time.Second)) {
			t.Fatalf("the loop was reported again %ds later; one line per episode, or the report joins the noise", i)
		}
	}
}

// TestAnEngineThatKeepsItsConnectionIsNotALoop is the other half: a session
// that reconnects occasionally over a long run — a suspended laptop, a link
// blip, a deliberate eviction and recovery — must never be called a loop, or
// the line means nothing when a real one arrives.
func TestAnEngineThatKeepsItsConnectionIsNotALoop(t *testing.T) {
	s := newTestServerState(t)
	at := time.Now()

	for i := 0; i < 20; i++ {
		when := at.Add(time.Duration(i) * (engineFlapWindow / 2))
		if s.noteEngineAttachedAt(when) {
			t.Fatalf("a reconnect every %v was reported as a loop at connection %d",
				engineFlapWindow/2, i+1)
		}
	}
}

// TestTheLoopReportRearmsOnceItSettles keeps the latch from silencing the rest
// of the session: an engine that loops, recovers, and loops again later is two
// episodes and deserves two lines.
func TestTheLoopReportRearmsOnceItSettles(t *testing.T) {
	s := newTestServerState(t)
	at := time.Now()

	trip := func(from time.Time) bool {
		reported := false
		for i := 0; i <= maxEngineAttachesPerWindow; i++ {
			if s.noteEngineAttachedAt(from.Add(time.Duration(i) * time.Second)) {
				reported = true
			}
		}
		return reported
	}

	if !trip(at) {
		t.Fatal("the first loop was not reported")
	}
	// Nothing for a full window: the history ages out and the latch re-arms.
	settled := at.Add(engineFlapWindow * 2)
	if s.noteEngineAttachedAt(settled) {
		t.Fatal("a lone reconnect after a quiet window was reported as a loop")
	}
	if !trip(settled.Add(time.Second)) {
		t.Fatal("a second loop later in the session went unreported; the latch never re-armed")
	}
}
