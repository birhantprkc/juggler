//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"fmt"
	"sync/atomic"
	"time"

	"juggler/cmd/juggler/providers/provider"
)

// What a conversation has spent, and the ceiling that stops it running away.
//
// Every round-trip's usage was logged and then forgotten: the per-turn figures
// went to the conversation log, the per-thread ones onto the thread tile as
// estimates, and nothing anywhere added them up. A conversation could therefore
// spend tens of millions of input tokens — most of it inside sub-threads nobody
// was watching — with no figure on screen saying so, and the total obtainable
// only by summing log lines afterwards.
//
// The counter is conversation-wide because that is the unit a person spends in.
// It runs on ConversationWorker, which is one per conversation (manager.go) and
// is shared by every thread's run through the embedded pointer in `run`, so a
// figure recorded on a sub-thread's goroutine lands in the same total as the
// root's. That is the whole reason it lives here rather than on turnState.
//
// Both figures are what the PROVIDER billed, never the local admission estimate:
// the estimator is deliberately conservative (see approximateTokenCount) and
// runs up to ~2x hot on structured content, which is tolerable for deciding when
// to compact and not tolerable in a number presented as what a conversation
// cost. Where a provider reports no count and the provider substituted a local
// one, the running total is marked approximate and stays marked — see
// metaSpendApproximate.
const (
	// metaSpendInput is the conversation's cumulative billed INPUT tokens, every
	// thread included. Durable top-level metadata rather than part of the
	// ephemeral processingState blob, because it is a lifetime figure: it must
	// survive the reload that follows the crash people want it for.
	metaSpendInput = "spendInputTokens"

	// metaSpendOutput is the same for output tokens. Kept separate rather than
	// summed into one number because they are not the same thing and are not
	// priced as the same thing; a single total would be a figure with no unit.
	metaSpendOutput = "spendOutputTokens"

	// metaSpendApproximate records that at least one turn in the total was
	// counted by a local fallback estimate rather than billed by the provider
	// (LLMResponse.InputTokensApproximate). Set once, never cleared: a later
	// measured turn does not make the estimate already in the total any more
	// exact, and a figure shown without the qualifier is a claim we cannot make.
	metaSpendApproximate = "spendApproximate"
)

// DefaultSpendCeilingTokens is the shipped ceiling: cumulative billed input
// tokens for one conversation, past which delegated work stops.
//
// Twenty million is chosen to be incident territory rather than a budget. The
// fan-out this exists for reached ~28M, 13.8M of it in ten minutes; ordinary
// long sessions sit well under 5M. A ceiling that fires in normal use would be
// read as noise and switched off, which is the one outcome that helps nobody.
//
// It meters INPUT only. Output is a small fraction of the count and is bounded
// per turn by the model's own reserve; input is what a growing transcript
// re-sends every turn, and is where a runaway's cost actually is.
const DefaultSpendCeilingTokens int64 = 20_000_000

// SpendLimitFunc reports the configured ceiling in cumulative input tokens, 0
// meaning no ceiling. Injected so this package stays free of the credentials
// store; a nil func means the default applies. Read live at each turn boundary,
// so a settings change takes effect on the next turn without a restart.
type SpendLimitFunc func() int64

// SetSpendLimit installs the ceiling resolver. See SpendLimitFunc.
func (w *ConversationWorker) SetSpendLimit(fn SpendLimitFunc) {
	w.spendLimit = fn
}

// toInt64 reads a number out of doc metadata, whatever numeric shape the CRDT
// round-trip left it in. Anything else — absent, or not a number — is 0.
func toInt64(v any) int64 {
	switch n := v.(type) {
	case int64:
		return n
	case float64:
		return int64(n)
	case int:
		return int64(n)
	default:
		return 0
	}
}

// recordTurnSpend adds one completed round-trip to the conversation's running
// total. Called for every call that reaches a provider — the strategy loop's
// turns, an autonomous provider turn, and the hidden calls compaction makes —
// because a token spent out of sight is still spent.
//
// A nil response, or one carrying no counts, adds nothing: a call that failed
// before the provider reported usage has nothing to contribute, and writing a
// zero row for it would cost a sync to every viewer to say so.
func (r *run) recordTurnSpend(response *LLMResponse) {
	if response == nil {
		return
	}
	in, out := int64(response.InputTokens), int64(response.OutputTokens)
	if in <= 0 && out <= 0 {
		return
	}

	w := r.ConversationWorker
	if response.InputTokensApproximate {
		w.spendApproximate.Store(true)
	}
	totalIn := w.addSpendFloored(&w.spendInput, metaSpendInput, in)
	totalOut := w.addSpendFloored(&w.spendOutput, metaSpendOutput, out)

	w.doc.SetMetadata(metaSpendInput, totalIn)
	w.doc.SetMetadata(metaSpendOutput, totalOut)
	if w.spendApproximate.Load() {
		w.doc.SetMetadata(metaSpendApproximate, true)
	}
}

// addSpendFloored advances one counter by delta, first taking the persisted
// figure as a floor. Both halves matter and neither can be dropped:
//
// The floor keeps the total MONOTONIC across a worker restart on a reloaded
// conversation — a fresh worker starts at zero while the document already holds
// the whole history, and a lifetime total that went backwards on a reload would
// read as a refund. Same rule, and the same reason, as bumpTurnCounterAtIdle's
// seed.
//
// The compare-and-swap keeps it lossless while sibling threads record at once.
// A plain read-max-add-store would drop one of two concurrent turns, which is
// precisely the fan-out case this counter exists to measure.
//
// Saturating, so a total that somehow overflowed could not wrap negative and
// switch the ceiling off at the moment it was most needed.
func (w *ConversationWorker) addSpendFloored(counter *atomic.Int64, metaKey string, delta int64) int64 {
	floor := toInt64(w.doc.GetMetadata(metaKey))
	for {
		current := counter.Load()
		base := current
		if floor > base {
			base = floor
		}
		next := provider.SaturatingAdd(base, delta)
		if counter.CompareAndSwap(current, next) {
			return next
		}
	}
}

// conversationSpend returns the conversation's cumulative billed input and
// output tokens, and whether any part of the input total was estimated rather
// than billed. Reading applies the same document floor as recording, so a
// worker that has run no turn since a reload still answers with the history.
func (w *ConversationWorker) conversationSpend() (int64, int64, bool) {
	in := w.addSpendFloored(&w.spendInput, metaSpendInput, 0)
	out := w.addSpendFloored(&w.spendOutput, metaSpendOutput, 0)
	if approx, _ := w.doc.GetMetadata(metaSpendApproximate).(bool); approx {
		w.spendApproximate.Store(true)
	}
	return in, out, w.spendApproximate.Load()
}

// spendCeiling is the configured ceiling in cumulative input tokens: 0 = off.
func (w *ConversationWorker) spendCeiling() int64 {
	if w.spendLimit == nil {
		return DefaultSpendCeilingTokens
	}
	if limit := w.spendLimit(); limit > 0 {
		return limit
	}
	return 0
}

// spendCeilingReached reports whether this conversation has spent its ceiling.
// At the ceiling counts as reached: the limit is the last acceptable figure,
// not the first unacceptable one.
func (w *ConversationWorker) spendCeilingReached() bool {
	ceiling := w.spendCeiling()
	if ceiling <= 0 {
		return false
	}
	in, _, _ := w.conversationSpend()
	return in >= ceiling
}

// spendCeilingStopsRun reports whether the ceiling governs the run in hand.
//
// It governs exactly what the turn budget governs (runBudgetSpent), and for the
// same argument: a leaf worker an LLM opened, never the root thread, never a
// thread a person created or has since taken over. A human watching their own
// thread can see it running and stop it; being refused by a ceiling they would
// then have to go and find in settings is the tool overruling its user. An agent
// nobody is watching has no such brake.
func (r *run) spendCeilingStopsRun() bool {
	threadItemID := r.t.thread.itemID
	if threadItemID == "" {
		return false
	}
	if !r.doc.threadFlag(threadItemID, "llmCreated") {
		return false
	}
	if r.doc.threadFlag(threadItemID, "canSpawnThreads") {
		return false
	}
	return r.spendCeilingReached()
}

// spendCeilingNoticeMarker is the phrase the ceiling notice is recognised by —
// in a child's transcript, by a reader, and in tests. Its own constant so the
// notice stays identifiable as one after the wording changes.
const spendCeilingNoticeMarker = "spend ceiling"

// spendCeilingNotice is what a delegated run is told at the boundary where the
// ceiling lands on it. It asks for the report rather than announcing a stop: the
// tools are withheld in the same breath (filterToolsForThread), so this turn has
// to answer, and what it answers is what the caller gets. Naming the figures
// keeps the model able to explain the ending to the person reading it.
func spendCeilingNotice(spent, ceiling int64) string {
	return fmt.Sprintf("This conversation has spent %s input tokens, past its %s %s, so no further "+
		"tools will be offered. Give your report now from what you already have: answer what you can, "+
		"and say plainly what you could not finish and what you would do next.",
		formatTokenCount(spent), formatTokenCount(ceiling), spendCeilingNoticeMarker)
}

// announceSpendCeiling appends the ceiling notice to the current thread, at the
// turn boundary where the ceiling landed on it.
//
// Said once per run, for the reason announceRunBudgetSpent is: a notice repeated
// every turn becomes the loudest thing in the child's context and is read as a
// fresh instruction each time, which is the opposite of asking it to land.
func (r *run) announceSpendCeiling() {
	if !r.spendCeilingStopsRun() || r.t.runBudget.spendTold {
		return
	}
	r.t.runBudget.spendTold = true
	spent, _, _ := r.conversationSpend()
	r.appendTargetMessage(ConversationItem{
		Type:      ItemTypeSystemReminder,
		ItemID:    generateItemID(),
		Content:   spendCeilingNotice(spent, r.spendCeiling()),
		Source:    spendCeilingNoticeMarker,
		Timestamp: time.Now().Format(time.RFC3339),
	})
	r.log.Info("[worker] thread %s stopped at the conversation spend ceiling (%d of %d input tokens) — tools withheld, asked to report",
		r.t.thread.itemID, spent, r.spendCeiling())
}

// spendCeilingRefusal is what a caller is told when the ceiling turns a
// thread-opening call down. Same shape as the depth and breadth refusals: say
// what happened, name the figures, and say what to do instead — a refusal the
// model cannot explain is one the user reads as a bug. Naming the tool keeps it
// true of every path that opens a thread, not just create_thread.
func spendCeilingRefusal(toolName string, spent, ceiling int64) string {
	return fmt.Sprintf("%s refused: this conversation has spent %s input tokens, past its %s spend "+
		"ceiling. Do this work inline in the current thread, and if it genuinely needs more than that, "+
		"say so in your reply — raising or removing the ceiling is the user's call, in Settings → Defaults.",
		toolName, formatTokenCount(spent), formatTokenCount(ceiling))
}

// formatTokenCount renders a token count the way the UI does — 28.1M, 412k —
// because a notice quoting 28134902 asks its reader to count digits.
func formatTokenCount(n int64) string {
	switch {
	case n >= 10_000_000:
		return fmt.Sprintf("%dM", n/1_000_000)
	case n >= 1_000_000:
		return fmt.Sprintf("%.1fM", float64(n)/1_000_000)
	case n >= 10_000:
		return fmt.Sprintf("%dk", n/1000)
	case n >= 1000:
		return fmt.Sprintf("%.1fk", float64(n)/1000)
	default:
		return fmt.Sprintf("%d", n)
	}
}
