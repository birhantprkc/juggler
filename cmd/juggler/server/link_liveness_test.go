//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"juggler/cmd/juggler/worker"

	"github.com/gorilla/websocket"
)

// Link liveness. Distinct from engine liveness: here the question is whether the
// CONNECTION still carries traffic, not whether a JS realm is running behind it.
//
// The failure these guard is a half-open TCP connection — a suspended laptop, a
// phone that left wifi, a NAT that dropped its mapping. Neither end gets an RST,
// so the server holds a socket nothing will ever read again and the page holds
// one nothing will ever write to again, both convinced they are connected, until
// the kernel's keepalive ladder gives up minutes later.

// linkBudget bounds how long these wait for the server to act. A test-local
// patience limit, not a product constant: the production windows are shortened
// through the seams in link_liveness.go so these run fast.
const linkBudget = 3 * time.Second

// stubClient is a RealtimeClient that records what it was sent and whether it was
// closed, with no transport underneath. It deliberately does NOT implement
// outboundIdler, so it always counts as idle — the beat decision is exercised
// separately through idleStubClient.
type stubClient struct {
	role   ClientRole
	sent   chan any
	closes chan struct{}
}

func newStubClient(role ClientRole) *stubClient {
	return &stubClient{role: role, sent: make(chan any, 16), closes: make(chan struct{}, 8)}
}

func (c *stubClient) Send(msg any) bool {
	c.sent <- msg
	return true
}
func (c *stubClient) SendRaw([]byte) bool    { return true }
func (c *stubClient) Close()                 { c.closes <- struct{}{} }
func (c *stubClient) ClientID() string       { return "stub-client" }
func (c *stubClient) ClientRole() ClientRole { return c.role }
func (c *stubClient) ClientInfo() ClientInfo { return ClientInfo{Origin: "local"} }
func (c *stubClient) ViewerID() string       { return "" }
func (c *stubClient) sentCount() int         { return len(c.sent) }
func (c *stubClient) closeCount() int        { return len(c.closes) }
func (c *stubClient) nextSent(t *testing.T) any {
	t.Helper()
	select {
	case msg := <-c.sent:
		return msg
	default:
		t.Fatal("nothing was sent")
		return nil
	}
}

// idleStubClient is a stubClient that reports a fixed outbound idle time, which
// is what the supervisor consults before beating.
type idleStubClient struct {
	*stubClient
	idle time.Duration
}

func (c *idleStubClient) IdleOutbound() time.Duration { return c.idle }

// TestLinkSupervisor_EvictsASilentViewer is the reproduction. A viewer that has
// said nothing at all — no beat, no worker message, nothing — is a viewer that
// may no longer exist, and holding its socket open serves nobody. Closing it is
// the whole treatment: a page that IS still there reconnects in under a second.
func TestLinkSupervisor_EvictsASilentViewer(t *testing.T) {
	s := newTestServerState(t)
	s.setViewerSilenceWindow(50 * time.Millisecond)
	client := newStubClient(ClientRoleViewer)
	link := newLinkSupervisor(s, client)

	link.tick()
	if client.closeCount() != 0 {
		t.Fatal("a viewer that has only just connected was closed")
	}

	time.Sleep(80 * time.Millisecond)
	link.tick()
	if client.closeCount() != 1 {
		t.Fatalf("a silent viewer must have its socket closed so it reconnects; closes=%d", client.closeCount())
	}

	// And it is condemned once, not once per tick: a wedged viewer costs one log
	// line and one close while its read loop unwinds.
	link.tick()
	link.tick()
	if client.closeCount() != 1 {
		t.Fatalf("eviction must be one-shot; closes=%d", client.closeCount())
	}
}

// TestLinkSupervisor_KeepsAViewerThatIsMerelyIdle is the other half of the
// contract. Whatever proves the link must be satisfied by a user who is reading
// rather than typing — nobody's session may be torn down for being quiet.
func TestLinkSupervisor_KeepsAViewerThatIsMerelyIdle(t *testing.T) {
	s := newTestServerState(t)
	s.setViewerSilenceWindow(200 * time.Millisecond)
	client := newStubClient(ClientRoleViewer)
	link := newLinkSupervisor(s, client)

	for i := 0; i < 6; i++ {
		time.Sleep(50 * time.Millisecond)
		link.noteInbound() // the viewer's beat, or any other traffic
		link.tick()
	}
	if client.closeCount() != 0 {
		t.Fatal("a viewer that keeps beating was dropped: liveness must be satisfied by " +
			"an idle-but-present client, not by user traffic")
	}
}

// TestLinkSupervisor_NeverEvictsTheEngine: a silent engine belongs to the engine
// supervisor, where eviction is the FIRST step of an escalation that ends in
// reloading the WebView hosting it (engine_liveness.go). Closing it from here
// would start that escalation from the wrong place, and a viewer's silence has no
// such second act to trigger.
func TestLinkSupervisor_NeverEvictsTheEngine(t *testing.T) {
	s := newTestServerState(t)
	s.setViewerSilenceWindow(10 * time.Millisecond)
	client := newStubClient(ClientRoleEngine)
	link := newLinkSupervisor(s, client)

	time.Sleep(30 * time.Millisecond)
	link.tick()

	if client.closeCount() != 0 {
		t.Fatal("the engine's link must be left to the engine supervisor, which owns the " +
			"escalation past eviction")
	}
}

// TestLinkSupervisor_BeatsOnlyOnAQuietLink pins the cost of the beat: none,
// whenever the link is doing anything else. A streaming turn writes constantly,
// and adding a beat to that would be pure overhead on the one path that cannot
// afford it.
func TestLinkSupervisor_BeatsOnlyOnAQuietLink(t *testing.T) {
	s := newTestServerState(t)
	s.setServerBeatInterval(time.Second)

	busy := &idleStubClient{stubClient: newStubClient(ClientRoleViewer), idle: 10 * time.Millisecond}
	newLinkSupervisor(s, busy).tick()
	if busy.sentCount() != 0 {
		t.Fatalf("a link with traffic on it needs no beat; sent=%d", busy.sentCount())
	}

	quiet := &idleStubClient{stubClient: newStubClient(ClientRoleViewer), idle: 5 * time.Second}
	newLinkSupervisor(s, quiet).tick()
	if quiet.sentCount() != 1 {
		t.Fatalf("a quiet link must be given something to measure itself by; sent=%d", quiet.sentCount())
	}
	msg, ok := quiet.nextSent(t).(map[string]string)
	if !ok || msg["type"] != "heartbeat" {
		t.Fatalf("the beat must be the heartbeat message the client watches for; got %#v", quiet.nextSent(t))
	}
}

// TestLinkCheckIntervalTracksTheBeat pins the relationship the client's stall
// threshold is chosen against: the server examines a link often enough that a
// beat is never more than one and a third intervals late.
func TestLinkCheckIntervalTracksTheBeat(t *testing.T) {
	s := newTestServerState(t)
	if got, want := s.beatInterval(), serverBeatInterval; got != want {
		t.Fatalf("beatInterval() = %v, want the production %v", got, want)
	}
	if got := s.linkCheckInterval(); got > serverBeatInterval/2 {
		t.Fatalf("linkCheckInterval() = %v: too coarse to keep a %v beat on time", got, serverBeatInterval)
	}
	if viewerSilenceWindow <= serverBeatInterval*3 {
		t.Fatalf("viewerSilenceWindow (%v) must cover several missed viewer beats of %v",
			viewerSilenceWindow, serverBeatInterval)
	}
}

// newViewerSocketServer stands up the production WebSocket handler with just
// enough Server state for a viewer upgrade to complete. testMode waives the
// per-instance token, which is a separate concern from liveness.
func newViewerSocketServer(t *testing.T) (*Server, *httptest.Server) {
	t.Helper()
	s := newTestServerState(t)
	s.workerManager = worker.NewManager()
	s.upgrader = websocket.Upgrader{}
	s.testMode = true
	ts := httptest.NewServer(http.HandlerFunc(s.handleWebSocket))
	t.Cleanup(ts.Close)
	return s, ts
}

// dialViewer opens a real WebSocket as a viewer.
func dialViewer(t *testing.T, ts *httptest.Server) *websocket.Conn {
	t.Helper()
	url := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws?role=viewer"
	conn, resp, err := websocket.DefaultDialer.Dial(url, nil)
	if resp != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		t.Fatalf("viewer WS dial failed: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

// TestViewerSocket_ServerBeatsOnAnIdleLink: the client's stall watchdog can only
// work if silence means something. On an idle connection the server pushes
// nothing for as long as the user reads, so the beat is the only thing that
// distinguishes a quiet link from a dead one.
func TestViewerSocket_ServerBeatsOnAnIdleLink(t *testing.T) {
	s, ts := newViewerSocketServer(t)
	s.setServerBeatInterval(90 * time.Millisecond)
	conn := dialViewer(t, ts)

	_ = conn.SetReadDeadline(time.Now().Add(linkBudget))
	for {
		_, msgBytes, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("no heartbeat reached an idle viewer within %v: %v", linkBudget, err)
		}
		var generic GenericWSMessage
		if err := json.Unmarshal(msgBytes, &generic); err != nil {
			continue
		}
		if generic.Type == "heartbeat" {
			return
		}
	}
}

// TestViewerSocket_SilentViewerIsClosed drives the eviction over a real socket,
// through the client loop's own ticker: a viewer that never speaks has its
// connection closed rather than held until TCP notices.
func TestViewerSocket_SilentViewerIsClosed(t *testing.T) {
	s, ts := newViewerSocketServer(t)
	// A fast tick (derived from the beat) and a short patience, so eviction
	// happens in test time rather than production time.
	s.setServerBeatInterval(60 * time.Millisecond)
	s.setViewerSilenceWindow(150 * time.Millisecond)
	conn := dialViewer(t, ts)

	_ = conn.SetReadDeadline(time.Now().Add(linkBudget))
	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			if netErr, ok := err.(interface{ Timeout() bool }); ok && netErr.Timeout() {
				t.Fatalf("a viewer that said nothing for %v kept its socket: the server "+
					"would hold it until the kernel's keepalive ladder expires, minutes later",
					linkBudget)
			}
			return // the server closed it, which is the point
		}
	}
}

// TestViewerSocket_BeatingViewerKeepsItsSocket is the converse over the same real
// socket: a viewer doing nothing but keeping its half of the protocol must be
// left alone for as long as it likes.
func TestViewerSocket_BeatingViewerKeepsItsSocket(t *testing.T) {
	s, ts := newViewerSocketServer(t)
	s.setServerBeatInterval(60 * time.Millisecond)
	s.setViewerSilenceWindow(150 * time.Millisecond)
	conn := dialViewer(t, ts)

	stop := make(chan struct{})
	defer close(stop)
	go func() {
		tick := time.NewTicker(30 * time.Millisecond)
		defer tick.Stop()
		for {
			select {
			case <-stop:
				return
			case <-tick.C:
				if err := conn.WriteJSON(map[string]string{"type": "viewer-heartbeat"}); err != nil {
					return
				}
			}
		}
	}()

	deadline := time.Now().Add(600 * time.Millisecond) // four eviction windows
	_ = conn.SetReadDeadline(deadline)
	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			if netErr, ok := err.(interface{ Timeout() bool }); ok && netErr.Timeout() {
				return // read deadline reached with the socket still open: correct
			}
			t.Fatalf("a beating viewer was dropped anyway: %v", err)
		}
		if time.Now().After(deadline) {
			return
		}
	}
}
