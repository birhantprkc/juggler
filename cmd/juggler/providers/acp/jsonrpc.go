//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package acp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"

	"juggler/internal/jlog"
)

// errTransportClosed is returned by call/writeRaw once the agent's stdio has
// gone away (EOF, crash, or an explicit Close). Callers parked on a reply
// observe it instead of hanging forever — stdio has no transport timeout.
var errTransportClosed = errors.New("acp: transport closed")

// JSON-RPC error codes we emit (subset of the spec).
const (
	rpcCodeInvalidParams  = -32602
	rpcCodeMethodNotFound = -32601
)

// rpcError is a JSON-RPC 2.0 error object. It doubles as a Go error so a failed
// call can surface the agent's message verbatim.
type rpcError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func (e *rpcError) Error() string {
	return fmt.Sprintf("acp rpc error %d: %s", e.Code, e.Message)
}

// rpcMessage is the on-the-wire envelope for every direction. The presence of
// Method and ID discriminates the three shapes:
//
//	Method != "" && ID != nil  → request  (expects a response)
//	Method != "" && ID == nil  → notification (fire-and-forget)
//	Method == "" && ID != nil  → response (result or error) to our request
type rpcMessage struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

// rpcResult is delivered to a parked caller when its response arrives.
type rpcResult struct {
	result json.RawMessage
	err    *rpcError
}

// inboundHandler receives requests and notifications the agent sends to the
// client. Implemented by *conversation. handleRequest may block (a permission
// bridge that waits on the user), so the reader dispatches requests on their
// own goroutines; handleNotification must stay non-blocking (it runs inline on
// the reader goroutine to preserve session/update ordering).
type inboundHandler interface {
	handleRequest(id json.RawMessage, method string, params json.RawMessage)
	handleNotification(method string, params json.RawMessage)
}

// writeReq hands one framed line to the single writer goroutine and carries a
// buffered channel back for the write error.
type writeReq struct {
	data []byte
	done chan error
}

// lock is a one-token channel used as a mutex, per the project concurrency
// rule (channels/actors, not sync.Mutex — the same ownership-token shape as
// claudecode's `own`). Acquire blocks until the token is free; release returns
// it. A newLock starts unlocked (token present).
type lock chan struct{}

func newLock() lock {
	l := make(lock, 1)
	l <- struct{}{}
	return l
}

func (l lock) acquire() { <-l }
func (l lock) release() { l <- struct{}{} }

// transport is the JSON-RPC 2.0 dispatcher over one agent subprocess's stdio.
//
// Concurrency: a single writer goroutine owns stdin (the project concurrency
// rule — the ordering-sensitive path is channels, not a mutex). The pending
// map is a request/response correlation registry (register on the caller
// goroutine, resolve on the reader goroutine); it carries no ordering
// semantics, so a plain ownership-token `lock` serialises the two accesses.
type transport struct {
	w    io.WriteCloser
	r    io.Reader
	kill func() // non-blocking: close stdin + signal the process to die
	reap func() // blocking wait(); only ever called after the reader hits EOF

	writeCh chan writeReq
	nextID  int64

	plock   lock // guards pending
	pending map[string]chan rpcResult

	handler inboundHandler

	quit      chan struct{}
	closeOnce sync.Once
}

// newTransport wires a dispatcher to an agent's stdio. kill must be
// non-blocking (close stdin + kill the process); reap is the blocking
// cmd.Wait() and is invoked exactly once, by the reader goroutine, after all
// stdout reads have completed (so it never races an in-flight read). Both may
// be nil for in-memory (test) transports. Call start to launch the goroutines.
func newTransport(stdin io.WriteCloser, stdout io.Reader, kill, reap func()) *transport {
	return &transport{
		w:       stdin,
		r:       stdout,
		kill:    kill,
		reap:    reap,
		writeCh: make(chan writeReq),
		plock:   newLock(),
		pending: make(map[string]chan rpcResult),
		quit:    make(chan struct{}),
	}
}

// start binds the inbound handler and launches the reader and writer
// goroutines. The handler is set before the reader runs so no inbound frame
// races a nil handler.
func (t *transport) start(handler inboundHandler) {
	t.handler = handler
	go t.writeLoop()
	go t.readLoop()
}

// closed reports whether the transport has shut down (EOF/crash/Close).
func (t *transport) closed() bool {
	select {
	case <-t.quit:
		return true
	default:
		return false
	}
}

func (t *transport) writeLoop() {
	for {
		select {
		case wr := <-t.writeCh:
			_, err := t.w.Write(wr.data)
			wr.done <- err // buffered(1): never blocks
		case <-t.quit:
			return
		}
	}
}

// writeRaw frames v as one newline-delimited line and hands it to the writer
// goroutine, returning errTransportClosed if the transport is gone.
func (t *transport) writeRaw(v rpcMessage) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	data = append(data, '\n')
	done := make(chan error, 1)
	select {
	case t.writeCh <- writeReq{data: data, done: done}:
	case <-t.quit:
		return errTransportClosed
	}
	select {
	case werr := <-done:
		if werr != nil {
			// A write failure means stdin is gone (broken pipe / dead agent).
			// Tear down now so parked callers unblock immediately instead of
			// waiting for the reader to independently notice EOF.
			t.shutdown()
		}
		return werr
	case <-t.quit:
		return errTransportClosed
	}
}

// call sends a request and blocks until the matching response arrives, the
// context is cancelled, or the transport closes.
func (t *transport) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	id := atomic.AddInt64(&t.nextID, 1)
	idRaw := json.RawMessage(strconv.FormatInt(id, 10))
	key := idKey(idRaw)

	ch := make(chan rpcResult, 1)
	t.plock.acquire()
	t.pending[key] = ch
	t.plock.release()
	defer func() {
		t.plock.acquire()
		delete(t.pending, key)
		t.plock.release()
	}()

	praw, err := marshalParams(params)
	if err != nil {
		return nil, err
	}
	if err := t.writeRaw(rpcMessage{JSONRPC: "2.0", ID: idRaw, Method: method, Params: praw}); err != nil {
		return nil, err
	}

	select {
	case res := <-ch:
		if res.err != nil {
			return nil, res.err
		}
		return res.result, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-t.quit:
		return nil, errTransportClosed
	}
}

// notify sends a fire-and-forget notification (no id, no response).
func (t *transport) notify(method string, params any) error {
	praw, err := marshalParams(params)
	if err != nil {
		return err
	}
	return t.writeRaw(rpcMessage{JSONRPC: "2.0", Method: method, Params: praw})
}

// respond answers an inbound agent request with a success result.
func (t *transport) respond(id json.RawMessage, result any) error {
	praw, err := marshalParams(result)
	if err != nil {
		return err
	}
	return t.writeRaw(rpcMessage{JSONRPC: "2.0", ID: id, Result: praw})
}

// respondError answers an inbound agent request with a JSON-RPC error.
func (t *transport) respondError(id json.RawMessage, code int, message string) error {
	return t.writeRaw(rpcMessage{JSONRPC: "2.0", ID: id, Error: &rpcError{Code: code, Message: message}})
}

func (t *transport) readLoop() {
	sc := bufio.NewScanner(t.r)
	// Agent lines can be large (a whole tool_call_update with file content);
	// give the scanner room well beyond the 64 KiB default.
	sc.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)

	for sc.Scan() {
		line := sc.Bytes()
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		var msg rpcMessage
		if err := json.Unmarshal(line, &msg); err != nil {
			// A malformed line is the agent's bug, not a reason to tear down the
			// session — log and keep reading.
			jlog.Debug("[acp] dropping malformed line: %v", err)
			continue
		}
		switch {
		case msg.Method != "" && len(msg.ID) > 0:
			// Inbound request. May block (permission bridge) — dispatch off the
			// reader goroutine so session/update notifications keep flowing.
			go t.handler.handleRequest(msg.ID, msg.Method, msg.Params)
		case msg.Method != "":
			t.handler.handleNotification(msg.Method, msg.Params)
		case len(msg.ID) > 0:
			t.deliverResponse(msg)
		default:
			jlog.Debug("[acp] dropping unclassifiable message")
		}
	}

	// Scan returned: EOF or a read error. Either way the agent's stdout is
	// done, so it is now safe to reap the process. Initiate shutdown (unblocks
	// parked callers) then wait().
	t.shutdown()
	if t.reap != nil {
		t.reap()
	}
}

// idKey canonicalises a JSON-RPC id for the pending-map key. We only ever send
// integer ids; a conformant agent echoes them verbatim, but some agents quote
// the id in the response (`"5"` for a sent `5`). Trimming surrounding whitespace
// and quotes makes both forms correlate to the same waiting caller.
func idKey(raw json.RawMessage) string {
	return strings.Trim(strings.TrimSpace(string(raw)), `"`)
}

// deliverResponse routes a response to the caller parked on its id.
func (t *transport) deliverResponse(msg rpcMessage) {
	key := idKey(msg.ID)
	t.plock.acquire()
	ch := t.pending[key]
	t.plock.release()
	if ch == nil {
		jlog.Debug("[acp] response for unknown id %s", key)
		return
	}
	ch <- rpcResult{result: msg.Result, err: msg.Error} // buffered(1): never blocks
}

// shutdown initiates teardown: signal quit (unblocking every parked caller and
// the writer), then kill the subprocess. Idempotent. Does NOT wait() — that is
// the reader goroutine's job after its reads finish (see readLoop).
func (t *transport) shutdown() {
	t.closeOnce.Do(func() {
		close(t.quit)
		if t.kill != nil {
			t.kill()
		}
	})
}

// close is the external teardown entry point (Conversation.Close / crash
// recovery). It initiates shutdown; the reader goroutine reaps once stdout
// reaches EOF (which the kill triggers).
func (t *transport) close() {
	t.shutdown()
}

// marshalParams encodes call/response params. A nil value yields no params
// field; an already-encoded json.RawMessage passes through untouched.
func marshalParams(v any) (json.RawMessage, error) {
	if v == nil {
		return nil, nil
	}
	if raw, ok := v.(json.RawMessage); ok {
		return raw, nil
	}
	b, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	return b, nil
}
