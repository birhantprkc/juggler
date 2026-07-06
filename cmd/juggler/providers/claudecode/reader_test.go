//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// TestStreamReader_DemuxesControlFramesAndForwardsContent is the core
// invariant of the continuous reader: control envelopes are routed to the
// control-protocol actor (and therefore never reach the turn consumer),
// while content lines are forwarded to s.content in arrival order.
func TestStreamReader_DemuxesControlFramesAndForwardsContent(t *testing.T) {
	// A control protocol whose stdin we can inspect for the response the
	// actor writes when it handles the mcp_message initialize.
	stdin := &bytes.Buffer{}
	cp := newControlProtocol(stdin)

	lines := make(chan string, 8)
	s := &activeSession{live: &liveCLI{
		control:    cp,
		lines:      lines,
		content:    make(chan string, 8),
		readerStop: make(chan struct{}),
		readerDone: make(chan struct{}),
	}}
	startStreamReader(s)
	t.Cleanup(func() {
		select {
		case <-s.live.readerStop:
		default:
			close(s.live.readerStop)
		}
		<-s.live.readerDone
	})

	// Build an mcp_message initialize control_request — handled synchronously
	// by the actor, which writes a control_response to stdin.
	mcpInit, _ := json.Marshal(JSONRPCMessage{JSONRPC: "2.0", ID: json.RawMessage(`1`), Method: "initialize"})
	ctrlReq, _ := json.Marshal(StreamMessage{
		Type:      "control_request",
		RequestID: "req-init",
		Request:   &ControlRequestBody{Subtype: "mcp_message", ServerName: mcpServerName, Message: mcpInit},
	})

	// Interleave content around the control frame; only the content must
	// reach s.content, and in order.
	lines <- `{"type":"system","subtype":"init","session_id":"uuid-r"}`
	lines <- string(ctrlReq)
	lines <- `{"type":"result","subtype":"success","result":"ok"}`

	want := []string{
		`{"type":"system","subtype":"init","session_id":"uuid-r"}`,
		`{"type":"result","subtype":"success","result":"ok"}`,
	}
	for i, w := range want {
		select {
		case got := <-s.live.content:
			if got != w {
				t.Fatalf("content[%d] = %q, want %q", i, got, w)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("timed out waiting for content line %d", i)
		}
	}

	// Receiving both content lines proves the reader processed the
	// interleaved control frame first (in stream order) — so its response is
	// already written. The control_request must NOT have leaked into content.
	if !strings.Contains(stdin.String(), `"request_id":"req-init"`) {
		t.Errorf("control_request was not routed to the actor; stdin=%q", stdin.String())
	}
	if !strings.Contains(stdin.String(), `"subtype":"success"`) {
		t.Errorf("expected a success control_response from the actor; stdin=%q", stdin.String())
	}
}

// TestStreamReader_StopClosesContent verifies teardown semantics: closing
// readerStop makes the reader exit and close s.content (so a turn consumer
// observes end-of-stream), and readerDone fires after content is closed.
func TestStreamReader_StopClosesContent(t *testing.T) {
	s := &activeSession{live: &liveCLI{
		control:    newControlProtocol(&bytes.Buffer{}),
		lines:      make(chan string, 1),
		content:    make(chan string, 1),
		readerStop: make(chan struct{}),
		readerDone: make(chan struct{}),
	}}
	startStreamReader(s)

	close(s.live.readerStop)
	select {
	case <-s.live.readerDone:
	case <-time.After(2 * time.Second):
		t.Fatal("reader did not exit after readerStop")
	}
	// content must be closed (readerDone closes strictly after content).
	if _, ok := <-s.live.content; ok {
		t.Fatal("expected s.content to be closed after reader exit")
	}
}
