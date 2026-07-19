package provider

import (
	"context"
	"errors"
	"fmt"
	"math"
	"testing"
	"time"
)

type admissionTestProvider struct {
	conversation *admissionTestConversation
}

func (p *admissionTestProvider) Name() string { return "admission-test" }
func (p *admissionTestProvider) ListModelsWithInfo(context.Context) ([]ModelInfo, error) {
	return nil, nil
}
func (p *admissionTestProvider) OpenConversation(context.Context, string) (Conversation, error) {
	return p.conversation, nil
}

type admissionTestConversation struct {
	submits   int
	callbacks int
	submitErr error
}

func (cv *admissionTestConversation) Submit(_ context.Context, _ MessageRequest, callback StructuredStreamCallback) (*StreamResult, error) {
	cv.submits++
	if cv.submitErr != nil {
		return nil, cv.submitErr
	}
	if callback != nil {
		cv.callbacks++
		_, _ = callback(StreamChunk{Type: ContentBlockTypeText, Content: "called"})
	}
	return &StreamResult{}, nil
}
func (cv *admissionTestConversation) Subscribe(TurnSink)      {}
func (cv *admissionTestConversation) CacheTTL() time.Duration { return 0 }
func (cv *admissionTestConversation) Cancel()                 {}
func (cv *admissionTestConversation) Close() error            { return nil }

func openAdmissionTestConversation(t *testing.T, cfg Config) (*admissionTestConversation, Conversation) {
	t.Helper()
	wrapped := &admissionTestConversation{}
	name := "admission-test-" + t.Name()
	RegisterProvider(ProviderInfo{Name: name}, func(Config) (Provider, error) {
		return &admissionTestProvider{conversation: wrapped}, nil
	})
	initialized, err := InitializeProvider(name, cfg)
	if err != nil {
		t.Fatal(err)
	}
	conversation, err := initialized.OpenConversation(context.Background(), "conversation")
	if err != nil {
		t.Fatal(err)
	}
	return wrapped, conversation
}

func TestAdmissionConvertsProviderContextOverflowToLimitError(t *testing.T) {
	// F2: a request that passes admission's estimate but is then rejected by the
	// provider for context overflow (an estimate under-count, or a serving window
	// we do not model) must surface a ContextLimitExceededError so the worker can
	// fold history and retry — never an unrecoverable generic error.
	wrapped, conversation := openAdmissionTestConversation(t, Config{
		ModelCapabilities: ModelCapabilities{ContextWindowTokens: 100_000, MaxOutputTokens: 4_000},
	})
	wrapped.submitErr = errors.New("Error code: 400 - input length and max_tokens exceed context limit: this model's maximum context length is 200000 tokens")
	_, err := conversation.Submit(context.Background(), MessageRequest{Messages: []Message{{Type: "user", Content: "hi"}}}, nil)
	var exceeded *ContextLimitExceededError
	if !errors.As(err, &exceeded) {
		t.Fatalf("error = %T %v, want ContextLimitExceededError", err, err)
	}
	if exceeded.ContextWindowTokens != 100_000 {
		t.Fatalf("window = %d, want the model's known window 100000", exceeded.ContextWindowTokens)
	}
	if exceeded.OutputReserveTokens != 4_000 {
		t.Fatalf("reserve = %d, want the model's output reserve 4000", exceeded.OutputReserveTokens)
	}
	if wrapped.submits != 1 {
		t.Fatalf("provider submits = %d, want 1", wrapped.submits)
	}
}

func TestAdmissionLeavesUnrelatedProviderErrorsUnchanged(t *testing.T) {
	// A provider error that is not a context-overflow signal must pass through
	// verbatim so its normal (e.g. rate-limit) classification still applies.
	wrapped, conversation := openAdmissionTestConversation(t, Config{
		ModelCapabilities: ModelCapabilities{ContextWindowTokens: 100_000, MaxOutputTokens: 4_000},
	})
	sentinel := errors.New("Error code: 429 - rate limit exceeded, please retry")
	wrapped.submitErr = sentinel
	_, err := conversation.Submit(context.Background(), MessageRequest{Messages: []Message{{Type: "user", Content: "hi"}}}, nil)
	if !errors.Is(err, sentinel) {
		t.Fatalf("error = %v, want the provider error passed through unchanged", err)
	}
	var exceeded *ContextLimitExceededError
	if errors.As(err, &exceeded) {
		t.Fatal("unrelated provider error was misconverted to ContextLimitExceededError")
	}
}

func TestAdmissionDoesNotConvertTPMRateLimit(t *testing.T) {
	// F3: OpenAI's TPM 429 reads "Request too large for ... tokens per min (TPM)",
	// which contains the "request too large" overflow signature. It is a
	// retryable rate limit, not a context overflow, and must pass through
	// unchanged so the worker's rate-limit path retries it.
	wrapped, conversation := openAdmissionTestConversation(t, Config{
		ModelCapabilities: ModelCapabilities{ContextWindowTokens: 100_000, MaxOutputTokens: 4_000},
	})
	sentinel := errors.New("Error code: 429 - Request too large for gpt-4o in organization on tokens per min (TPM): Limit 30000")
	wrapped.submitErr = sentinel
	_, err := conversation.Submit(context.Background(), MessageRequest{Messages: []Message{{Type: "user", Content: "hi"}}}, nil)
	if !errors.Is(err, sentinel) {
		t.Fatalf("error = %v, want the TPM rate-limit error passed through unchanged", err)
	}
	var exceeded *ContextLimitExceededError
	if errors.As(err, &exceeded) {
		t.Fatal("TPM rate limit was misconverted to ContextLimitExceededError")
	}
	if isProviderContextOverflowError(sentinel) {
		t.Fatal("isProviderContextOverflowError classified a TPM rate limit as overflow")
	}
}

func TestAdmissionContextLimitUnwrapsProviderCause(t *testing.T) {
	// F3: a genuine context-overflow rejection converts to a
	// ContextLimitExceededError whose chain still carries the provider's own
	// wording, so the terminal error item and logs can surface it.
	wrapped, conversation := openAdmissionTestConversation(t, Config{
		ModelCapabilities: ModelCapabilities{ContextWindowTokens: 100_000, MaxOutputTokens: 4_000},
	})
	sentinel := errors.New("Error code: 400 - prompt is too long: 210000 tokens > 200000 maximum")
	wrapped.submitErr = sentinel
	_, err := conversation.Submit(context.Background(), MessageRequest{Messages: []Message{{Type: "user", Content: "hi"}}}, nil)
	var exceeded *ContextLimitExceededError
	if !errors.As(err, &exceeded) {
		t.Fatalf("error = %T %v, want ContextLimitExceededError", err, err)
	}
	if !errors.Is(err, sentinel) {
		t.Fatal("converted error does not unwrap to the original provider error")
	}
	if exceeded.Cause != sentinel {
		t.Fatalf("Cause = %v, want the original provider error", exceeded.Cause)
	}
}

func TestInitializeProviderWrapsEveryStatefulConversation(t *testing.T) {
	var opened []*admissionTestConversation
	name := "admission-stateful-" + t.Name()
	RegisterProvider(ProviderInfo{Name: name}, func(Config) (Provider, error) {
		return &statefulAdmissionTestProvider{opened: &opened}, nil
	})
	initialized, err := InitializeProvider(name, Config{
		ModelCapabilities: ModelCapabilities{ContextWindowTokens: 100},
		BudgetContract:    BudgetContract{OutputReserveTokens: 20},
	})
	if err != nil {
		t.Fatal(err)
	}

	for _, convID := range []string{"first", "second"} {
		conversation, openErr := initialized.OpenConversation(context.Background(), convID)
		if openErr != nil {
			t.Fatal(openErr)
		}
		_, submitErr := conversation.Submit(context.Background(), MessageRequest{
			Messages: []Message{{Type: "user", Content: "stateful " + convID + " " + string(make([]byte, 200))}},
		}, nil)
		var exceeded *ContextLimitExceededError
		if !errors.As(submitErr, &exceeded) {
			t.Fatalf("%s error = %T %v, want ContextLimitExceededError", convID, submitErr, submitErr)
		}
	}
	if len(opened) != 2 {
		t.Fatalf("opened conversations = %d, want 2", len(opened))
	}
	for i, conversation := range opened {
		if conversation.submits != 0 {
			t.Fatalf("underlying conversation %d submits = %d, want 0", i, conversation.submits)
		}
	}
}

type statefulAdmissionTestProvider struct {
	opened *[]*admissionTestConversation
}

func (p *statefulAdmissionTestProvider) Name() string { return "stateful-admission-test" }
func (p *statefulAdmissionTestProvider) ListModelsWithInfo(context.Context) ([]ModelInfo, error) {
	return nil, nil
}
func (p *statefulAdmissionTestProvider) OpenConversation(context.Context, string) (Conversation, error) {
	conversation := &admissionTestConversation{}
	*p.opened = append(*p.opened, conversation)
	return conversation, nil
}

func TestAdmissionExactFitAndOneTokenOver(t *testing.T) {
	req := MessageRequest{SystemPrompt: "system", Messages: []Message{{Type: "user", Content: "hello"}}}
	estimated := EstimateMessageRequestTokens(req)
	const reserve int64 = 17

	wrapped, exact := openAdmissionTestConversation(t, Config{
		ModelCapabilities: ModelCapabilities{ContextWindowTokens: estimated + reserve},
		BudgetContract:    BudgetContract{OutputReserveTokens: reserve},
	})
	if _, err := exact.Submit(context.Background(), req, nil); err != nil {
		t.Fatalf("exact fit rejected: %v", err)
	}
	if wrapped.submits != 1 {
		t.Fatalf("wrapped submits = %d, want 1", wrapped.submits)
	}

	wrapped, over := openAdmissionTestConversation(t, Config{
		ModelCapabilities: ModelCapabilities{ContextWindowTokens: estimated + reserve - 1},
		BudgetContract:    BudgetContract{OutputReserveTokens: reserve},
	})
	callbackCalls := 0
	_, err := over.Submit(context.Background(), req, func(StreamChunk) (*ToolResult, error) {
		callbackCalls++
		return nil, nil
	})
	var exceeded *ContextLimitExceededError
	if !errors.As(err, &exceeded) {
		t.Fatalf("error = %T %v, want ContextLimitExceededError", err, err)
	}
	if exceeded.Retryable() {
		t.Fatal("exceeded error must be non-retryable")
	}
	if wrapped.submits != 0 || wrapped.callbacks != 0 || callbackCalls != 0 {
		t.Fatalf("rejection invoked wrapped path: submits=%d wrapped callbacks=%d callbacks=%d", wrapped.submits, wrapped.callbacks, callbackCalls)
	}
}

func TestAdmissionAdmitsTinyDimensionImageIgnoringByteLength(t *testing.T) {
	// F1: a resolved image is charged by its pixel estimate, never its raw byte
	// length. A 1×1 image carrying a large Data blob charges the flat floor and
	// comfortably fits, so admission must dispatch it rather than hard-fail an
	// image-bearing turn on an otherwise empty context.
	req := MessageRequest{Messages: []Message{{
		Type:  "user",
		Parts: []MediaPart{{Type: "image", Width: 1, Height: 1, Data: make([]byte, 300_000)}},
	}}}
	wrapped, conversation := openAdmissionTestConversation(t, Config{
		ModelCapabilities: ModelCapabilities{ContextWindowTokens: 9_000},
		BudgetContract:    BudgetContract{OutputReserveTokens: 100},
	})
	if _, err := conversation.Submit(context.Background(), req, nil); err != nil {
		t.Fatalf("Submit() error = %v, want the image admitted", err)
	}
	if wrapped.submits != 1 {
		t.Fatalf("wrapped submits = %d, want 1", wrapped.submits)
	}
}

func TestAdmissionUnknownLimitsFailClosedUnlessExplicitlyAllowed(t *testing.T) {
	wrapped, guarded := openAdmissionTestConversation(t, Config{})
	_, err := guarded.Submit(context.Background(), MessageRequest{}, nil)
	var unknown *UnknownContextLimitError
	if !errors.As(err, &unknown) {
		t.Fatalf("error = %T %v, want UnknownContextLimitError", err, err)
	}
	if unknown.Retryable() {
		t.Fatal("unknown-limit error must be non-retryable")
	}
	if wrapped.submits != 0 {
		t.Fatalf("wrapped submits = %d, want 0", wrapped.submits)
	}

	wrapped, allowed := openAdmissionTestConversation(t, Config{
		BudgetContract: BudgetContract{AllowUnknownLimits: true},
	})
	if _, err := allowed.Submit(context.Background(), MessageRequest{}, nil); err != nil {
		t.Fatalf("explicit unknown-limit opt-in rejected: %v", err)
	}
	if wrapped.submits != 1 {
		t.Fatalf("wrapped submits = %d, want 1", wrapped.submits)
	}
}

func TestAdmissionRejectsOutputReserveAtOrAboveContextWindow(t *testing.T) {
	for _, reserve := range []int64{100, 101} {
		t.Run(fmt.Sprintf("reserve_%d", reserve), func(t *testing.T) {
			wrapped, conversation := openAdmissionTestConversation(t, Config{
				ModelCapabilities: ModelCapabilities{ContextWindowTokens: 100},
				BudgetContract:    BudgetContract{OutputReserveTokens: reserve},
			})
			_, err := conversation.Submit(context.Background(), MessageRequest{}, nil)
			var invalid *InvalidOutputReserveError
			if !errors.As(err, &invalid) {
				t.Fatalf("error = %T %v, want InvalidOutputReserveError", err, err)
			}
			if invalid.ContextWindowTokens != 100 || invalid.OutputReserveTokens != reserve {
				t.Fatalf("typed fields = %+v, want window 100 and reserve %d", invalid, reserve)
			}
			if invalid.Retryable() {
				t.Fatal("invalid reserve error must be non-retryable")
			}
			if wrapped.submits != 0 {
				t.Fatalf("wrapped submits = %d, want 0", wrapped.submits)
			}
		})
	}
}

func TestAdmissionUsesCapabilityOutputReserve(t *testing.T) {
	req := MessageRequest{Messages: []Message{{Type: "user", Content: "x"}}}
	estimated := EstimateMessageRequestTokens(req)
	wrapped, conversation := openAdmissionTestConversation(t, Config{
		ModelCapabilities: ModelCapabilities{
			ContextWindowTokens: estimated + 8,
			MaxOutputTokens:     9,
		},
	})
	_, err := conversation.Submit(context.Background(), req, nil)
	var exceeded *ContextLimitExceededError
	if !errors.As(err, &exceeded) {
		t.Fatalf("error = %T %v, want ContextLimitExceededError", err, err)
	}
	if wrapped.submits != 0 {
		t.Fatalf("wrapped submits = %d, want 0", wrapped.submits)
	}
}

// TestAdmissionChargesRequestOutputCapAsReserve pins F1a: a per-request
// MaxOutputTokens lowers the charged reserve to that cap, so a call the full
// capability reserve would reject is admitted, and the reported reserve on a
// genuine overflow is the effective (smaller) value.
func TestAdmissionChargesRequestOutputCapAsReserve(t *testing.T) {
	req := MessageRequest{Messages: []Message{{Type: "user", Content: "x"}}}
	estimated := EstimateMessageRequestTokens(req)

	t.Run("request cap admits what the full reserve would reject", func(t *testing.T) {
		wrapped, conversation := openAdmissionTestConversation(t, Config{
			ModelCapabilities: ModelCapabilities{ContextWindowTokens: estimated + 50, MaxOutputTokens: 100},
		})
		capped := req
		capped.MaxOutputTokens = 30 // effective reserve 30 < 50 headroom → fits
		if _, err := conversation.Submit(context.Background(), capped, nil); err != nil {
			t.Fatalf("request-capped submit rejected: %v", err)
		}
		if wrapped.submits != 1 {
			t.Fatalf("wrapped submits = %d, want 1", wrapped.submits)
		}
	})

	t.Run("overflow error reports the effective reserve", func(t *testing.T) {
		_, conversation := openAdmissionTestConversation(t, Config{
			ModelCapabilities: ModelCapabilities{ContextWindowTokens: estimated + 20, MaxOutputTokens: 100},
		})
		capped := req
		capped.MaxOutputTokens = 30 // effective reserve 30 > 20 headroom → exceeds
		_, err := conversation.Submit(context.Background(), capped, nil)
		var exceeded *ContextLimitExceededError
		if !errors.As(err, &exceeded) {
			t.Fatalf("error = %T %v, want ContextLimitExceededError", err, err)
		}
		if exceeded.OutputReserveTokens != 30 {
			t.Fatalf("reported reserve = %d, want effective request cap 30", exceeded.OutputReserveTokens)
		}
	})
}

func TestAdmissionDerivesOutputReserveFromKnownContext(t *testing.T) {
	tests := []struct {
		name    string
		window  int64
		reserve int64
	}{
		{name: "small context", window: 100_000, reserve: 20_000},
		{name: "sub-crossover context", window: 50_000, reserve: 10_000},
		{name: "monotone flat ceiling at boundary", window: 200_000, reserve: 20_000},
		{name: "large context", window: 200_001, reserve: 20_000},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := ContextSafetyReserve(test.window); got != test.reserve {
				t.Fatalf("ContextSafetyReserve(%d) = %d, want %d", test.window, got, test.reserve)
			}
			wrapped, conversation := openAdmissionTestConversation(t, Config{
				ModelCapabilities: ModelCapabilities{ContextWindowTokens: test.window},
			})
			_, err := conversation.Submit(context.Background(), MessageRequest{}, nil)
			if err != nil {
				t.Fatalf("known context with derived reserve rejected: %v", err)
			}
			if wrapped.submits != 1 {
				t.Fatalf("wrapped submits = %d, want 1", wrapped.submits)
			}
		})
	}
}

func TestEstimateMessageRequestTokensConservativeUnicodeAndOpaqueRuns(t *testing.T) {
	tests := []struct {
		name string
		text string
		min  int64
	}{
		{name: "punctuation", text: "{}[],:/\\!@#$%^&*()", min: 18},
		{name: "hash", text: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", min: 48},
		{name: "CJK", text: "漢字仮名交じり文中文測試", min: 12},
		{name: "emoji", text: "😀🧑🏽‍💻", min: 19},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := approximateTokenCount(test.text); got < test.min {
				t.Fatalf("estimate %d below conservative minimum %d", got, test.min)
			}
		})
	}
}

func TestAdmissionIncludesProviderOverheadAndBreakdown(t *testing.T) {
	req := MessageRequest{Messages: []Message{{Type: "user", Content: "hello"}}}
	base := EstimateMessageRequestTokens(req)
	const overhead int64 = 37
	wrapped, conversation := openAdmissionTestConversation(t, Config{
		ModelCapabilities: ModelCapabilities{
			ContextWindowTokens:    base + overhead,
			ProviderOverheadTokens: overhead,
		},
		BudgetContract: BudgetContract{OutputReserveTokens: 1},
	})
	_, err := conversation.Submit(context.Background(), req, nil)
	var exceeded *ContextLimitExceededError
	if !errors.As(err, &exceeded) {
		t.Fatalf("error = %T %v, want ContextLimitExceededError", err, err)
	}
	if exceeded.Breakdown.ProviderOverheadTokens != overhead || exceeded.Breakdown.Total != base+overhead {
		t.Fatalf("breakdown = %+v, want overhead %d and total %d", exceeded.Breakdown, overhead, base+overhead)
	}
	if wrapped.submits != 0 {
		t.Fatalf("wrapped submits = %d, want 0", wrapped.submits)
	}
}

func TestEstimateMessageRequestTokensCoversCompleteEnvelope(t *testing.T) {
	base := MessageRequest{}
	rich := MessageRequest{
		SystemPrompt:   "system",
		ConversationID: "conversation",
		ThreadID:       "thread",
		ToolChoice:     &ToolChoice{Mode: ToolChoiceTool, Name: "tool"},
		Tools: []ToolDefinition{{
			Name:        "tool",
			Description: "description",
			InputSchema: []byte(`{"type":"object","properties":{"query":{"type":"string"}}}`),
		}},
		Messages: []Message{{
			Type: "tool-use", Content: "content", ProviderData: map[string]any{"signature": "opaque"},
			ToolUseID: "id", ToolName: "tool", ToolInput: map[string]any{"query": "value"},
			IsError: true, ResultType: "action", FullResult: map[string]any{"nested": map[string]any{"value": "full"}},
			ItemID: "item", IsNew: true, IsGlobal: true, Message: "message", Stack: "stack",
			HasRetryButton: true, EventType: "event", Source: "source",
			Parts: []MediaPart{{Type: "image", Mime: "image/png", AssetID: "asset", Width: 1500, Height: 750}},
		}},
	}
	if got, wantMin := EstimateMessageRequestTokens(rich), EstimateMessageRequestTokens(base)+1500; got < wantMin {
		t.Fatalf("rich estimate = %d, want at least %d", got, wantMin)
	}
}

func TestEstimateImageTokensChargesPixelsAndCapsDimensionlessBytes(t *testing.T) {
	tests := []struct {
		name string
		part MediaPart
		want int
	}{
		{
			name: "known dimensions are floored at the flat estimate",
			part: MediaPart{Type: "image", Width: 1, Height: 1},
			want: int(flatImageTokenEstimate),
		},
		{
			name: "known dimensions ignore byte length (F1)",
			part: MediaPart{Type: "image", Width: 1, Height: 1, Data: make([]byte, 8_000)},
			want: int(flatImageTokenEstimate),
		},
		{
			name: "unknown dimensions retain flat fallback floor",
			part: MediaPart{Type: "image"},
			want: int(flatImageTokenEstimate),
		},
		{
			name: "dimensionless mid-size bytes charge byte length",
			part: MediaPart{Type: "image", Mime: "image/webp", Data: make([]byte, 3_000)},
			want: 3_000,
		},
		{
			name: "dimensionless large bytes are capped",
			part: MediaPart{Type: "image", Mime: "image/webp", Data: make([]byte, 32_000)},
			want: int(maxFallbackImageTokens),
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := EstimateImageTokens(test.part); got != test.want {
				t.Fatalf("EstimateImageTokens() = %d, want %d", got, test.want)
			}
		})
	}
}

func TestEstimateMessageRequestTokensChargesImagePixelsNotBytes(t *testing.T) {
	// F1: even a large Data blob must not be charged as tokens when the image's
	// dimensions are known — the pixel estimate (here the flat floor) governs.
	req := MessageRequest{Messages: []Message{{
		Type:  "user",
		Parts: []MediaPart{{Type: "image", Width: 1, Height: 1, Data: make([]byte, 300_000)}},
	}}}
	breakdown := EstimateMessageRequestTokenBreakdown(req, 0)
	if breakdown.ImageTokens != flatImageTokenEstimate {
		t.Fatalf("image tokens = %d, want flat estimate %d (bytes must not be charged)", breakdown.ImageTokens, flatImageTokenEstimate)
	}
	if breakdown.Total < breakdown.ImageTokens {
		t.Fatalf("total = %d, want at least image charge %d", breakdown.Total, breakdown.ImageTokens)
	}
}

func TestEstimateMessageRequestTokensSaturates(t *testing.T) {
	req := MessageRequest{Messages: []Message{{
		Type:  "user",
		Parts: []MediaPart{{Type: "image", Width: math.MaxInt, Height: math.MaxInt}},
	}}}
	if got := EstimateMessageRequestTokens(req); got != math.MaxInt64 {
		t.Fatalf("estimate = %d, want saturation at %d", got, int64(math.MaxInt64))
	}
}

// TestAdmissionRejectsOversizedImageBeforeDispatch covers the media path: an
// attachment whose pixel estimate alone busts the window must be refused
// locally, with the image charge visible in the breakdown — the provider
// never sees the request.
func TestAdmissionRejectsOversizedImageBeforeDispatch(t *testing.T) {
	wrapped, conversation := openAdmissionTestConversation(t, Config{
		ModelCapabilities: ModelCapabilities{ContextWindowTokens: 4_000},
		BudgetContract:    BudgetContract{OutputReserveTokens: 300},
	})
	_, err := conversation.Submit(context.Background(), MessageRequest{Messages: []Message{{
		Type:    "user",
		Content: "what is in this image?",
		Parts:   []MediaPart{{Type: "image", Mime: "image/png", Width: 8_000, Height: 6_000}},
	}}}, nil)
	var limitErr *ContextLimitExceededError
	if !errors.As(err, &limitErr) {
		t.Fatalf("error = %T %v, want ContextLimitExceededError", err, err)
	}
	if want := int64(8_000*6_000) / 750; limitErr.Breakdown.ImageTokens != want {
		t.Fatalf("image tokens = %d, want pixel estimate %d", limitErr.Breakdown.ImageTokens, want)
	}
	if limitErr.EstimatedInputTokens < limitErr.Breakdown.ImageTokens {
		t.Fatalf("estimated input %d does not cover the image charge %d", limitErr.EstimatedInputTokens, limitErr.Breakdown.ImageTokens)
	}
	if wrapped.submits != 0 {
		t.Fatalf("submits = %d, want the request stopped before dispatch", wrapped.submits)
	}
}
