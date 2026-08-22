//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package helpers

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"juggler/cmd/juggler/providers/provider"
	"juggler/cmd/juggler/worker"
)

// MockResponse wraps one canned LLM call outcome. Exactly one of Response,
// Err, or RateLimit should be non-nil. StreamScript, when set, overrides the
// default block-by-block streaming with a hand-tuned sequence of events —
// used to reproduce partial-token streaming, mid-stream tool-input deltas,
// or mid-stream errors.
type MockResponse struct {
	Response     *worker.LLMResponse
	Err          error
	RateLimit    *worker.RateLimitError
	StreamScript []StreamEvent
}

// StreamEvent is one item in a hand-tuned stream script. If Err is non-nil the
// stream callback is followed by returning that error from the LLM call. If
// Delay is non-zero the mock sleeps before emitting the chunk — useful for
// driving cancel/timeout paths.
type StreamEvent struct {
	Chunk worker.StreamChunk
	Err   error
	Delay time.Duration
}

// ----- MockResponse builders --------------------------------------------------

// PlainResponse wraps a normal LLMResponse with default block-by-block streaming.
func PlainResponse(resp *worker.LLMResponse) MockResponse {
	return MockResponse{Response: resp}
}

// RateLimit injects a RateLimitError that the worker's callLLMWithRetry will
// observe and retry after wait. Subsequent responses in the sequence are used
// for the retried call.
func RateLimit(wait time.Duration, message string) MockResponse {
	return MockResponse{RateLimit: &worker.RateLimitError{Wait: wait, Message: message}}
}

// ErrorMock returns a generic non-rate-limit error from the LLM call.
func ErrorMock(message string) MockResponse {
	return MockResponse{Err: fmt.Errorf("mock LLM error: %s", message)}
}

// StreamedText emits each chunk as a separate text StreamChunk — reproduces
// real provider token-by-token streaming. The combined text also forms the
// returned LLMResponse so post-stream assertions see the full content.
func StreamedText(chunks ...string) MockResponse {
	full := ""
	events := make([]StreamEvent, 0, len(chunks))
	for _, c := range chunks {
		full += c
		events = append(events, StreamEvent{Chunk: worker.StreamChunk{Type: "text", Content: c}})
	}
	return MockResponse{
		Response: &worker.LLMResponse{
			Blocks:     []worker.LLMResponseBlock{{Type: "text", Content: full}},
			StopReason: "end_turn",
		},
		StreamScript: events,
	}
}

// StreamedToolUse emits inputDeltas as a series of partial tool_use chunks
// before the final complete tool_use chunk + LLMResponse — reproduces the real
// Anthropic input_json_delta stream where the worker sees partial JSON before
// the args are complete. inputDeltas are emitted as Content on tool_use chunks
// so consumers can verify the streamer's accumulator handles them.
func StreamedToolUse(id, name string, inputDeltas []string, finalInput any) MockResponse {
	inputJSON, _ := json.Marshal(finalInput)
	events := make([]StreamEvent, 0, len(inputDeltas)+1)
	for _, d := range inputDeltas {
		events = append(events, StreamEvent{Chunk: worker.StreamChunk{Type: "tool_use", Content: d}})
	}
	events = append(events, StreamEvent{Chunk: worker.StreamChunk{Type: "tool_use"}})
	return MockResponse{
		Response: &worker.LLMResponse{
			Blocks: []worker.LLMResponseBlock{{
				Type: "tool_use", ID: id, Name: name, Input: inputJSON,
			}},
			StopReason: "tool_use",
		},
		StreamScript: events,
	}
}

// MidStreamError emits the preludeChunks then aborts with err, exercising the
// worker's mid-stream-failure path. The accompanying LLMResponse is empty
// since the call returns an error.
func MidStreamError(err error, preludeChunks ...worker.StreamChunk) MockResponse {
	events := make([]StreamEvent, 0, len(preludeChunks)+1)
	for _, c := range preludeChunks {
		events = append(events, StreamEvent{Chunk: c})
	}
	events = append(events, StreamEvent{Err: err})
	return MockResponse{Err: err, StreamScript: events}
}

// WithUsage stamps token counts onto a response's LLMResponse so cost-tracking
// tests can assert against the mock without depending on a real provider.
func WithUsage(m MockResponse, inputTokens, outputTokens, cachedTokens int) MockResponse {
	if m.Response == nil {
		return m
	}
	m.Response.InputTokens = inputTokens
	m.Response.OutputTokens = outputTokens
	m.Response.CachedTokens = provider.Reported(cachedTokens)
	return m
}

// WithProgressTokens prepends progress chunks carrying running output-token
// estimates to the response's stream script — matches the real anthropic
// progress emitter.
func WithProgressTokens(m MockResponse, samples ...int) MockResponse {
	progress := make([]StreamEvent, 0, len(samples))
	for _, n := range samples {
		progress = append(progress, StreamEvent{Chunk: worker.StreamChunk{Type: "progress", OutputTokens: n}})
	}
	if m.StreamScript == nil {
		m.StreamScript = progress
	} else {
		m.StreamScript = append(progress, m.StreamScript...)
	}
	return m
}

// runMockStream emits the stream chunks for a single call. If script is non-nil
// it is played verbatim; otherwise the LLMResponse's blocks are streamed using
// the original block-by-block default. Returns a non-nil error if the script
// contains a terminal StreamEvent.Err.
func runMockStream(streamCB func(worker.StreamChunk), response *worker.LLMResponse, script []StreamEvent) error {
	if streamCB == nil {
		return nil
	}
	if script != nil {
		for _, ev := range script {
			if ev.Delay > 0 {
				time.Sleep(ev.Delay)
			}
			if ev.Err != nil {
				return ev.Err
			}
			streamCB(ev.Chunk)
		}
		return nil
	}
	if response == nil {
		return nil
	}
	for _, block := range response.Blocks {
		switch {
		case block.Type == "text" && block.Content != "":
			streamCB(worker.StreamChunk{Type: "text", Content: block.Content})
		case block.Type == "thinking" && block.Thinking != "":
			streamCB(worker.StreamChunk{Type: "thinking", Content: block.Thinking})
		case block.Type == "tool_use":
			streamCB(worker.StreamChunk{Type: "tool_use"})
		}
	}
	return nil
}

// LLMSequence represents a sequence of LLM responses to be returned in order.
// Each call to the mock LLM will return the next response in the sequence.
// State is owned by an internal goroutine and accessed via channels.
type LLMSequence struct {
	callOp  chan llmCallOp
	countOp chan llmCountOp
	resetOp chan llmResetOp
	reqsOp  chan llmReqsOp
}

type llmCallOp struct {
	req  json.RawMessage
	resp chan llmCallResult
}

// llmReqsOp reads the requests captured so far (one per call, in call order).
type llmReqsOp struct {
	resp chan []json.RawMessage
}

type llmCallResult struct {
	mock MockResponse
	err  error
}

type llmCountOp struct {
	resp chan int
}

type llmResetOp struct {
	done chan struct{}
}

// NewLLMSequence creates a new sequence of LLM responses.
func NewLLMSequence(responses ...*worker.LLMResponse) *LLMSequence {
	mocks := make([]MockResponse, len(responses))
	for i, r := range responses {
		mocks[i] = PlainResponse(r)
	}
	return NewMockSequence(mocks...)
}

// NewMockSequence creates a sequence whose entries can be any MockResponse —
// plain responses, rate-limit errors, mid-stream errors, or stream-scripted
// responses. Used for tests that need richer behaviour than NewLLMSequence's
// pure-success path.
func NewMockSequence(responses ...MockResponse) *LLMSequence {
	seq := &LLMSequence{
		callOp:  make(chan llmCallOp),
		countOp: make(chan llmCountOp),
		resetOp: make(chan llmResetOp),
		reqsOp:  make(chan llmReqsOp),
	}

	go func() {
		callCount := 0
		resps := responses
		// requests captures the raw request JSON the worker handed the mock on
		// each call, in call order, so a test can assert what the "provider"
		// actually received (e.g. that a user message carried image parts).
		var requests []json.RawMessage

		for {
			select {
			case op := <-seq.callOp:
				if op.req != nil {
					requests = append(requests, op.req)
				}
				if callCount >= len(resps) {
					op.resp <- llmCallResult{
						err: fmt.Errorf("LLMSequence exhausted: expected %d calls, got %d", len(resps), callCount+1),
					}
				} else {
					r := resps[callCount]
					callCount++
					op.resp <- llmCallResult{mock: r}
				}
			case op := <-seq.countOp:
				op.resp <- callCount
			case op := <-seq.reqsOp:
				out := make([]json.RawMessage, len(requests))
				copy(out, requests)
				op.resp <- out
			case op := <-seq.resetOp:
				callCount = 0
				requests = nil
				op.done <- struct{}{}
			}
		}
	}()

	return seq
}

// AsCallFunc converts the sequence to a function compatible with worker.SetLLMCaller.
func (seq *LLMSequence) AsCallFunc() func(context.Context, json.RawMessage, func(worker.StreamChunk)) (*worker.LLMResponse, error) {
	return func(ctx context.Context, req json.RawMessage, streamCB func(worker.StreamChunk)) (*worker.LLMResponse, error) {
		op := llmCallOp{req: req, resp: make(chan llmCallResult, 1)}
		seq.callOp <- op
		result := <-op.resp

		if result.err != nil {
			return nil, result.err
		}
		if result.mock.RateLimit != nil {
			return nil, result.mock.RateLimit
		}
		if result.mock.Err != nil {
			// Even error responses can have a stream prelude (MidStreamError).
			_ = runMockStream(streamCB, result.mock.Response, result.mock.StreamScript)
			return nil, result.mock.Err
		}
		if err := runMockStream(streamCB, result.mock.Response, result.mock.StreamScript); err != nil {
			return nil, err
		}
		return result.mock.Response, nil
	}
}

// CallCount returns the number of times the mock LLM has been called.
func (seq *LLMSequence) CallCount() int {
	op := llmCountOp{resp: make(chan int, 1)}
	seq.countOp <- op
	return <-op.resp
}

// Requests returns the raw request JSON captured for every call so far, in
// call order. Each element is the exact payload the worker handed the mock
// (what the real provider would have received) — use ImagePartsInRequest to
// pull image attachment parts out of a user message for assertions.
func (seq *LLMSequence) Requests() []json.RawMessage {
	op := llmReqsOp{resp: make(chan []json.RawMessage, 1)}
	seq.reqsOp <- op
	return <-op.resp
}

// LastRequest returns the most recently captured request, or nil if the mock
// has not been called yet.
func (seq *LLMSequence) LastRequest() json.RawMessage {
	reqs := seq.Requests()
	if len(reqs) == 0 {
		return nil
	}
	return reqs[len(reqs)-1]
}

// ImagePartsInRequest extracts the image "parts" of every user message in a
// captured LLM request. Each returned map is one image part (carrying at least
// "type":"image" plus "assetId"/"mime"), flattened across all user messages —
// so a test can assert an attachment reached the provider without re-walking
// the request shape. Non-image parts and non-user messages are ignored;
// malformed requests yield an empty slice.
func ImagePartsInRequest(req json.RawMessage) []map[string]any {
	var parsed struct {
		Messages []map[string]any `json:"messages"`
	}
	if err := json.Unmarshal(req, &parsed); err != nil {
		return nil
	}
	var out []map[string]any
	for _, msg := range parsed.Messages {
		if t, _ := msg["type"].(string); t != "user" {
			continue
		}
		rawParts, ok := msg["parts"].([]any)
		if !ok {
			continue
		}
		for _, p := range rawParts {
			part, ok := p.(map[string]any)
			if !ok {
				continue
			}
			if pt, _ := part["type"].(string); pt == "image" {
				out = append(out, part)
			}
		}
	}
	return out
}

// Reset resets the call count to zero, allowing the sequence to be reused.
func (seq *LLMSequence) Reset() {
	op := llmResetOp{done: make(chan struct{}, 1)}
	seq.resetOp <- op
	<-op.done
}

// TextResponse creates an LLM response with only text content.
func TextResponse(text string) *worker.LLMResponse {
	return &worker.LLMResponse{
		Blocks: []worker.LLMResponseBlock{
			{
				Type:    "text",
				Content: text,
			},
		},
		StopReason: "end_turn",
	}
}

// ToolUseResponse creates an LLM response with a single tool use.
func ToolUseResponse(toolUseID, toolName string, input any) *worker.LLMResponse {
	inputJSON, _ := json.Marshal(input)
	return &worker.LLMResponse{
		Blocks: []worker.LLMResponseBlock{
			{
				Type:  "tool_use",
				ID:    toolUseID,
				Name:  toolName,
				Input: json.RawMessage(inputJSON),
			},
		},
		StopReason: "tool_use",
	}
}

// ToolUse represents a tool use for building multi-tool responses.
type ToolUse struct {
	ID    string
	Name  string
	Input any
}

// MultiToolResponse creates an LLM response with multiple tool uses.
func MultiToolResponse(tools ...ToolUse) *worker.LLMResponse {
	blocks := make([]worker.LLMResponseBlock, len(tools))
	for i, tool := range tools {
		inputJSON, _ := json.Marshal(tool.Input)
		blocks[i] = worker.LLMResponseBlock{
			Type:  "tool_use",
			ID:    tool.ID,
			Name:  tool.Name,
			Input: json.RawMessage(inputJSON),
		}
	}

	return &worker.LLMResponse{
		Blocks:     blocks,
		StopReason: "tool_use",
	}
}

// TextAndToolResponse creates an LLM response with both text and tool uses.
// This is common when the LLM explains what it's about to do before calling tools.
func TextAndToolResponse(text string, tools ...ToolUse) *worker.LLMResponse {
	blocks := make([]worker.LLMResponseBlock, 1+len(tools))
	blocks[0] = worker.LLMResponseBlock{
		Type:    "text",
		Content: text,
	}

	for i, tool := range tools {
		inputJSON, _ := json.Marshal(tool.Input)
		blocks[i+1] = worker.LLMResponseBlock{
			Type:  "tool_use",
			ID:    tool.ID,
			Name:  tool.Name,
			Input: json.RawMessage(inputJSON),
		}
	}

	return &worker.LLMResponse{
		Blocks:     blocks,
		StopReason: "tool_use",
	}
}

// ThinkingResponse creates an LLM response with thinking content.
func ThinkingResponse(thinking string) *worker.LLMResponse {
	return &worker.LLMResponse{
		Blocks: []worker.LLMResponseBlock{
			{
				Type:     "thinking",
				Thinking: thinking,
			},
		},
		StopReason: "end_turn",
	}
}

// ErrorResponse creates an LLM response that simulates an API error.
// Note: This returns an error, not a *worker.LLMResponse.
func ErrorResponse(message string) error {
	return fmt.Errorf("mock LLM error: %s", message)
}

// ConditionalSequence allows different responses based on the request content.
// This is useful for tests that need to handle different user inputs.
// State is owned by an internal goroutine and accessed via channels.
type ConditionalSequence struct {
	conditions []conditionHandler
	callOp     chan condCallOp
}

type conditionHandler struct {
	matcher func(json.RawMessage) bool
	mock    MockResponse
}

type condCallOp struct {
	req  json.RawMessage
	resp chan condCallResult
}

type condCallResult struct {
	mock MockResponse
	err  error
}

// NewConditionalSequence creates a new conditional response handler.
func NewConditionalSequence() *ConditionalSequence {
	cs := &ConditionalSequence{
		conditions: make([]conditionHandler, 0),
		callOp:     make(chan condCallOp),
	}

	go func() {
		for op := range cs.callOp {
			var result condCallResult
			matched := false
			for _, handler := range cs.conditions {
				if handler.matcher(op.req) {
					result = condCallResult{mock: handler.mock}
					matched = true
					break
				}
			}
			if !matched {
				result = condCallResult{err: fmt.Errorf("no matching condition in ConditionalSequence")}
			}
			op.resp <- result
		}
	}()

	return cs
}

// When adds a conditional response. The matcher function receives the request
// and returns true if this response should be used.
func (cs *ConditionalSequence) When(matcher func(json.RawMessage) bool, response *worker.LLMResponse) *ConditionalSequence {
	return cs.WhenMock(matcher, PlainResponse(response))
}

// WhenMock is the MockResponse-typed variant of When, for rate-limit
// injection, mid-stream errors, or scripted streaming.
func (cs *ConditionalSequence) WhenMock(matcher func(json.RawMessage) bool, m MockResponse) *ConditionalSequence {
	cs.conditions = append(cs.conditions, conditionHandler{matcher: matcher, mock: m})
	return cs
}

// AsCallFunc converts the conditional sequence to a function compatible with worker.SetLLMCaller.
func (cs *ConditionalSequence) AsCallFunc() func(context.Context, json.RawMessage, func(worker.StreamChunk)) (*worker.LLMResponse, error) {
	return func(ctx context.Context, req json.RawMessage, streamCB func(worker.StreamChunk)) (*worker.LLMResponse, error) {
		op := condCallOp{
			req:  req,
			resp: make(chan condCallResult, 1),
		}
		cs.callOp <- op
		result := <-op.resp

		if result.err != nil {
			return nil, result.err
		}
		if result.mock.RateLimit != nil {
			return nil, result.mock.RateLimit
		}
		if result.mock.Err != nil {
			_ = runMockStream(streamCB, result.mock.Response, result.mock.StreamScript)
			return nil, result.mock.Err
		}
		if err := runMockStream(streamCB, result.mock.Response, result.mock.StreamScript); err != nil {
			return nil, err
		}
		return result.mock.Response, nil
	}
}

// Helper functions for common request matchers

// ContainsText returns a matcher that checks if the request contains specific text.
func ContainsText(text string) func(json.RawMessage) bool {
	return func(req json.RawMessage) bool {
		var parsed map[string]any
		if err := json.Unmarshal(req, &parsed); err != nil {
			return false
		}
		// Check if any message in the request contains the text
		if messages, ok := parsed["messages"].([]any); ok {
			for _, msg := range messages {
				if msgMap, ok := msg.(map[string]any); ok {
					if content, ok := msgMap["content"].(string); ok {
						return contains(content, text)
					}
				}
			}
		}
		return false
	}
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || anySubstring(s, substr))
}

func anySubstring(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}

// AlwaysMatch returns a matcher that always returns true (fallback case).
func AlwaysMatch() func(json.RawMessage) bool {
	return func(req json.RawMessage) bool {
		return true
	}
}
