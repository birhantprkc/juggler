//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Autonomous-turn drain: surfacing turns the persistent CLI emits while no
// Submit is in flight.
//
// The CLI run under `--input-format stream-json` is not purely reactive — a
// juggler-built wake / monitor the model armed earlier can fire later and
// drive a full turn through the still-open process, writing it to stdout with
// no SendMessage from juggler. Nobody reads stdout between juggler turns, so
// those turns pile up unread in s.content and the next user message dequeues
// the oldest, mis-attributing it (the reported "instant, sensible-but-wrong
// reply" bug).
//
// The fix is a background goroutine that keeps consuming s.content between
// Submits, segments it into complete turns (reusing the same
// readUntilPauseOrComplete state machine the foreground turn uses), and hands
// each completed turn to the Client's onAutonomousTurn sink. Exactly one
// consumer of s.content exists at any time: a Submit stops the drain
// (stopAutonomousDrain) before it reads, and restarts it
// (maybeStartAutonomousDrain) once the CLI is idling on stdin again.
//
// Scope: the background drain surfaces autonomous turns that arrive fully
// BETWEEN sends; flushBufferedTurns (below) handles the send-site overlap where
// a turn completed in the cancel-race window just as a Submit arrived, surfacing
// it ahead of the user's message. The one remaining gap — a turn still mid-emit
// at Submit time — is left for the foreground read. No cost finalisation happens
// here — the drain only reports the turn; billing/Yjs are the sink's job.

package claudecode

import (
	"context"
	"time"

	provider "juggler/cmd/juggler/providers/registry"
)

// subscribeTurns bridges the worker's TurnSink to the Client's internal
// onAutonomousTurn hook. The drain (autonomous_turn.go) and flush
// (flushBufferedTurns) machinery is keyed on onAutonomousTurn being non-nil,
// so subscribing here is also what arms autonomous-turn surfacing for this
// conversation. A nil sink detaches (and quiesces the drain on the next
// turn boundary).
//
// Called by the server's conversation cache at open time, before the handle
// services any turn — so this field write happens-before the worker goroutine
// reads it in streamMessage. One Client per conversation, so the plain field
// is the single owner.
func (c *Client) subscribeTurns(sink provider.TurnSink) {
	if sink == nil {
		c.onAutonomousTurn = nil
		return
	}
	c.onAutonomousTurn = func(tr *turnResult) {
		sink.DeliverTurn(turnResultToProviderTurn(tr))
	}
}

// turnResultToProviderTurn normalises a parsed claudecode turn into the
// provider-neutral ProviderTurn the worker consumes. Token normalisation
// mirrors finalizeTurn's provider-boundary rule: the claude CLI reports
// input_tokens as the fresh-only portion, so InputTokens is summed to the
// "total prompt tokens sent" semantic (fresh + cache read + cache write) the
// rest of juggler expects; CachedTokens / CacheWriteTokens keep their subsets.
// Always marked Autonomous — this converter is only reached via the drain /
// flush paths, which by definition run with no Submit in flight.
func turnResultToProviderTurn(tr *turnResult) provider.ProviderTurn {
	return provider.ProviderTurn{
		Blocks:     tr.Blocks,
		Autonomous: true,
		Result: provider.StreamResult{
			StopReason:       tr.StopReason,
			InputTokens:      tr.InputTokens + tr.CacheReadTokens + tr.CacheWriteTokens,
			OutputTokens:     tr.OutputTokens,
			CachedTokens:     provider.Reported(tr.CacheReadTokens),
			CacheWriteTokens: provider.Reported(tr.CacheWriteTokens),
		},
	}
}

// discardStreamChunks is the drain's stream callback. Autonomous-turn chunks
// are not streamed to a per-Submit callback (there is no Submit); the fully
// assembled turn is delivered to onAutonomousTurn instead.
func discardStreamChunks(provider.StreamChunk) (*provider.ToolResult, error) {
	return nil, nil
}

// flushTurnTimeout bounds how long flushBufferedTurns waits for the next line
// of a turn before giving up. A fully-buffered complete turn parses in
// microseconds; the deadline only trips on a turn that is still mid-emit at
// flush time (the CLI hadn't finished writing it), which we leave for the
// foreground read. Package var so tests can shrink it.
var flushTurnTimeout = 200 * time.Millisecond

// flushBufferedTurns surfaces every COMPLETE autonomous turn already buffered
// in s.content to the sink, in arrival order, before the caller reads a
// foreground response. Called at Submit entry (after stopAutonomousDrain) so a
// turn that arrived in the cancel-race window — just as the user pressed send —
// lands via the sink ahead of the user's message instead of being mis-read as
// that message's reply (the reported "instant wrong reply" bug). It is the
// send-site ordering guarantee: buffered turns are sequenced before the
// foreground turn, by construction, on the one goroutine that owns the Submit.
//
// Zero-cost when nothing is buffered (the common case): the loop guard skips
// immediately, never touching the channel. A turn still mid-emit at flush time
// is left for the foreground read.
func (c *Client) flushBufferedTurns() {
	s := c.activeSession
	if s == nil || s.live == nil || c.onAutonomousTurn == nil {
		return
	}
	for len(s.live.content) > 0 {
		ctx, cancel := context.WithTimeout(context.Background(), flushTurnTimeout)
		turn, _, err := c.readUntilPauseOrComplete(ctx, discardStreamChunks)
		cancel()
		if err != nil || turn == nil ||
			(turn.StopReason != "end_turn" && turn.StopReason != "empty_response") {
			// Deadline hit mid-emit (incomplete turn), an error, or a tool_use
			// turn we cannot drive from here: stop. The partial/remaining content
			// is handled by the foreground read or the next drain — never a
			// fragment surfaced as a turn.
			return
		}
		c.onAutonomousTurn(turn)
	}
}

// maybeStartAutonomousDrain starts the background drain after a turn returns,
// iff a sink is registered, the CLI is still alive, and the turn completed
// cleanly. On tool_use the CLI is parked awaiting our results (delivered by
// the next Submit) and cannot emit autonomous turns, so we do not drain then;
// on error the session is being torn down.
func (c *Client) maybeStartAutonomousDrain(res *provider.StreamResult, err error) {
	if err != nil || c.onAutonomousTurn == nil {
		return
	}
	s := c.activeSession
	if s == nil || !s.hasLiveCLI() {
		return
	}
	if res == nil || (res.StopReason != "end_turn" && res.StopReason != "empty_response") {
		return
	}
	c.startAutonomousDrain()
}

// startAutonomousDrain launches the background drain goroutine. No-op if one is
// already running. The goroutine owns s.content until stopAutonomousDrain
// cancels it; it captures the cancellable context and the session/sink up
// front so it never races a concurrent field mutation.
func (c *Client) startAutonomousDrain() {
	s := c.activeSession
	if s == nil || s.autoDrainCancel != nil {
		return
	}
	handler := c.onAutonomousTurn
	if handler == nil {
		return
	}
	drainCtx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	s.autoDrainCancel = cancel
	s.autoDrainDone = done

	go func() {
		defer close(done)
		for {
			turn, _, err := c.readUntilPauseOrComplete(drainCtx, discardStreamChunks)
			if err != nil || turn == nil {
				// drainCtx cancelled (a Submit took over) or s.content closed
				// (teardown): stop quietly. Any partial turn is discarded; the
				// stream's own boundary is the unit of work, never a fragment.
				return
			}
			handler(turn)
			if turn.StopReason == "tool_use" {
				// An autonomous turn that calls a tool parks the CLI awaiting
				// results we cannot supply from here. Stop draining.
				return
			}
		}
	}()
}

// stopAutonomousDrain cancels the background drain and waits for it to exit, so
// the caller becomes the sole consumer of s.content. Idempotent: a no-op when
// no drain is running. Called at the start of every Submit and at the top of
// tearDownLiveCLI.
func (s *activeSession) stopAutonomousDrain() {
	if s == nil || s.autoDrainCancel == nil {
		return
	}
	s.autoDrainCancel()
	<-s.autoDrainDone
	s.autoDrainCancel = nil
	s.autoDrainDone = nil
}
