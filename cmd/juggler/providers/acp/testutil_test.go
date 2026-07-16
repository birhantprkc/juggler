//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package acp

import (
	"bufio"
	"encoding/json"
	"io"
	"sync"
	"testing"
	"time"
)

// fakeAgentPipes wires an in-memory JSON-RPC stdio pair: the client (transport)
// writes to the agent's stdin and reads the agent's stdout, and the test plays
// the agent by reading requests and writing responses/notifications.
//
// The client's stdin is drained continuously by a background goroutine into a
// buffered channel, so a client write never blocks waiting for the test to
// call readMsg. This matters because io.Pipe is synchronous (every write
// blocks until a matching read) whereas a real agent's stdin is a buffered OS
// pipe: without the drain, a synchronous client-side write (e.g. Cancel's
// session/cancel, issued on the caller goroutine) would deadlock against a
// test that only reads afterwards.
type fakeAgentPipes struct {
	// client-facing ends handed to newTransport.
	clientStdin  io.WriteCloser // transport writes here (agent's stdin)
	clientStdout io.Reader      // transport reads here (agent's stdout)

	// agentOut is where the test writes agent output (the client's stdout).
	agentOut io.WriteCloser
	// inbox receives every line the client sent, already parsed. Closed when
	// the client's stdin reaches EOF.
	inbox chan rpcMessage

	// underlying pipe ends, for teardown.
	stdinR    *io.PipeReader
	stdinW    *io.PipeWriter
	stdoutR   *io.PipeReader
	stdoutW   *io.PipeWriter
	closeOnce sync.Once
}

// newFakeAgent builds the pipe pair and starts draining the client's stdin.
func newFakeAgent() *fakeAgentPipes {
	stdinR, stdinW := io.Pipe()   // client writes stdinW; agent reads stdinR
	stdoutR, stdoutW := io.Pipe() // agent writes stdoutW; client reads stdoutR

	f := &fakeAgentPipes{
		clientStdin:  stdinW,
		clientStdout: stdoutR,
		agentOut:     stdoutW,
		inbox:        make(chan rpcMessage, 256),
		stdinR:       stdinR,
		stdinW:       stdinW,
		stdoutR:      stdoutR,
		stdoutW:      stdoutW,
	}
	go f.drainStdin()
	return f
}

// drainStdin reads and parses every line the client writes, pushing it onto
// inbox so writes never block on the test's read cadence. Malformed lines are
// skipped (the transport-level malformed-line test writes agent→client, not
// here, so this only ever sees well-formed client output).
func (f *fakeAgentPipes) drainStdin() {
	sc := bufio.NewScanner(f.stdinR)
	sc.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
	for sc.Scan() {
		var m rpcMessage
		if err := json.Unmarshal(sc.Bytes(), &m); err != nil {
			continue
		}
		f.inbox <- m
	}
	close(f.inbox)
}

// readMsg blocks until the client sends a line, returning the parsed envelope.
// Fails the test on EOF (channel closed) or a 2s timeout.
func (f *fakeAgentPipes) readMsg(t *testing.T) rpcMessage {
	t.Helper()
	select {
	case m, ok := <-f.inbox:
		if !ok {
			t.Fatalf("fake agent: no message from client (EOF)")
		}
		return m
	case <-time.After(2 * time.Second):
		t.Fatalf("fake agent: timed out waiting for a message from client")
		return rpcMessage{}
	}
}

func (f *fakeAgentPipes) writeLine(t *testing.T, v rpcMessage) {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("fake agent: marshal: %v", err)
	}
	b = append(b, '\n')
	if _, err := f.agentOut.Write(b); err != nil {
		t.Fatalf("fake agent: write: %v", err)
	}
}

func (f *fakeAgentPipes) writeRawLine(t *testing.T, line string) {
	t.Helper()
	if _, err := f.agentOut.Write([]byte(line + "\n")); err != nil {
		t.Fatalf("fake agent: write raw: %v", err)
	}
}

func (f *fakeAgentPipes) writeResult(t *testing.T, id json.RawMessage, result any) {
	t.Helper()
	praw, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("fake agent: marshal result: %v", err)
	}
	f.writeLine(t, rpcMessage{JSONRPC: "2.0", ID: id, Result: praw})
}

func (f *fakeAgentPipes) writeNotification(t *testing.T, method string, params any) {
	t.Helper()
	praw, err := json.Marshal(params)
	if err != nil {
		t.Fatalf("fake agent: marshal params: %v", err)
	}
	f.writeLine(t, rpcMessage{JSONRPC: "2.0", Method: method, Params: praw})
}

// writeRequest sends an agent→client request (with id) the client must answer.
func (f *fakeAgentPipes) writeRequest(t *testing.T, id json.RawMessage, method string, params any) {
	t.Helper()
	praw, err := json.Marshal(params)
	if err != nil {
		t.Fatalf("fake agent: marshal params: %v", err)
	}
	f.writeLine(t, rpcMessage{JSONRPC: "2.0", ID: id, Method: method, Params: praw})
}

// closeStdout simulates the agent exiting (EOF on the client's read side).
func (f *fakeAgentPipes) closeStdout() { _ = f.stdoutW.Close() }

// stop tears down all pipe ends, unblocking any parked goroutines.
func (f *fakeAgentPipes) stop() {
	f.closeOnce.Do(func() {
		_ = f.stdoutW.Close()
		_ = f.stdoutR.Close()
		_ = f.stdinR.Close()
		_ = f.stdinW.Close()
	})
}

// recordingHandler is a minimal inboundHandler for transport-level tests.
type recordingHandler struct {
	guard lock
	notes []recordedNote
}

func newRecordingHandler() *recordingHandler { return &recordingHandler{guard: newLock()} }

type recordedNote struct {
	method string
	params json.RawMessage
}

func (h *recordingHandler) handleNotification(method string, params json.RawMessage) {
	h.guard.acquire()
	h.notes = append(h.notes, recordedNote{method, append(json.RawMessage(nil), params...)})
	h.guard.release()
}

func (h *recordingHandler) handleRequest(id json.RawMessage, method string, params json.RawMessage) {
	// Transport tests that need request handling override behaviour by not using
	// this handler; the default just drops.
}

func (h *recordingHandler) notifications() []recordedNote {
	h.guard.acquire()
	defer h.guard.release()
	out := make([]recordedNote, len(h.notes))
	copy(out, h.notes)
	return out
}

// rawID builds a json.RawMessage id from an integer literal.
func rawID(n int) json.RawMessage { return json.RawMessage([]byte(itoa(n))) }

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
