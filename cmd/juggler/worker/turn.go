//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"context"
	"sync/atomic"
	"time"
)

// turnState is everything that belongs to ONE run on ONE thread: which thread it
// writes to, the round-trip in flight, and the accumulators that outlive a
// single chunk but not the run.
//
// It is a named home rather than a spread of fields on the worker because those
// two scopes were indistinguishable while they sat side by side — a worker field
// says "the conversation's", and every one of these says "this run's", which is
// a different lifetime and, once more than one run can be live, a different
// object. Grouping them is what makes the difference legible and what gives the
// call graph one thing to carry instead of ten.
//
// Owned by the worker's run goroutine, like everything else here. The atomics
// are the exceptions and say why in their own comments: they are read or written
// from Stop() and from the wake handler, neither of which runs on that
// goroutine.
type run struct {
	*ConversationWorker
	t *turnState
}

type turnState struct {
	// state is this run's position in the worker state machine: Idle until it is
	// dispatched, Processing while it drives the LLM, Cancelling once a cancel
	// aimed at it has been accepted. It belongs to the run and not to the worker
	// because "cancelling" is a property of ONE run: every wait loop unwinds on
	// reading it, so a conversation-wide flag makes a cancel aimed at one thread
	// tear down the turn streaming on another. Stored via atomic.Value because
	// State() is read from off the run goroutine.
	state atomic.Value // stores WorkerState

	// processingStartedAt is the single anchor every client renders the spinner's
	// elapsed digit against. Approval waits advance it so they are excluded.
	processingStartedAt int64
	// approvalWaitStartedAt records when this turn parked solely for approval.
	approvalWaitStartedAt int64
	// wasBlockedOnApprovals records the previous approval reconciliation state.
	wasBlockedOnApprovals bool

	// lastProgressWriteMs throttles processing-state progress writes.
	lastProgressWriteMs int64
	// lastCacheMissNotice deduplicates cache-miss notices within this turn.
	lastCacheMissNotice string
	// lastProviderNotice deduplicates provider notices for this run.
	lastProviderNotice string

	// thread is the thread this run writes to — the implicit destination of
	// getTargetItems, insertTargetMessage and the rest. Zero value means the root
	// conversation.
	thread threadContext

	// streaming accumulates the current round-trip's text and thinking content.
	// Zeroed by finalizeStreaming at iteration boundaries.
	streaming streamingState

	// offeredTools is the canonical set of tool names sent to the provider for
	// the response being processed. Nil means no authoritative turn snapshot
	// exists; an empty map means the provider was offered no tools.
	offeredTools map[string]bool

	// delegatingTools is the subset of offeredTools whose item declared
	// delegatesToSubthread, with the per-tool facts the delegation decision needs.
	// Rebuilt each iteration and read by processLLMResponse to route a call to the
	// delegation path.
	delegatingTools map[string]delegatingTool

	// txnID is the transaction id of the LLM round-trip currently in flight (set
	// at iteration start, cleared on iteration end). insertTargetMessage stamps
	// this onto every newly inserted item, so any item produced during the
	// round-trip carries the id without each call site having to plumb it.
	txnID string

	// llmTurnID is a fresh generation for each provider attempt, including
	// retries, hidden compaction calls, and mock calls. Shared chunk/result ingress
	// is accepted only when it carries this generation.
	llmTurnID string

	// responseChan carries completed provider calls back to the wait loop.
	responseChan chan llmCallResult

	// chunks carries streamed content from the provider goroutine to THIS run's
	// wait loop. Per-run rather than per-worker because the chunk stream and the
	// streaming accumulators it feeds (see streaming, above) belong to one run:
	// a single shared channel has a single consumer, so once the worker's run()
	// loop and a turn are both live they race to take each chunk, and whichever
	// wins folds it into ITS turn's accumulators. Generously buffered — the
	// provider produces far faster than the document absorbs — and the producer
	// falls through on worker shutdown so a stream outliving its reader cannot
	// wedge the provider goroutine.
	chunks chan StreamChunk

	// cancelLLM is the cancel func for the in-flight LLM context, or nil when
	// idle. Stored via atomic.Pointer so Stop() (running on a different
	// goroutine) can safely cancel the call to unblock waitForLLMResponse.
	cancelLLM atomic.Pointer[context.CancelFunc]

	// wakeInterrupt is set by interruptInFlightLLMForWake just before it cancels
	// the in-flight LLM context on a system-wake. callLLM reads it when its call
	// returns an error so it can surface a clear "interrupted by sleep" message
	// instead of the raw "context canceled". Reset at the top of every callLLM so
	// it never leaks into an unrelated turn.
	wakeInterrupt atomic.Bool

	// retrySpent accumulates wall-clock time spent on FAILED LLM attempts in the
	// current retry sequence. Counting attempts alone bounds nothing: a single
	// attempt can cost minutes when the provider runs its own internal backoff
	// before reporting, so MaxLLMRetries alone permitted a quarter-hour of
	// silence. It lives here rather than in callLLMWithRetry so a strategy-loop
	// restart resumes the same budget instead of beginning a fresh ladder. Reset
	// by resetLLMRetryBudget when the sequence ends.
	retrySpent time.Duration

	// retryStatusActive is true while the spinner is showing "retrying" and no
	// content has arrived since. It keeps the honest label up for the whole of
	// the next attempt — which may itself spend minutes backing off — until real
	// content flips it back; see clearRetryingStatus.
	retryStatusActive bool
}

func (w *ConversationWorker) currentRun() *run {
	return &run{ConversationWorker: w, t: w.turn}
}

func (w *ConversationWorker) Start(ctx context.Context) { w.currentRun().Start(ctx) }
func (w *ConversationWorker) Stop()                     { w.currentRun().Stop() }
func (w *ConversationWorker) StopForRemoval()           { w.currentRun().StopForRemoval() }
func (w *ConversationWorker) interruptInFlightLLMForWake() {
	w.currentRun().interruptInFlightLLMForWake()
}

// newTurnState builds the worker's turn. The response channel is buffered by one
// so a provider goroutine that finishes after its waiter has gone (cancellation,
// timeout) can still deliver and exit rather than leaking. Every result carries
// its provider-attempt generation, so a later waiter consumes and rejects a late
// result instead of mistaking it for its own answer.
func newTurnState() *turnState {
	t := &turnState{
		responseChan: make(chan llmCallResult, 1),
		chunks:       make(chan StreamChunk, 4096),
	}
	t.state.Store(StateIdle)
	return t
}
