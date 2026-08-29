//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Automatic compaction: everything that decides to shrink a conversation, and
// does it.
//
// There is one trigger, and it is not in this file — it is the admission
// ceiling (provider.DefaultContextCeilingFraction), evaluated against a fully
// built request before every dispatch. Admission raises a
// ContextCompactionAdvisory at the soft ceiling, and a ContextLimitExceededError
// when a provider rejects a request outright; both arrive here as the same typed
// overflow, so the soft ceiling and the hard wall are one code path. Because a
// dispatch happens between every pair of tool calls, compaction lands in the
// middle of a turn — while a smaller transcript can still help the work in
// progress, rather than after it has finished and a summary is of no use to
// anyone.
//
// The ladder handleContextOverflow runs, in order: hand a folded /compact thread
// to its summarizer; honour the off switch; shrink an oversized trailing tool
// result in place (a live tool_use/tool_result pair must survive, so it can
// never be folded); then fold the leading run of history into a summary thread,
// keeping the largest verbatim suffix that still leaves the reducer room to
// work. Progress is judged structurally — by the shape of the durable items,
// never by a token estimate — and one incident is bounded by
// maxContextRecoveryAttempts.
package worker

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"time"

	"juggler/cmd/juggler/providers/provider"
)

const (
	// recoverySummaryFloorTokens is the minimum final-summary headroom the
	// reducer window must leave after the verbatim suffix is reserved: the
	// suffix walk stops once another unit would push the reducer window below
	// reserve + floor, keeping the reducer's fit proofs meaningful.
	recoverySummaryFloorTokens int64 = 1000

	// maxContextRecoveryAttempts permits several progressive folds while keeping
	// provider retries small and independent from the reducer's internal call cap.
	maxContextRecoveryAttempts = 4
)

// recoverySignature captures the objective structural shape of the target
// items so advance can tell a fold that made real progress from one that
// changed nothing. It measures item count, serialized size, and the id of the
// leading compaction boundary: a fresh fold creates a new summary thread whose
// id lands here, marking genuine progress that count and size can coincidentally
// match across two different attempts (e.g. a shrink-only pass landing on the
// same wire size as the prior fold). Keying off the summary id is safe because
// recoveryUnitFoldable pins existing summaries out of the fold range — the id
// only moves when brand-new history is summarized, never when an existing
// summary is re-wrapped (that can no longer happen).
type recoverySignature struct {
	retainedItems int
	foldBoundary  string
	wireSize      int
}

type contextRecoveryResult struct {
	Changed   bool
	Signature recoverySignature
}

type compactionAttempts struct {
	attempts          int
	previousSignature recoverySignature
}

func (s *compactionAttempts) canAttempt() bool {
	return s.attempts < maxContextRecoveryAttempts
}

func (s *compactionAttempts) advance(result contextRecoveryResult, overflow error) (bool, error) {
	if !s.canAttempt() {
		return false, overflow
	}
	s.attempts++
	if !result.Changed || (s.attempts > 1 && result.Signature == s.previousSignature) {
		return false, overflow
	}
	s.previousSignature = result.Signature
	return true, nil
}

func contextLimitFromAdvisory(advisory *provider.ContextCompactionAdvisory) *provider.ContextLimitExceededError {
	return &provider.ContextLimitExceededError{
		EstimatedInputTokens: advisory.EstimatedInputTokens,
		OutputReserveTokens:  advisory.OutputReserveTokens,
		ContextWindowTokens:  advisory.ContextWindowTokens,
		Breakdown:            advisory.Breakdown,
		MeasuredPrefix:       advisory.MeasuredPrefix,
	}
}

func providerAuthoredContextError(overflow error) error {
	var contextLimit *provider.ContextLimitExceededError
	if errors.As(overflow, &contextLimit) && contextLimit.Cause != nil {
		return fmt.Errorf("%s: %w", contextLimit.Cause.Error(), overflow)
	}
	return overflow
}

// overflowVerdict tells the strategy loop how to proceed after
// handleContextOverflow has tried to reduce a context-limit overflow.
type overflowVerdict int

const (
	// overflowRetry: durable history changed its objective shape; rebuild the
	// request and retry the turn.
	overflowRetry overflowVerdict = iota
	// overflowStop: the incident resolved without a turn error (a folded thread
	// summarized, or the reduce was cancelled); end the run quietly.
	overflowStop
	// overflowBypassAndRetry: nothing more can be reduced under an advisory
	// estimate; dispatch one request-local guard bypass, then retry.
	overflowBypassAndRetry
	// overflowTerminal: give up and report err as the turn's error.
	overflowTerminal
)

type overflowResult struct {
	verdict overflowVerdict
	err     error // set only for overflowTerminal
}

// handleContextOverflow runs the shared bounded-compaction → context-recovery
// ladder for a context-limit overflow, whether it arrived as a provider
// rejection (isAdvisory=false) or as a silent-truncation admission estimate
// (isAdvisory=true). limit is the normalized overflow (contextLimitFromAdvisory
// for the estimate case); overflowErr is the original error, preserved so a
// terminal verdict can surface the provider-authored cause. recovery is the
// per-incident attempt budget, advanced in place. The two overflow kinds differ
// only in the terminal move: an advisory that can no longer reduce bypasses the
// guard once and retries, where a provider rejection surfaces the overflow.
func (r *run) handleContextOverflow(
	limit *provider.ContextLimitExceededError,
	isAdvisory bool,
	guardBypassed bool,
	recovery *compactionAttempts,
	modelConfig *ModelConfig,
	overflowErr error,
) overflowResult {
	// The request-local fallback is single-shot. Registry admission honors the
	// bypass before transport, so a repeated advisory here means a broken
	// caller/provider contract; stop without ever publishing the estimate as a
	// terminal user error. Provider rejections carry no such single-shot guard.
	if isAdvisory && guardBypassed {
		r.log.Error("[context guard] advisory repeated after fallback bypass; stopping without a terminal estimate error")
		return overflowResult{verdict: overflowStop}
	}

	// A browser-folded summary thread reduces in one bounded pass. When this
	// overflow belongs to such a thread, tryBoundedCompaction handles it here.
	if handled, compactErr := r.tryBoundedCompaction(limit, modelConfig); handled {
		if compactErr == nil || errors.Is(compactErr, errBoundedCompactionCancelled) {
			return overflowResult{verdict: overflowStop}
		}
		// Hidden reducer requests bypass the guard, so any error here is a real
		// bounded/provider failure rather than the advisory escaping.
		return overflowResult{verdict: overflowTerminal, err: fmt.Errorf("bounded compaction failed: %w", compactErr)}
	}

	// Global off switch: when automatic compaction is disabled, nothing here
	// rewrites history. The manual-fold summarizer above stays enabled (a
	// manually folded thread must still summarize).
	//
	// The request already asked admission for the hard window (buildLLMRequest
	// sets contextCeilingFraction=1 under this same gate), so any advisory
	// reaching here is at the real window rather than the soft ceiling. It is
	// still only an estimate, and an estimate must never be terminal: dispatch
	// one guard-bypassed retry and let the provider be authoritative. If it
	// genuinely does not fit, the rejection returns below and surfaces the
	// provider's own context error, so the user hits the wall — and the "Compact
	// now" affordance — instead of an automatic summarize.
	if !r.autoCompactEnabled() {
		if isAdvisory {
			return overflowResult{verdict: overflowBypassAndRetry}
		}
		// Surface the provider's own context error, with a one-line hint that
		// manual /compact still works — the "Compact now" affordance for a
		// deliberately-disabled auto-compaction. Wrapping with %w keeps the
		// provider cause reachable via errors.Is/As.
		err := fmt.Errorf("%w\n\nContext limit reached — run /compact to summarize the conversation and continue",
			providerAuthoredContextError(overflowErr))
		return overflowResult{verdict: overflowTerminal, err: err}
	}

	// Ordinary root / subthread turn: summarize or shrink durable history, then
	// rebuild and retry only when its objective shape changed. When the attempt
	// budget is spent, the terminal move depends on the overflow kind.
	if !recovery.canAttempt() {
		if isAdvisory {
			r.log.Info("[context guard] recovery attempt bound reached; %s=%d reserve=%d window=%d; dispatching one fallback", limit.InputBasis(), limit.EstimatedInputTokens, limit.OutputReserveTokens, limit.ContextWindowTokens)
			return overflowResult{verdict: overflowBypassAndRetry}
		}
		// Preserve and expose the last provider-authored overflow; do not
		// replace it with a local estimate or retry-limit error.
		r.log.Info("[compaction] stopped after %d progressive attempts", recovery.attempts)
		return overflowResult{verdict: overflowTerminal, err: providerAuthoredContextError(overflowErr)}
	}

	result, recErr := r.compactToFit(limit, modelConfig)
	if errors.Is(recErr, errBoundedCompactionCancelled) {
		return overflowResult{verdict: overflowStop}
	}
	if recErr != nil {
		// A concrete recovery failure (reducer call, concurrent source change,
		// persistence) is its own terminal error — a silent stop would look like
		// a dead conversation. Only the advisory estimate must never be terminal.
		// limit.Cause is nil for an advisory estimate, so the wrap only fires on
		// a provider rejection that carried a cause.
		err := fmt.Errorf("context recovery failed: %w", recErr)
		if limit.Cause != nil {
			err = fmt.Errorf("%w (provider: %s)", err, limit.Cause.Error())
		}
		return overflowResult{verdict: overflowTerminal, err: err}
	}
	if retry, _ := recovery.advance(result, overflowErr); retry {
		return overflowResult{verdict: overflowRetry}
	}
	if isAdvisory {
		r.log.Info("[context guard] %s=%d reserve=%d window=%d; dispatching one irreducible fallback", limit.InputBasis(), limit.EstimatedInputTokens, limit.OutputReserveTokens, limit.ContextWindowTokens)
		return overflowResult{verdict: overflowBypassAndRetry}
	}
	// No durable structural progress: surface the latest provider overflow
	// unchanged so errors.Is/As reach its Cause.
	r.log.Info("[compaction] stopped because the request structure did not change")
	return overflowResult{verdict: overflowTerminal, err: providerAuthoredContextError(overflowErr)}
}

func contextRecoverySignature(items []ConversationItem) recoverySignature {
	raw, _ := json.Marshal(items)
	boundary := ""
	for _, item := range items {
		if item.Type == ItemTypeThread && item.BoundedCompaction {
			boundary = item.ItemID
			break
		}
	}
	return recoverySignature{
		retainedItems: len(items),
		foldBoundary:  boundary,
		wireSize:      len(raw),
	}
}

func contextRecoveryOutcome(before recoverySignature, items []ConversationItem) contextRecoveryResult {
	after := contextRecoverySignature(items)
	return contextRecoveryResult{Changed: after != before, Signature: after}
}

// recoveryUnit is an atomic fold-boundary unit over the target items array:
// [start, end) is either a single item or a run of same-transaction
// tool-actions (mirroring buildMessages batching, so a fold boundary can never
// split a tool_use/tool_result batch). est is the unit's estimated wire size.
type recoveryUnit struct {
	start, end int
	est        int64
}

// compactToFit recovers an ordinary root or subthread turn whose request
// was rejected by the provider for context size. It reports objective structural
// progress from the durable item shape; the advisory token estimate is used for
// planning only and is never the progress criterion.
//
// Every failure path returns a typed error: BoundedCompactionError for
// deterministic recovery failures, BoundedCompactionCancelledError (matching
// errBoundedCompactionCancelled) when interrupted mid-reduce.
func (r *run) compactToFit(limitErr *provider.ContextLimitExceededError, modelConfig *ModelConfig) (contextRecoveryResult, error) {
	if !r.exclusivelyOwnsConversation() {
		return contextRecoveryResult{}, errBoundedCompactionCancelled
	}
	before := contextRecoverySignature(r.getTargetItems())
	if r.compactionCancelled() {
		return contextRecoveryResult{}, errBoundedCompactionCancelled
	}
	pinnedModel, err := validateCompactionModel(modelConfig, "context recovery")
	if err != nil {
		return contextRecoveryResult{}, err
	}
	window := limitErr.ContextWindowTokens
	reserve := limitErr.OutputReserveTokens
	if window <= 0 {
		return contextRecoveryResult{}, &BoundedCompactionError{Reason: BoundedCompactionContextBound, Message: "context recovery requires a known context window", Window: window}
	}

	// Everything admission counted that is not per-message content is the
	// fixed envelope (system prompt, tools, framing, ids, provider overhead).
	envelope := limitErr.Breakdown.Total - limitErr.Breakdown.MessageTokens - limitErr.Breakdown.ImageTokens
	if envelope < 0 {
		envelope = 0
	}

	r.beginCompactionStatus("Summarizing earlier conversation to fit the context window")
	r.recordCompactionStart(compactionKindAuto, window, reserve, envelope)

	// A trailing tool-result payload too large for the suffix budget can never
	// be folded — folding would destroy the live tool pair. Shrink oversized
	// results in place to reducer-generated summaries first; the pair stays
	// intact on the wire and in the visible doc (the full result survives in
	// its transaction blob).
	if err := r.shrinkOversizedTrailingToolResults(limitErr, &pinnedModel, envelope); err != nil {
		return contextRecoveryResult{}, err
	}

	// The synthesized prompt item id: it lives inside the folded thread's nested
	// items, never in the target array, so it matches nothing there and excludes
	// nothing from the canonical fingerprint — it just replaces the old
	// recoveryPromptSentinel and becomes the thread's CompactionPromptItemID.
	promptID := generateItemID()

	items := r.getTargetItems()
	records, err := canonicalCompactionRecords(items, promptID)
	if err != nil {
		return contextRecoveryResult{}, &BoundedCompactionError{Reason: BoundedCompactionSourceEncoding, Message: "context recovery could not encode canonical source: " + err.Error(), Cause: err}
	}
	if len(records) == 0 {
		return contextRecoveryOutcome(before, items), nil
	}
	fingerprint := compactionSourceFingerprint(records)

	units := recoveryAtomicUnits(items)
	// A delegated thread's most recent invocation message is pinned on top of
	// the per-item rules: it is where the run in flight will stamp its outcome,
	// and where the thread's liveness is read from (lastInvocationIndex). Every
	// earlier one folds with the run bodies around it, its record preserved on
	// the fold, so a long-lived session folds every completed run in one stretch.
	pinnedInvocation := lastInvocationIndex(items)
	foldable := func(u recoveryUnit) bool {
		return u.start != pinnedInvocation && recoveryUnitFoldable(items[u.start])
	}

	// Leading non-conversational items (rules, plans, other standing context)
	// are pinned: they render through the system prompt (already inside the
	// envelope) and must never be folded. The summary is inserted after them.
	skip := 0
	for skip < len(units) && !foldable(units[skip]) {
		skip++
	}

	// Walk units backward, maximizing the verbatim suffix subject to leaving
	// the reducer a workable window. A pinned unit stops the walk — the fold
	// boundary may not cross it.
	k := len(units)
	var suffixEst int64
	for k > skip {
		unit := units[k-1]
		if !foldable(unit) {
			break
		}
		if window-envelope-(suffixEst+unit.est) < reserve+recoverySummaryFloorTokens {
			break
		}
		suffixEst += unit.est
		k--
	}
	if k == len(units) {
		return contextRecoveryOutcome(before, items), nil
	}
	// The suffix walk stops at the first pinned unit from the back, but another
	// pinned unit (an earlier compaction summary) can still sit deeper inside
	// [skip, k) with fresh, foldable history on both sides of it. The fold is a
	// single contiguous range, so folding across that summary would swallow and
	// nest it. Clamp k to the first pinned unit at or after skip, so the fold
	// covers only the leading contiguous run of fresh history and leaves the
	// prior summary (and everything after it) untouched — later passes fold the
	// runs beyond it. units[skip] is foldable by construction, so k stays > skip.
	for p := skip; p < k; p++ {
		if !foldable(units[p]) {
			k = p
			break
		}
	}
	if k <= skip {
		// Every foldable unit fits verbatim within the window, so there is
		// nothing this pass can usefully fold. Two ways to arrive here:
		// shrinkOversizedTrailingToolResults above brought an oversized trailing
		// result under budget, or admission sized the request from a measured
		// prefix while this walk sizes it from per-item estimates, and the two
		// disagree about whether it fits. Either way the answer is the same —
		// succeed and let the caller's retry proceed against this history rather
		// than summarizing history the walk says needs no summary. Admission on
		// the retry is the backstop if that judgement is optimistic: a request
		// that really is over the ceiling is rejected again, and the caller's
		// attempt bound turns a repeat into the bypassed fallback dispatch.
		r.recordCompactionOutcome(compactionKindAuto, "shrink-only", CompactionResult{}, map[string]any{"suffixTokens": suffixEst})
		r.log.Info("[compaction] trailing-result shrink sufficed; no history fold needed (suffix=%d tokens)", suffixEst)
		return contextRecoveryOutcome(before, items), nil
	}

	prefixStart := units[skip].start
	prefixEnd := units[k-1].end
	prefixRecords := records[prefixStart:prefixEnd]
	// The hidden compaction calls are independent requests against the full
	// context window: providerOverhead accounts for the provider's fixed overhead
	// exactly once. Subtracting envelope+suffix from the window would double-count
	// that overhead (envelope already includes it) and wrongly charge the original
	// request's system prompt and tools, which the hidden calls do not carry — on
	// a large fixed overhead (e.g. the Claude Code CLI's 40k) the reduced window
	// cannot even fit the empty hidden envelope, bricking recovery. The folded
	// summary is kept fittable by the suffix walk above, which already reserved
	// reserve + recoverySummaryFloorTokens of headroom for it.
	budget := boundedCompactionBudget{
		window:           window,
		reserve:          reserve,
		providerOverhead: limitErr.Breakdown.ProviderOverheadTokens,
		// The rejected original request is seeded into the reported accounting;
		// spend gates nothing (see boundedCompactionBudget).
		spend: provider.SaturatingAdd(limitErr.EstimatedInputTokens, reserve),
		calls: 1,
	}

	result, err := r.runReducer(compactionKindAuto, pinnedModel, budget, prefixRecords)
	if err != nil {
		return contextRecoveryResult{}, err
	}

	// Recovery synthesizes the same folded-thread shape /compact produces rather
	// than a bespoke flat summary item: the folded prefix is preserved verbatim
	// as the thread's nested items (for undo/inspection and future re-folding), a
	// synthesized prompt item is referenced by CompactionPromptItemID (and thereby
	// excluded from canonical history), and the reducer's summary + accounting live
	// on the thread. It renders to the wire through the same bounded-compaction
	// thread path as a browser fold (buildThreadResultMap's inert framing).
	promptItem := ConversationItem{
		Type:    ItemTypeUser,
		ItemID:  promptID,
		Content: defaultSummarizationPromptMarker,
	}
	nested := append(append([]ConversationItem{}, items[prefixStart:prefixEnd]...), promptItem)
	nestedJSON, err := json.Marshal(nested)
	if err != nil {
		r.recordCompactionOutcome(compactionKindAuto, "error", result, map[string]any{"reason": string(BoundedCompactionSourceEncoding)})
		return contextRecoveryResult{}, &BoundedCompactionError{Reason: BoundedCompactionSourceEncoding, Message: "context recovery could not encode folded thread items: " + err.Error(), Cause: err}
	}
	resultJSON, _ := json.Marshal(result.Summary)
	summaryItem := ConversationItem{
		Type:                   ItemTypeThread,
		ItemID:                 generateItemID(),
		Timestamp:              time.Now().Format(time.RFC3339),
		Goal:                   "Compacted conversation history",
		Summary:                fmt.Sprintf("Summarized %d earlier items to fit the context window", prefixEnd-prefixStart),
		BoundedCompaction:      true,
		CompactionPromptItemID: promptID,
		Items:                  nestedJSON,
		Result:                 resultJSON,
		FoldedRuns:             foldedRunsIn(items[prefixStart:prefixEnd]),
	}
	// Persist the operation's accounting durably on the thread item itself — the
	// doc is the inspectable record of what the fold cost.
	summaryItem.Data, _ = json.Marshal(compactionAccountingMap(result))

	// Commit only against the exact snapshot the reducer consumed. The
	// fingerprint recheck and the fold run under one ycrdtMu hold inside
	// foldPrefixIntoSummaryTracked, so a concurrent doc change (user edit,
	// queued-message promotion) that lands between check and write cannot leave
	// the fold splicing at stale indices — it aborts rather than clobbering. The
	// tracked variant captures the whole delete+insert as one undo group, so a
	// single undo reverses the fold (parity with the browser /compact fold).
	if !r.foldPrefixIntoSummaryTracked(r.getTargetItemsYArray(), prefixStart, prefixEnd-prefixStart, summaryItem, promptID, fingerprint) {
		r.recordCompactionOutcome(compactionKindAuto, "error", result, map[string]any{"reason": string(BoundedCompactionSourceChanged)})
		return contextRecoveryResult{}, &BoundedCompactionError{
			Reason: BoundedCompactionSourceChanged, Message: "conversation changed during context recovery; nothing was folded",
			Calls: result.Calls, Spend: result.EstimatedSpend,
			Window: budget.window, Usage: result.Usage,
		}
	}
	r.recordCompactionOutcome(compactionKindAuto, "fold", result, map[string]any{
		"foldedItems": prefixEnd - prefixStart, "suffixTokens": suffixEst, "window": window,
	})
	r.log.Info("[compaction] folded %d items into a compaction summary (passes=%d calls=%d spend=%d window=%d suffix=%d tokens)",
		prefixEnd-prefixStart, result.Passes, result.Calls, result.EstimatedSpend, window, suffixEst)
	return contextRecoveryOutcome(before, r.getTargetItems()), nil
}

// recoveryShrunkResultMarker prefixes a tool result that was replaced by a
// reducer-generated summary because it could never fit the model context.
const recoveryShrunkResultMarker = "[tool result exceeded the model context window and was summarized]\n\n"

// shrinkOversizedTrailingToolResults handles the active-tool-loop case: the
// newest history unit is a tool-action batch whose result payload alone busts
// the suffix budget, so the suffix walk could never keep it and folding it
// would destroy the live tool pair. Each oversized result in that trailing
// batch is summarized in place with the bounded reducer (the reducer rune-
// splits a single result larger than one map budget across calls); the tool
// call and its (now summarized) result stay paired on the wire and in the
// visible doc. No-op when the trailing unit fits or is not a tool batch.
func (r *run) shrinkOversizedTrailingToolResults(limitErr *provider.ContextLimitExceededError, pinnedModel *ModelConfig, envelope int64) error {
	window := limitErr.ContextWindowTokens
	reserve := limitErr.OutputReserveTokens

	items := r.getTargetItems()
	units := recoveryAtomicUnits(items)
	if len(units) == 0 {
		return nil
	}
	trailing := units[len(units)-1]
	if items[trailing.start].Type != ItemTypeToolAction {
		return nil
	}
	if window-envelope-trailing.est >= reserve+recoverySummaryFloorTokens {
		return nil // the trailing batch fits the suffix budget as-is
	}

	for i := trailing.start; i < trailing.end; i++ {
		item := items[i]
		var resultPayload struct {
			Content string `json:"content"`
			IsError bool   `json:"isError"`
		}
		if err := json.Unmarshal(item.Result, &resultPayload); err != nil || resultPayload.Content == "" {
			continue
		}
		contentEst := provider.EstimateMessageRequestTokenBreakdown(provider.MessageRequest{
			Messages: []provider.Message{{Type: "user", Content: resultPayload.Content}},
		}, 0).Total
		if contentEst <= recoverySummaryFloorTokens {
			continue
		}

		// The shrink call is an independent request against the full context
		// window; providerOverhead counts the provider's fixed overhead once. A
		// tiny reserve+floor window would never fit even the empty hidden envelope
		// on providers with a large fixed overhead (e.g. the Claude Code CLI's
		// 40k), which is what deterministically bricked this path. The shrunk
		// summary is bounded by the wire max_tokens (= reserve), so it still lands
		// inside the suffix headroom the trailing-fits gate above requires.
		budget := boundedCompactionBudget{
			window:           window,
			reserve:          reserve,
			providerOverhead: limitErr.Breakdown.ProviderOverheadTokens,
		}
		reducer := r.newBoundedReducer(compactionKindShrink, *pinnedModel, budget)
		shrunk, err := reducer.run([]string{resultPayload.Content})
		if err != nil {
			if errors.Is(err, errBoundedCompactionCancelled) {
				r.recordCompactionOutcome(compactionKindShrink, "cancelled", shrunk, map[string]any{"toolUseId": item.ToolUseID})
				return &BoundedCompactionCancelledError{Result: shrunk}
			}
			r.recordCompactionOutcome(compactionKindShrink, "error", shrunk, map[string]any{"toolUseId": item.ToolUseID})
			return err
		}
		if r.compactionCancelled() {
			r.recordCompactionOutcome(compactionKindShrink, "cancelled", shrunk, map[string]any{"toolUseId": item.ToolUseID})
			return &BoundedCompactionCancelledError{Result: shrunk}
		}
		if err := r.updateTargetItemByID(item.ItemID, "result", map[string]any{
			"content": recoveryShrunkResultMarker + shrunk.Summary,
			"isError": resultPayload.IsError,
		}); err != nil {
			return &BoundedCompactionError{
				Reason: BoundedCompactionSourceChanged, Message: "tool result disappeared during context recovery: " + err.Error(),
				Calls: shrunk.Calls, Spend: shrunk.EstimatedSpend, Window: reducer.budget.window, Usage: shrunk.Usage,
			}
		}
		r.recordCompactionOutcome(compactionKindShrink, "shrink", shrunk, map[string]any{"toolUseId": item.ToolUseID})
		r.log.Info("[compaction] summarized oversized tool result %s in place (calls=%d spend=%d)",
			item.ToolUseID, shrunk.Calls, shrunk.EstimatedSpend)
	}
	return nil
}

// recoveryUnitFoldable reports whether an item may join the summarized prefix
// or the verbatim suffix: conversational items only. Standing context items
// (rules, plans, system prompts) are pinned in place.
//
// An existing compaction summary thread is also pinned. Re-folding one would
// nest summaries inside summaries and re-summarize already-summarized history —
// each recovery pass deeper and more expensive than the last. Recovery folds
// only fresh, never-summarized history; a prior summary renders on the wire as
// its compact result text and stays put.
//
// The caller applies one further pin this cannot see, because it is positional:
// the thread's most recent invocation message (lastInvocationIndex).
func recoveryUnitFoldable(item ConversationItem) bool {
	if item.Type == ItemTypeThread && item.BoundedCompaction {
		return false
	}
	return isConversationalItemType(item.Type)
}

// recoveryAtomicUnits groups items into fold-boundary units. A run of
// consecutive tool-actions sharing one non-empty TransactionID is a single
// unit (buildMessages emits that run as one batched use/result group, so a
// boundary inside it would sever tool pairs); every other item is a singleton.
func recoveryAtomicUnits(items []ConversationItem) []recoveryUnit {
	units := make([]recoveryUnit, 0, len(items))
	for i := 0; i < len(items); {
		end := i + 1
		if items[i].Type == ItemTypeToolAction && items[i].TransactionID != "" {
			for end < len(items) && items[end].Type == ItemTypeToolAction &&
				items[end].TransactionID == items[i].TransactionID {
				end++
			}
		}
		units = append(units, recoveryUnit{start: i, end: end, est: estimateItemsWireTokens(items[i:end], items)})
		i = end
	}
	return units
}

// estimateItemsWireTokens estimates the admission-side token size of the wire
// messages a unit produces, built through the same message builders as
// buildMessages and json-round-tripped into provider.Message — the exact
// decoding admission sees — so image parts and per-message framing are counted
// identically. Estimation is side-effect free: an unfinished tool result uses
// the same placeholder text appendToolActionResult would emit, without its
// resultFedTurn doc stamp.
//
// siblings is the whole array the unit was cut from: a thread alias reads its
// run's record off the canonical thread item standing there, which is usually
// outside the unit itself.
func estimateItemsWireTokens(items, siblings []ConversationItem) int64 {
	messages := make([]map[string]any, 0, len(items)*2)
	for _, item := range items {
		switch item.Type {
		case ItemTypeUser:
			messages = append(messages, buildUserMessageMap(item))
		case ItemTypeAssistant:
			messages = append(messages, map[string]any{"type": "assistant", "content": item.Content})
		case ItemTypeThinking:
			if item.Content != "" {
				m := map[string]any{"type": "thinking", "content": item.Content}
				if len(item.ProviderData) > 0 {
					m["providerData"] = item.ProviderData
				}
				messages = append(messages, m)
			}
		case ItemTypeToolAction:
			if item.ToolUseID == "" || item.ToolName == "" {
				continue
			}
			messages = append(messages, buildToolUseMap(item))
			if rm := buildToolResultMap(item); rm != nil {
				messages = append(messages, rm)
			} else {
				messages = append(messages, map[string]any{
					"type":      "tool-result",
					"toolUseId": item.ToolUseID,
					"content":   pendingToolResultPlaceholder,
					"isError":   true,
				})
			}
		case ItemTypeThread:
			messages = appendThreadMessages(messages, item, siblings)
		case ItemTypeMetaToolResult:
			if item.ToolName != "" {
				messages = append(messages, buildToolUseMap(item))
			}
			if item.Result != nil {
				if rm := buildToolResultMap(item); rm != nil {
					messages = append(messages, rm)
				}
			}
		case ItemTypeSystemReminder, ItemTypeGuidance:
			if item.Content != "" {
				messages = append(messages, map[string]any{"type": item.Type, "content": item.Content})
			}
		}
	}
	// A well-formed items slice always round-trips; on the (essentially
	// impossible) encode failure, charge a large-but-non-overflowing sentinel so
	// the unit is treated as too big to keep verbatim (forced into the fold)
	// rather than free. MaxInt32 dwarfs any real context window yet stays far
	// below MaxInt64, so the downstream non-saturating suffix arithmetic cannot
	// overflow.
	const unestimableUnitTokens = int64(math.MaxInt32)
	raw, err := json.Marshal(messages)
	if err != nil {
		return unestimableUnitTokens
	}
	var pmsgs []provider.Message
	if err := json.Unmarshal(raw, &pmsgs); err != nil {
		return unestimableUnitTokens
	}
	return provider.EstimateMessageRequestTokenBreakdown(provider.MessageRequest{Messages: pmsgs}, 0).Total
}
