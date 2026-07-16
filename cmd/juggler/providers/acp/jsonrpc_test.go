//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package acp

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"
)

// startTransport wires a transport to a fresh fake agent and returns both.
func startTransport(t *testing.T, h inboundHandler) (*transport, *fakeAgentPipes) {
	t.Helper()
	fa := newFakeAgent()
	tr := newTransport(fa.clientStdin, fa.clientStdout, nil, nil)
	tr.start(h)
	t.Cleanup(func() {
		tr.close()
		fa.stop()
	})
	return tr, fa
}

func TestTransportCallResponse(t *testing.T) {
	tr, fa := startTransport(t, newRecordingHandler())

	type res struct {
		raw json.RawMessage
		err error
	}
	resCh := make(chan res, 1)
	go func() {
		raw, err := tr.call(context.Background(), "ping", map[string]string{"a": "b"})
		resCh <- res{raw, err}
	}()

	req := fa.readMsg(t)
	if req.Method != "ping" {
		t.Fatalf("method = %q, want ping", req.Method)
	}
	if len(req.ID) == 0 {
		t.Fatalf("request carried no id")
	}
	fa.writeResult(t, req.ID, map[string]bool{"ok": true})

	select {
	case r := <-resCh:
		if r.err != nil {
			t.Fatalf("call error: %v", r.err)
		}
		var got struct {
			OK bool `json:"ok"`
		}
		if err := json.Unmarshal(r.raw, &got); err != nil {
			t.Fatalf("decode result: %v", err)
		}
		if !got.OK {
			t.Fatalf("result ok = false, want true")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("call did not return")
	}
}

func TestTransportCallRPCError(t *testing.T) {
	tr, fa := startTransport(t, newRecordingHandler())

	errCh := make(chan error, 1)
	go func() {
		_, err := tr.call(context.Background(), "boom", nil)
		errCh <- err
	}()

	req := fa.readMsg(t)
	fa.writeLine(t, rpcMessage{JSONRPC: "2.0", ID: req.ID, Error: &rpcError{Code: -32000, Message: "nope"}})

	select {
	case err := <-errCh:
		var re *rpcError
		if !errors.As(err, &re) {
			t.Fatalf("error = %v, want *rpcError", err)
		}
		if re.Code != -32000 {
			t.Fatalf("code = %d, want -32000", re.Code)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("call did not return")
	}
}

func TestTransportNotificationRouting(t *testing.T) {
	h := newRecordingHandler()
	_, fa := startTransport(t, h)

	fa.writeNotification(t, "session/update", map[string]string{"hello": "world"})

	// Poll briefly for the async delivery.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if notes := h.notifications(); len(notes) == 1 && notes[0].method == "session/update" {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("notification not routed: %+v", h.notifications())
}

func TestTransportMalformedLineIsSkipped(t *testing.T) {
	tr, fa := startTransport(t, newRecordingHandler())

	resCh := make(chan error, 1)
	go func() {
		_, err := tr.call(context.Background(), "ping", nil)
		resCh <- err
	}()

	req := fa.readMsg(t)
	// A garbage line must not tear down the session; the real response after it
	// still lands.
	fa.writeRawLine(t, "this is not json {{{")
	fa.writeResult(t, req.ID, map[string]bool{"ok": true})

	select {
	case err := <-resCh:
		if err != nil {
			t.Fatalf("call failed after malformed line: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("call did not return after malformed line")
	}
}

func TestTransportEOFUnblocksCall(t *testing.T) {
	tr, fa := startTransport(t, newRecordingHandler())

	errCh := make(chan error, 1)
	go func() {
		_, err := tr.call(context.Background(), "ping", nil)
		errCh <- err
	}()

	_ = fa.readMsg(t) // consume the request
	fa.closeStdout()  // agent "crashes" without responding

	select {
	case err := <-errCh:
		if !errors.Is(err, errTransportClosed) {
			t.Fatalf("err = %v, want errTransportClosed", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("call did not unblock on EOF")
	}
	if !tr.closed() {
		t.Fatal("transport should report closed after EOF")
	}
}

func TestTransportContextCancelUnblocksCall(t *testing.T) {
	tr, fa := startTransport(t, newRecordingHandler())

	ctx, cancel := context.WithCancel(context.Background())
	errCh := make(chan error, 1)
	go func() {
		_, err := tr.call(ctx, "ping", nil)
		errCh <- err
	}()

	_ = fa.readMsg(t)
	cancel()

	select {
	case err := <-errCh:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("err = %v, want context.Canceled", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("call did not unblock on ctx cancel")
	}
}

func TestHandshake(t *testing.T) {
	conv := &conversation{client: &Client{workingDir: "/tmp/work"}, approver: defaultApprover{}, initLock: newLock()}
	tr, fa := startTransport(t, conv)

	sidCh := make(chan string, 1)
	errCh := make(chan error, 1)
	go func() {
		sid, err := conv.handshake(context.Background(), tr)
		sidCh <- sid
		errCh <- err
	}()

	// initialize
	initMsg := fa.readMsg(t)
	if initMsg.Method != "initialize" {
		t.Fatalf("first call = %q, want initialize", initMsg.Method)
	}
	var ip initializeParams
	if err := json.Unmarshal(initMsg.Params, &ip); err != nil {
		t.Fatalf("decode initialize params: %v", err)
	}
	if ip.ClientCapabilities.FS.ReadTextFile || ip.ClientCapabilities.Terminal {
		t.Fatalf("MVP must decline fs/terminal, got %+v", ip.ClientCapabilities)
	}
	fa.writeResult(t, initMsg.ID, initializeResult{ProtocolVersion: acpProtocolVersion})

	// session/new
	newMsg := fa.readMsg(t)
	if newMsg.Method != "session/new" {
		t.Fatalf("second call = %q, want session/new", newMsg.Method)
	}
	var np newSessionParams
	if err := json.Unmarshal(newMsg.Params, &np); err != nil {
		t.Fatalf("decode session/new params: %v", err)
	}
	if np.Cwd != "/tmp/work" {
		t.Fatalf("cwd = %q, want /tmp/work", np.Cwd)
	}
	fa.writeResult(t, newMsg.ID, newSessionResult{SessionID: "sess-42"})

	if err := <-errCh; err != nil {
		t.Fatalf("handshake error: %v", err)
	}
	if sid := <-sidCh; sid != "sess-42" {
		t.Fatalf("sessionID = %q, want sess-42", sid)
	}
}
