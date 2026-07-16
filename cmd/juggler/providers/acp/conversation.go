//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package acp

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync/atomic"
	"time"

	provider "juggler/cmd/juggler/providers/registry"
	"juggler/internal/jlog"
)

// conversation is the provider.Conversation for one ACP dialogue. It owns the
// agent subprocess + JSON-RPC transport (lazily spawned on first Submit) and
// the agent's session id, and implements inboundHandler so the transport can
// route the agent's session/update notifications and session/request_permission
// calls back into the active turn.
//
// Concurrency: Submit/Subscribe/CacheTTL are called serially by the worker
// manager, but Cancel/Close may race an in-flight Submit (they exist to
// interrupt one). The live session is therefore held in an atomic pointer, and
// the current turn in another, so the racing callers never touch a mutex on the
// hot path.
type conversation struct {
	client   *Client
	convID   string
	approver Approver

	initLock lock                    // serialises (re)spawn; never held on the reader path
	sess     atomic.Pointer[session] // live transport + sessionId, nil until first Submit

	turn atomic.Pointer[turnState] // the in-flight turn, nil between turns
}

// session bundles the live transport with its negotiated ACP session id so both
// swap atomically on (re)spawn and teardown.
type session struct {
	rpc       *transport
	sessionID string
}

// turnState carries the callback and accumulators for one in-flight Submit.
// session/update notifications (arriving on the reader goroutine) feed it.
type turnState struct {
	cb provider.StructuredStreamCallback

	guard  lock
	output strings.Builder // agent text/thinking, for the output-token estimate
	cbErr  error           // first error the callback returned, if any
}

func (ts *turnState) appendOutput(s string) {
	ts.guard.acquire()
	ts.output.WriteString(s)
	ts.guard.release()
}

func (ts *turnState) outputString() string {
	ts.guard.acquire()
	defer ts.guard.release()
	return ts.output.String()
}

func (ts *turnState) setErr(err error) {
	ts.guard.acquire()
	if ts.cbErr == nil {
		ts.cbErr = err
	}
	ts.guard.release()
}

func (ts *turnState) err() error {
	ts.guard.acquire()
	defer ts.guard.release()
	return ts.cbErr
}

// Submit drives one ACP turn: ensure a live session, send session/prompt, and
// block until the agent reports a stop reason — session/update notifications
// stream to the callback meanwhile.
func (c *conversation) Submit(ctx context.Context, req provider.MessageRequest, callback provider.StructuredStreamCallback) (*provider.StreamResult, error) {
	promptText := latestUserText(req.Messages)
	if strings.TrimSpace(promptText) == "" {
		// Nothing to send. ACP agents own their tool loop, so there are no
		// tool-result continuation turns to forward; an empty prompt would only
		// confuse the agent (or make it re-run the prior turn). Fail before
		// spawning rather than send a blank turn.
		return nil, errors.New("acp: no user message to send")
	}

	sess, err := c.ensureSession(ctx)
	if err != nil {
		return nil, err
	}

	ts := &turnState{cb: callback, guard: newLock()}
	c.turn.Store(ts)
	defer c.turn.Store(nil)

	raw, err := sess.rpc.call(ctx, "session/prompt", promptParams{
		SessionID: sess.sessionID,
		Prompt:    []contentBlock{{Type: "text", Text: promptText}},
	})
	if err != nil {
		// A dead transport means the agent crashed / EOF'd — drop the session so
		// the next Submit re-spawns cleanly.
		if errors.Is(err, errTransportClosed) {
			c.dropSession(sess)
		}
		return nil, err
	}
	if cbErr := ts.err(); cbErr != nil {
		return nil, cbErr
	}

	var pr promptResult
	if err := json.Unmarshal(raw, &pr); err != nil {
		jlog.Debug("[acp] session/prompt: decode result: %v", err)
	}

	out := ts.outputString()
	return &provider.StreamResult{
		StopReason:   pr.StopReason,
		InputTokens:  provider.EstimateTokens(promptText),
		OutputTokens: provider.EstimateTokens(out),
	}, nil
}

// Subscribe is a no-op: ACP agents are request/response and never emit a turn
// without a preceding session/prompt.
func (c *conversation) Subscribe(sink provider.TurnSink) {}

// CacheTTL is 0: ACP exposes no time-bounded prompt-cache anchor.
func (c *conversation) CacheTTL() time.Duration { return 0 }

// Cancel interrupts the in-flight turn while PRESERVING resumability: it sends
// session/cancel (a cooperative interrupt) and leaves the subprocess alive so
// the next turn continues the same session. The agent ends the current turn
// with stopReason "cancelled", which unblocks the parked session/prompt call.
func (c *conversation) Cancel() {
	sess := c.sess.Load()
	if sess == nil || sess.sessionID == "" {
		return
	}
	if err := sess.rpc.notify("session/cancel", cancelParams{SessionID: sess.sessionID}); err != nil {
		jlog.Debug("[acp] session/cancel: %v", err)
	}
}

// Close releases the subprocess and transport. Called when the conversation is
// permanently deleted; safe to call multiple times.
func (c *conversation) Close() error {
	c.initLock.acquire()
	sess := c.sess.Swap(nil)
	c.initLock.release()
	if sess == nil {
		return nil
	}
	if sess.sessionID != "" {
		_ = sess.rpc.notify("session/cancel", cancelParams{SessionID: sess.sessionID})
	}
	sess.rpc.close()
	return nil
}

// ensureSession returns the live session, spawning the agent and running the
// initialize + session/new handshake on first use (or after a crash dropped the
// prior one). Double-checked under initLock so concurrent first-turns spawn once.
func (c *conversation) ensureSession(ctx context.Context) (*session, error) {
	if s := c.sess.Load(); s != nil && !s.rpc.closed() {
		return s, nil
	}
	c.initLock.acquire()
	defer c.initLock.release()
	if s := c.sess.Load(); s != nil && !s.rpc.closed() {
		return s, nil
	}

	agent, err := resolveAgent(c.client.workingDir, c.client.model)
	if err != nil {
		return nil, err
	}
	proc, err := spawnAgent(ctx, c.client.workingDir, agent)
	if err != nil {
		return nil, err
	}
	t := newTransport(proc.stdin, proc.stdout, proc.kill, proc.reap)
	t.start(c)

	sid, err := c.handshake(ctx, t)
	if err != nil {
		t.close()
		return nil, err
	}
	s := &session{rpc: t, sessionID: sid}
	c.sess.Store(s)
	return s, nil
}

// dropSession tears down and clears the given session if it is still current,
// so the next Submit re-spawns. Used on crash recovery.
func (c *conversation) dropSession(s *session) {
	if c.sess.CompareAndSwap(s, nil) {
		s.rpc.close()
	}
}

// --- inboundHandler ---------------------------------------------------------

// handleNotification routes agent notifications. Runs inline on the reader
// goroutine, so it must stay non-blocking (it must never take initLock — the
// handshake holds it while parked on this very reader delivering its response).
func (c *conversation) handleNotification(method string, params json.RawMessage) {
	if method != "session/update" {
		return
	}
	var p sessionUpdateParams
	if err := json.Unmarshal(params, &p); err != nil {
		jlog.Debug("[acp] session/update: decode: %v", err)
		return
	}
	ts := c.turn.Load()
	if ts == nil {
		// An update with no turn in flight: the agent is chattier than the spec
		// implies, or a late straggler after a cancel. Nothing to attribute it to.
		return
	}
	chunk, ok := toStreamChunk(p.Update)
	if !ok {
		return
	}
	if isOutputText(chunk.Type) {
		ts.appendOutput(chunk.Content)
	}
	if _, err := ts.cb(chunk); err != nil {
		ts.setErr(err)
	}
}

// handleRequest routes agent→client requests. Runs on its own goroutine (the
// reader dispatches it that way) so a blocking permission bridge can't stall
// the session/update stream.
func (c *conversation) handleRequest(id json.RawMessage, method string, params json.RawMessage) {
	sess := c.sess.Load()
	if sess == nil {
		// No live transport to answer on — can only happen during a torn-down
		// window; dropping is safe (the agent is going away too).
		return
	}
	switch method {
	case "session/request_permission":
		c.handlePermission(sess, id, params)
	default:
		// fs/read_text_file, fs/write_text_file, terminal/* — declined in the
		// MVP (their capabilities were not advertised in initialize). Answer with
		// method-not-found so the agent falls back to its own I/O.
		if err := sess.rpc.respondError(id, rpcCodeMethodNotFound, "method not supported (MVP): "+method); err != nil {
			jlog.Debug("[acp] respondError %s: %v", method, err)
		}
	}
}

func (c *conversation) handlePermission(sess *session, id json.RawMessage, params json.RawMessage) {
	var p requestPermissionParams
	if err := json.Unmarshal(params, &p); err != nil {
		_ = sess.rpc.respondError(id, rpcCodeInvalidParams, "invalid session/request_permission params")
		return
	}
	outcome := c.approver.Approve(PermissionRequest{ToolCall: p.ToolCall, Options: p.Options})
	var resp permissionResponse
	if outcome.Selected {
		resp = permissionResponse{Outcome: permissionOutcomeWire{Outcome: "selected", OptionID: outcome.OptionID}}
	} else {
		resp = permissionResponse{Outcome: permissionOutcomeWire{Outcome: "cancelled"}}
	}
	if err := sess.rpc.respond(id, resp); err != nil {
		jlog.Debug("[acp] session/request_permission respond: %v", err)
	}
}

// latestUserText returns the newest user-role message's content. The agent
// keeps its own session across prompts, so each turn sends only the new user
// message (like a warm delta) rather than the whole history.
func latestUserText(msgs []provider.Message) string {
	for i := len(msgs) - 1; i >= 0; i-- {
		if provider.MessageTypeToRole(msgs[i].Type) == "user" && strings.TrimSpace(msgs[i].Content) != "" {
			return msgs[i].Content
		}
	}
	return ""
}
