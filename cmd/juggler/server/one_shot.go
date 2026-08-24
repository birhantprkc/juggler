//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"sync/atomic"
	"time"

	"juggler/internal/jlog"
)

// One unattended run, start to finish: the server asks the engine to create a
// conversation, configure it, send one prompt and report what happened.
//
// It is addressed to the engine because only the engine can do it. A
// conversation is seeded by the JS model — the system prompt, the strategy, the
// permission rules and the auto items are all written into the Yjs document by
// Session.createConversation and the worker manager behind it — so a caller that
// sends `init` and a message over a raw socket gets a conversation with no
// system prompt and the default strategy, which runs, looks healthy, and answers
// nothing it was asked. The engine already holds the loaded module graph, the
// initialised registries and the token, so the whole request is one message to a
// realm that can carry it out.
//
// The reply comes back over the same socket as a `one-shot-result`, correlated
// by request id (see oneShotRoundTrip). The wall clock belongs to the caller,
// not to this file and not to the engine: a realm wedged badly enough to lose
// the request is exactly the realm that cannot time itself out.

// Statuses a OneShotResult can report. Anything else the engine sends is
// treated as a failure, so a status added on one side and not the other cannot
// be mistaken for success.
const (
	// OneShotCompleted: the turn ran to its end and nothing is waiting.
	OneShotCompleted = "completed"
	// OneShotParked: the turn stopped on a tool that wants a human. Unattended,
	// that is a hang with a name on it rather than a result.
	OneShotParked = "parked"
	// OneShotFailed: the turn errored, or never started.
	OneShotFailed = "failed"
)

// OneShotRequest is what the engine is asked to run.
type OneShotRequest struct {
	// Prompt is the single user message the conversation is sent.
	Prompt string `json:"prompt"`
	// StrategyID is the strategy the conversation runs under. Unattended runs
	// want `yolo`; the field exists so that choice belongs to the caller.
	StrategyID string `json:"strategyId"`
	// Name is the conversation's name, and therefore its directory name.
	Name string `json:"name"`
	// Timeout is how long the caller will wait. It is passed on so the engine
	// can stop watching a turn the caller has stopped waiting for, and the
	// engine deliberately allows itself longer: the caller must be the one that
	// reports, since it is the only side that can still report at all when the
	// engine's realm is the thing that has gone wrong.
	Timeout time.Duration `json:"-"`
}

// OneShotResult is what the engine reports back.
//
// Field names avoid the pair (`error`, `message`): the client's own inbound
// router reads a message carrying both as a streaming error regardless of its
// type (see websocket.js), and a result that gets re-routed is a run that never
// answers.
type OneShotResult struct {
	RequestID string `json:"requestId"`
	// Status is one of the OneShot* constants above.
	Status string `json:"status"`
	// ConversationID identifies the conversation in the session. It is what a
	// caller resolves the conversation's directory from, and therefore its
	// transaction blobs — the only record of the system prompt and tool list
	// that actually went on the wire.
	ConversationID string `json:"conversationId"`
	// Turns is how many turns completed, which is 0 for a prompt that was
	// dropped before it ever reached the model.
	Turns int `json:"turns"`
	// FinalText is the last assistant message.
	FinalText string `json:"finalText"`
	// ParkedTool names the tool waiting for a human, when Status is parked.
	ParkedTool string `json:"parkedTool"`
	// ErrorText carries the failure in the engine's own words. Never dropped in
	// favour of a tidier summary: it is the only account of what went wrong.
	ErrorText string `json:"errorText"`
}

// oneShotRun is one request in flight: the id its answer must carry, and the
// one-deep channel that answer lands on. Immutable once published, so the
// round-trip's whole state is the presence or absence of one of these.
type oneShotRun struct {
	id string
	ch chan OneShotResult
}

// oneShotRoundTrip is the server's end of one run-one-shot request/reply pair.
//
// It holds the same rules the worker's replySlot holds, for the same reason: the
// answer must be correlated to the request that is actually in flight, taken
// exactly once, and refused otherwise. What differs is who it belongs to. A
// worker's slots are per-conversation and touched only from that worker's single
// goroutine; this one has no conversation yet — asking for one IS the request —
// and it is armed on the caller's goroutine while answers arrive on the engine
// client's read loop. So arming and answering are each a single compare-and-swap
// on the run in flight, and whichever goroutine wins the swap is the one that
// acts.
//
// One at a time is not a simplification to revisit: a run-one-shot is a whole
// process's reason for existing, and a second concurrent one would be a second
// answer for a caller that has already exited.
type oneShotRoundTrip struct {
	inFlight atomic.Pointer[oneShotRun]
}

// arm opens the round-trip for the answer to requestID.
func (r *oneShotRoundTrip) arm(requestID string) (chan OneShotResult, error) {
	run := &oneShotRun{id: requestID, ch: make(chan OneShotResult, 1)}
	if !r.inFlight.CompareAndSwap(nil, run) {
		existing := ""
		if current := r.inFlight.Load(); current != nil {
			existing = current.id
		}
		return nil, fmt.Errorf("a run is already in flight (request %s)", existing)
	}
	return run.ch, nil
}

// disarm closes the round-trip, so a late answer is dropped rather than left for
// whatever asks next.
func (r *oneShotRoundTrip) disarm() { r.inFlight.Store(nil) }

// deliver offers an inbound result, which is taken only if it answers the
// request in flight and that request has not been answered already. A result
// carrying no id cannot be attributed to a request and is refused rather than
// guessed at.
//
// The round-trip is taken before the answer is handed over, so the duplicates
// behind this one find nothing armed and are refused by the same rule as
// everything else — and only the goroutine that won that swap can send, which
// is what keeps the one-deep channel from ever blocking here.
func (r *oneShotRoundTrip) deliver(res OneShotResult) {
	run := r.inFlight.Load()
	if run == nil || res.RequestID != run.id {
		return
	}
	if !r.inFlight.CompareAndSwap(run, nil) {
		return
	}
	run.ch <- res
}

// StartOneShot asks the engine to run one prompt to completion and returns the
// channel its single result arrives on. The caller owns the deadline.
//
// It refuses unless the engine's realm has proved itself alive within the
// liveness window: an open socket is answered by the network process and says
// nothing about whether anything is left to receive the request.
func (s *Server) StartOneShot(req OneShotRequest) (<-chan OneShotResult, error) {
	client := s.engineClient.Load()
	if client == nil || !s.IsEngineConnected() {
		return nil, fmt.Errorf("no engine is connected, so there is nothing to run the prompt")
	}

	requestID := generateOneShotID()
	ch, err := s.oneShot.arm(requestID)
	if err != nil {
		return nil, err
	}

	if !client.Send(map[string]any{
		"type":       "run-one-shot",
		"requestId":  requestID,
		"prompt":     req.Prompt,
		"strategyId": req.StrategyID,
		"name":       req.Name,
		"timeoutMs":  req.Timeout.Milliseconds(),
	}) {
		s.oneShot.disarm()
		return nil, fmt.Errorf("the engine's connection closed before the run could be sent")
	}

	jlog.Info("One-shot run dispatched to the engine (request %s, strategy %s)", requestID, req.StrategyID)
	return ch, nil
}

// CancelOneShot abandons the round-trip in flight, so a result arriving after
// the caller has given up goes nowhere.
func (s *Server) CancelOneShot() { s.oneShot.disarm() }

// RequestShutdown asks the server to shut down, as POST /api/shutdown does.
// The app layer's graceful loop is already watching ShutdownChan, so this
// unwinds through the same serialized quit as every other exit — which is what
// reaps the provider subprocesses and flushes the conversation saves.
func (s *Server) RequestShutdown() { s.initiateShutdown() }

// generateOneShotID mints the id one request and its answer are correlated by.
func generateOneShotID() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("run_%d", time.Now().UnixNano())
	}
	return "run_" + hex.EncodeToString(b)
}
