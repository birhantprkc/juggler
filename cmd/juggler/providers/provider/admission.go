//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package provider

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"unicode"
	"unicode/utf8"
)

const messageFramingTokens int64 = 4

// RequestTokenEstimate identifies each contribution to an admission estimate.
// Fields and Total use saturating arithmetic.
type RequestTokenEstimate struct {
	SystemPromptTokens     int64
	MessageTokens          int64
	ToolTokens             int64
	MetadataTokens         int64
	ImageTokens            int64
	FramingTokens          int64
	ProviderOverheadTokens int64
	Total                  int64
}

// ContextLimitExceededError reports a context overflow confirmed by the
// provider. Cause retains that provider error so recovery and terminal reporting
// never mistake an approximate local estimate for authoritative rejection.
type ContextLimitExceededError struct {
	EstimatedInputTokens int64
	OutputReserveTokens  int64
	ContextWindowTokens  int64
	Breakdown            RequestTokenEstimate
	// Cause is the original provider context-overflow error. Visible request
	// admission never creates this type from an estimate alone.
	Cause error
}

func (e *ContextLimitExceededError) Error() string {
	return fmt.Sprintf("the provider rejected the request as exceeding its %d-token context window (%d tokens reserved for output; local estimate %d input tokens)", e.ContextWindowTokens, e.OutputReserveTokens, e.EstimatedInputTokens)
}

// Unwrap exposes the originating provider error (if any) so the terminal error
// item and logs can surface the provider's own wording while Error() stays a
// deterministic, provider-independent message.
func (e *ContextLimitExceededError) Unwrap() error { return e.Cause }

// Retryable allows generic error classifiers to identify this as terminal.
func (e *ContextLimitExceededError) Retryable() bool { return false }

// ContextCompactionAdvisory asks the worker to compact a visible request before
// dispatch to a provider known to silently truncate oversized input. It is based
// only on an approximate estimate, is never terminal, and must either lead to
// structured recovery or one explicit request-local fallback dispatch.
type ContextCompactionAdvisory struct {
	EstimatedInputTokens int64
	OutputReserveTokens  int64
	ContextWindowTokens  int64
	Breakdown            RequestTokenEstimate
}

func (e *ContextCompactionAdvisory) Error() string {
	return fmt.Sprintf("request is estimated at %d input tokens plus %d reserved output tokens against a %d-token context window; conservative compaction is advised", e.EstimatedInputTokens, e.OutputReserveTokens, e.ContextWindowTokens)
}

// UnknownContextLimitError reports that admission could not prove the request
// fits because its context window is unknown.
type UnknownContextLimitError struct {
	ContextWindowTokens int64
	OutputReserveTokens int64
}

func (e *UnknownContextLimitError) Error() string {
	return fmt.Sprintf("cannot admit request: context limits are unknown for this model (context window %d, output reserve %d). Check the model id is one the provider reports, or refresh the provider's model list in settings", e.ContextWindowTokens, e.OutputReserveTokens)
}

// Retryable allows generic error classifiers to identify this as terminal.
func (e *UnknownContextLimitError) Retryable() bool { return false }

// InvalidOutputReserveError reports model limits which leave no room for input.
type InvalidOutputReserveError struct {
	OutputReserveTokens int64
	ContextWindowTokens int64
}

func (e *InvalidOutputReserveError) Error() string {
	return fmt.Sprintf("cannot admit request: output reserve %d must be smaller than context window %d", e.OutputReserveTokens, e.ContextWindowTokens)
}

// Retryable allows generic error classifiers to identify this as terminal.
func (e *InvalidOutputReserveError) Retryable() bool { return false }

// SaturatingAdd returns a+b clamped to the int64 range instead of overflowing.
// Exported as the single home for saturating token arithmetic shared by the
// registry and the worker's compaction budgets.
func SaturatingAdd(a, b int64) int64 {
	if b > 0 && a > math.MaxInt64-b {
		return math.MaxInt64
	}
	if b < 0 && a < math.MinInt64-b {
		return math.MinInt64
	}
	return a + b
}

// approximateTokenCount is deliberately conservative across common BPE
// tokenizers. It is an advisory planning heuristic, not proof that request
// content fits or exceeds a provider's context window. Natural ASCII runs and
// repeated-punctuation runs receive modest compression, while mixed punctuation,
// long opaque strings, CJK, and symbols are charged at their denser rates.
//
// Calibrated against a cl100k golden corpus (admission_golden_test.go). Two
// rates are true per-byte maxima for byte-level BPE, which emits at most one
// token per input byte: non-ASCII runes are charged their UTF-8 byte length,
// and long (>16-char) ASCII alphanumeric runs one token per byte. This is NOT
// an unconditional upper bound, though: short alphanumeric runs are charged
// ~1/3 token per byte, so content segmented into ≤16-char chunks by punctuation
// (UUIDs, dotted/snake ids, hex columns, minified JSON keys) can tokenize near
// 1/byte and under-count without a fixed ceiling. That drift is left for
// context recovery to catch, not a guarantee admission proves away.
func approximateTokenCount(text string) int64 {
	var counter approximateTokenCounter
	for _, r := range text {
		counter.add(r)
	}
	return counter.total()
}

const (
	runAlphaNumeric uint8 = iota + 1
	runWhitespace
	runRepeatedPunct
)

type approximateTokenCounter struct {
	tokens    int64
	runLength int64
	runKind   uint8
	runRune   rune
}

func (c *approximateTokenCounter) add(r rune) {
	if r == utf8.RuneError {
		// U+FFFD, either literal or produced per invalid input byte by Go's
		// UTF-8 decoding. json.Marshal replaces invalid bytes with U+FFFD on
		// the wire too, so this is what the provider tokenizes; measured 1
		// token alone and 0.25/char in runs (cl100k). Charging its 3-byte
		// UTF-8 length tripled the estimate for binary junk (the
		// lone-surrogate adversarial case), so charge the measured maximum.
		c.flushRun()
		c.tokens = SaturatingAdd(c.tokens, 1)
		return
	}

	var kind uint8
	if r < utf8.RuneSelf {
		switch {
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			kind = runAlphaNumeric
		case unicode.IsSpace(r):
			kind = runWhitespace
		default:
			// ASCII punctuation/symbols: only *identical* consecutive runes
			// merge into a run (flushRun charges a compressed rate); a rune
			// differing from its predecessor flushes and starts a new run, so
			// mixed punctuation stays at one token per rune.
			kind = runRepeatedPunct
		}
	}
	if kind != 0 {
		if c.runKind != kind || (kind == runRepeatedPunct && c.runRune != r) {
			c.flushRun()
			c.runKind = kind
			c.runRune = r
		}
		c.runLength = SaturatingAdd(c.runLength, 1)
		return
	}

	c.flushRun()
	// Every other non-ASCII rune costs its UTF-8 byte length: the provable
	// maximum for byte-level BPE (measured: common CJK ~1.75 tokens/char, rare
	// glyphs ~2.5, emoji ~2–3, of a 3–4 byte ceiling).
	c.tokens = SaturatingAdd(c.tokens, int64(utf8.RuneLen(r)))
}

func (c *approximateTokenCounter) flushRun() {
	if c.runLength == 0 {
		return
	}
	var tokens int64
	switch {
	case c.runKind == runAlphaNumeric && c.runLength <= 16:
		// Prose words: modest compression. Opaque runs this short (pasted ids,
		// keys, hex) tokenize denser — up to ~1/byte — so punctuation-segmented
		// dense content can under-count here without a fixed bound. Context
		// recovery, not admission, is the backstop for that drift.
		tokens = SaturatingAdd(c.runLength, 2) / 3
	case c.runKind == runAlphaNumeric:
		// Hashes, base64, random IDs, and minified data: adversarial
		// alphanumeric content reaches one token per byte in real BPE
		// tokenizers (measured "x9"×2000 and random alnum at exactly 1.0 in
		// cl100k), so charge the provable maximum rather than a density
		// guess.
		tokens = c.runLength
	case c.runKind == runRepeatedPunct:
		// Runs of one repeated punctuation rune (bracket walls in nested
		// JSON, ---- rules, ==== banners) merge aggressively in real BPE
		// vocabularies. The worst measured identical-run rate in cl100k is
		// exactly 0.5/char (brackets, quotes) with most far cheaper ("-"×64
		// is 1 token), so charge 1 + n/2 — never below the measured maximum
		// at any run length, and a single rune stays exactly 1.
		tokens = SaturatingAdd(1, c.runLength/2)
	default:
		// Whitespace: pure runs merge almost entirely in BPE, but
		// alternating mixes measured 0.33 tokens/char in cl100k.
		tokens = SaturatingAdd(c.runLength, 1) / 2
	}
	c.tokens = SaturatingAdd(c.tokens, tokens)
	c.runLength = 0
	c.runKind = 0
	c.runRune = 0
}

func (c approximateTokenCounter) total() int64 {
	c.flushRun()
	return c.tokens
}

func addEstimate(total *int64, field *int64, value int64) {
	*field = SaturatingAdd(*field, value)
	*total = SaturatingAdd(*total, value)
}

func marshaledTokenCount(value any) int64 {
	encoded, err := json.Marshal(value)
	if err != nil {
		return math.MaxInt64
	}
	return approximateTokenCount(string(encoded))
}

// EstimateMessageRequestTokenBreakdown conservatively estimates every shared
// request field, tool and schema, image, chat framing marker, and configured
// provider serialization overhead. Unsupported provider data saturates it.
func EstimateMessageRequestTokenBreakdown(req MessageRequest, providerOverhead int64) RequestTokenEstimate {
	var estimate RequestTokenEstimate
	if req.SystemPrompt != "" {
		addEstimate(&estimate.Total, &estimate.FramingTokens, messageFramingTokens)
		addEstimate(&estimate.Total, &estimate.SystemPromptTokens, approximateTokenCount("system"))
		addEstimate(&estimate.Total, &estimate.SystemPromptTokens, approximateTokenCount(req.SystemPrompt))
	}

	for _, msg := range req.Messages {
		addEstimate(&estimate.Total, &estimate.FramingTokens, messageFramingTokens)
		addEstimate(&estimate.Total, &estimate.MessageTokens, approximateTokenCount(MessageTypeToRole(msg.Type)))
		addEstimate(&estimate.Total, &estimate.MessageTokens, marshaledTokenCount(msg))
		for _, part := range msg.Parts {
			addEstimate(&estimate.Total, &estimate.ImageTokens, estimateImageTokens64(part))
		}
	}

	for _, tool := range req.Tools {
		addEstimate(&estimate.Total, &estimate.ToolTokens, marshaledTokenCount(tool))
	}
	if req.ToolChoice != nil {
		addEstimate(&estimate.Total, &estimate.MetadataTokens, marshaledTokenCount(req.ToolChoice))
	}
	addEstimate(&estimate.Total, &estimate.MetadataTokens, approximateTokenCount(req.ConversationID))
	addEstimate(&estimate.Total, &estimate.MetadataTokens, approximateTokenCount(req.ThreadID))
	if providerOverhead > 0 {
		addEstimate(&estimate.Total, &estimate.ProviderOverheadTokens, providerOverhead)
	}
	return estimate
}

// EstimateMessageRequestTokens estimates the shared request envelope without
// model-specific provider overhead.
func EstimateMessageRequestTokens(req MessageRequest) int64 {
	return EstimateMessageRequestTokenBreakdown(req, 0).Total
}

type admissionProvider struct {
	Provider
	capabilities ModelCapabilities
	contract     BudgetContract
}

func (p *admissionProvider) OpenConversation(ctx context.Context, convID string) (Conversation, error) {
	cv, err := p.Provider.OpenConversation(ctx, convID)
	if err != nil {
		return nil, err
	}
	return &admissionConversation{Conversation: cv, capabilities: p.capabilities, contract: p.contract}, nil
}

type admissionUsageProvider struct {
	*admissionProvider
	usage UsageStatsProvider
}

func (p *admissionUsageProvider) UsageStats(ctx context.Context) (UsageStats, error) {
	return p.usage.UsageStats(ctx)
}

type admissionConversation struct {
	Conversation
	capabilities ModelCapabilities
	contract     BudgetContract
}

// ContextSafetyReserve derives the output reserve for a known context window
// when the model exposes no output limit of its own: a flat 20k for very
// large windows, otherwise a fifth of the window. Exported so providers that
// set their own wire output cap can charge the identical reserve (the wire
// value and the admission reserve must never diverge).
func ContextSafetyReserve(window int64) int64 {
	// Monotone in the window: a fifth for small windows, flat 20k once window/5
	// exceeds 20k (crossover at 100k). This is deliberately monotone — the old
	// step (window/5 up to 200k, then a cliff to 20k) meant a 200,000 window
	// derived 40k but 200,001 derived 20k. The flat ceiling gives more input room
	// in exactly the 100k–200k regime where admission pressure is highest, and
	// 20k stays generous for a reserve the model never reported.
	return min(int64(20_000), max(int64(1), window/5))
}

// DefaultContextCeilingFraction is the share of a model's context window a
// request may occupy before admission asks the caller to compact.
//
// It is deliberately below 1.0, and that is the whole design of automatic
// compaction. Admission is the one place that measures a fully-built request
// against a known window, and it runs before every dispatch — including the
// dispatches between the tool calls of a single turn. Raising the advisory at a
// soft ceiling therefore makes compaction happen while a turn is still working,
// where a smaller transcript still helps it, instead of only after a provider
// rejects a request or after the turn has already settled.
//
// The advisory is a request to reduce, not a refusal: a caller that cannot
// reduce any further re-submits with BypassContextGuard and the request goes
// out. That is safe precisely because the ceiling is soft — there is real window
// left above it — and it is why this single rule also protects providers that
// would silently truncate rather than reject, without a separate policy.
const DefaultContextCeilingFraction = 0.85

// ContextCeiling resolves the input ceiling for a request against a known
// window. A zero fraction selects DefaultContextCeilingFraction; 1.0 asks for
// the hard window (see MessageRequest.ContextCeilingFraction). The result is
// clamped to at least 1 so a tiny window can never produce a ceiling of 0,
// which would advise on every request including the ones compaction emits.
func ContextCeiling(window int64, fraction float64) int64 {
	if fraction <= 0 {
		fraction = DefaultContextCeilingFraction
	}
	if fraction > 1 {
		fraction = 1
	}
	return max(int64(1), int64(float64(window)*fraction))
}

func (cv *admissionConversation) Submit(ctx context.Context, req MessageRequest, callback StructuredStreamCallback) (*StreamResult, error) {
	window := cv.capabilities.ContextWindowTokens
	reserve := cv.contract.OutputReserveTokens
	if reserve <= 0 {
		reserve = cv.capabilities.MaxOutputTokens
	}
	if window <= 0 {
		if cv.contract.AllowUnknownLimits {
			return cv.Conversation.Submit(ctx, req, callback)
		}
		return nil, &UnknownContextLimitError{ContextWindowTokens: window, OutputReserveTokens: reserve}
	}
	if reserve <= 0 {
		reserve = ContextSafetyReserve(window)
	}
	// A per-request output cap (F1: hidden compaction map calls) only ever lowers
	// the wire max_tokens, so charge the smaller reserve to match — the reserve
	// admission charges must never exceed what the wire actually reserves. The
	// invalid-reserve check below runs against this effective reserve.
	if req.MaxOutputTokens > 0 && req.MaxOutputTokens < reserve {
		reserve = req.MaxOutputTokens
	}
	if reserve >= window {
		return nil, &InvalidOutputReserveError{
			OutputReserveTokens: reserve,
			ContextWindowTokens: window,
		}
	}

	breakdown := EstimateMessageRequestTokenBreakdown(req, cv.capabilities.ProviderOverheadTokens)
	if !req.BypassContextGuard && SaturatingAdd(breakdown.Total, reserve) > ContextCeiling(window, req.ContextCeilingFraction) {
		return nil, &ContextCompactionAdvisory{
			EstimatedInputTokens: breakdown.Total,
			OutputReserveTokens:  reserve,
			ContextWindowTokens:  window,
			Breakdown:            breakdown,
		}
	}
	// The estimate cleared the ceiling, so dispatch. It is still only an
	// estimate: a provider that rejects the request anyway is authoritative, and
	// the conversion below hands the worker the same typed error the advisory
	// produces, so both arrive at one compaction path.
	result, err := cv.Conversation.Submit(ctx, req, callback)
	if err != nil && isProviderContextOverflowError(err) {
		// Convert the provider's real rejection into the shared typed error so the
		// worker can recover while retaining the authoritative cause.
		return nil, &ContextLimitExceededError{
			EstimatedInputTokens: breakdown.Total,
			OutputReserveTokens:  reserve,
			ContextWindowTokens:  window,
			Breakdown:            breakdown,
			Cause:                err,
		}
	}
	return result, err
}

// isProviderContextOverflowError reports whether a provider's own error signals
// that the request exceeded the model's context window. Providers surface this
// as an HTTP 400 with heterogeneous wording and no shared structured code, so
// detection is centralized here over a conservative set of signatures rather
// than scattered across the provider adapters. An error that is already a
// ContextLimitExceededError is left alone because it already represents a
// converted provider rejection.
func isProviderContextOverflowError(err error) bool {
	if err == nil {
		return false
	}
	var limit *ContextLimitExceededError
	if errors.As(err, &limit) {
		return false
	}
	msg := strings.ToLower(err.Error())
	// Negative screen first: an OpenAI TPM rate-limit 429 reads "Request too
	// large for gpt-4o ... tokens per min (TPM)", which otherwise matches the
	// "request too large" signature below. A rate limit is retryable and must
	// not be converted into a terminal context-limit error; the worker's
	// rate-limit path handles it. Screen these out before the overflow match.
	for _, rateLimit := range []string{"per min", "tpm", "rate limit", "rate_limit"} {
		if strings.Contains(msg, rateLimit) {
			return false
		}
	}
	for _, signature := range []string{
		"context_length_exceeded",           // OpenAI error code
		"context length",                    // OpenAI/DeepSeek/Mistral "maximum context length is N tokens"
		"context window",                    // OpenAI responses "exceeds the context window of this model"
		"context limit",                     // Anthropic "input length and max_tokens exceed context limit"
		"context size",                      // llama.cpp "request exceeds the available context size"
		"maximum context",                   // OpenAI "This model's maximum context length"
		"maximum prompt length",             // xAI "This model's maximum prompt length is N"
		"prompt is too long",                // Anthropic "prompt is too long: N tokens > M maximum"
		"input is too long",                 // Anthropic (legacy wording)
		"too many tokens",                   // Cohere-style "too many tokens"
		"exceeded model token limit",        // Moonshot/Kimi "Your request exceeded model token limit: N"
		"prompt token count",                // GitHub Copilot "prompt token count of N exceeds the limit of M"
		"exceeds the maximum",               // Gemini "input token count (N) exceeds the maximum number of tokens allowed (M)"
		"reduce the length of the messages", // OpenAI remediation suffix
		"request too large",                 // generic 400 wording (rate limits screened above)
	} {
		if strings.Contains(msg, signature) {
			return true
		}
	}
	return false
}
