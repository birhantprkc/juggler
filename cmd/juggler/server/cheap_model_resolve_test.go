//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/providers/provider"
	"juggler/internal/userpaths/userpathstest"
)

// registerCheapTestProvider registers a throwaway provider whose Info advertises
// a CheapModel hint, so resolveCheapModel's auto-derive path has something to
// look up. Registration is a package-global map write with a stable name, so
// repeated calls across tests just overwrite with identical data.
func registerCheapTestProvider(name, cheapModel string) {
	provider.RegisterProvider(
		provider.ProviderInfo{Name: name, CheapModel: cheapModel},
		func(provider.Config) (provider.Provider, error) { return nil, nil },
	)
}

// registerFreeToRunTestProvider registers a throwaway provider that bills
// nothing per token and names no cheap tier — the shape of a local runtime,
// where the catalog is whatever the user happens to have loaded.
func registerFreeToRunTestProvider(name string) {
	provider.RegisterProvider(
		provider.ProviderInfo{Name: name, FreeToRun: true},
		func(provider.Config) (provider.Provider, error) { return nil, nil },
	)
}

// newCheapResolveServer builds a minimal Server with the providers-ready gate
// open and a live provider list installed, plus an isolated cheap-model store.
func newCheapResolveServer(t *testing.T, providers []ProviderStatus) *Server {
	t.Helper()
	userpathstest.Isolate(t)
	store, err := core.NewCheapModelStore()
	if err != nil {
		t.Fatalf("NewCheapModelStore: %v", err)
	}
	// The default-model store is wired too: resolution consults the default
	// model's provider when the primary's has no cheap tier of its own.
	defaults, err := core.NewDefaultModelStore()
	if err != nil {
		t.Fatalf("NewDefaultModelStore: %v", err)
	}
	s := &Server{
		providerRefresh: providerRefresh{providersReady: make(chan struct{})},
		serverStores:    serverStores{cheapModelStore: store, defaultModelStore: defaults},
	}
	s.providersList.Store(&providers)
	s.markProvidersReady()
	return s
}

// pinCheap stores an explicit cheap-model pin.
func pinCheap(t *testing.T, s *Server, ref core.ModelRef) {
	t.Helper()
	if err := s.cheapModelStore.Save(core.CheapModelSetting{ModelRef: ref}); err != nil {
		t.Fatalf("Save: %v", err)
	}
}

// turnCheapOff records the explicit "no cheap model" decision.
func turnCheapOff(t *testing.T, s *Server) {
	t.Helper()
	if err := s.cheapModelStore.Save(core.CheapModelSetting{Disabled: true}); err != nil {
		t.Fatalf("Save(disabled): %v", err)
	}
}

// pinDefault stores an explicit default model.
func pinDefault(t *testing.T, s *Server, ref core.ModelRef) {
	t.Helper()
	if err := s.defaultModelStore.Save(ref); err != nil {
		t.Fatalf("Save(default): %v", err)
	}
}

func TestResolveCheapModelExplicitAvailable(t *testing.T) {
	registerCheapTestProvider("cheaptest", "cheap-mini")
	s := newCheapResolveServer(t, []ProviderStatus{
		{Name: "cheaptest", Available: true, ModelsWithContext: []ModelWithContext{{ID: "cheap-mini"}, {ID: "big"}}},
	})
	pinCheap(t, s, core.ModelRef{Provider: "cheaptest", Model: "big", Thinking: "off"})
	got, ok := s.resolveCheapModel(context.Background(), core.ModelRef{})
	if !ok {
		t.Fatal("expected explicit pin to resolve")
	}
	want := core.ModelRef{Provider: "cheaptest", Model: "big", Thinking: "off"}
	if got != want {
		t.Fatalf("resolveCheapModel = %+v, want %+v", got, want)
	}
}

func TestResolveCheapModelExplicitUnavailableFallsThrough(t *testing.T) {
	registerCheapTestProvider("cheaptest", "cheap-mini")
	s := newCheapResolveServer(t, []ProviderStatus{
		{Name: "cheaptest", Available: true, ModelsWithContext: []ModelWithContext{{ID: "cheap-mini"}}},
	})
	// Pin a provider that isn't in the live list at all.
	pinCheap(t, s, core.ModelRef{Provider: "gone", Model: "ghost"})
	got, ok := s.resolveCheapModel(context.Background(), core.ModelRef{Provider: "cheaptest", Model: "big"})
	if !ok {
		t.Fatal("expected fall-through to auto-derive")
	}
	want := core.ModelRef{Provider: "cheaptest", Model: "cheap-mini"}
	if got != want {
		t.Fatalf("resolveCheapModel = %+v, want %+v", got, want)
	}
}

func TestResolveCheapModelAutoDeriveExact(t *testing.T) {
	registerCheapTestProvider("cheaptest", "cheap-mini")
	s := newCheapResolveServer(t, []ProviderStatus{
		{Name: "cheaptest", Available: true, ModelsWithContext: []ModelWithContext{{ID: "cheap-mini"}, {ID: "big"}}},
	})
	got, ok := s.resolveCheapModel(context.Background(), core.ModelRef{Provider: "cheaptest", Model: "big"})
	if !ok {
		t.Fatal("expected auto-derive to resolve")
	}
	if want := (core.ModelRef{Provider: "cheaptest", Model: "cheap-mini"}); got != want {
		t.Fatalf("resolveCheapModel = %+v, want %+v", got, want)
	}
}

func TestResolveCheapModelAutoDerivePrefix(t *testing.T) {
	registerCheapTestProvider("cheaptest", "cheap-mini")
	// Live list publishes a dated id; the family hint must prefix-match it.
	s := newCheapResolveServer(t, []ProviderStatus{
		{Name: "cheaptest", Available: true, ModelsWithContext: []ModelWithContext{{ID: "cheap-mini-20251001"}}},
	})
	got, ok := s.resolveCheapModel(context.Background(), core.ModelRef{Provider: "cheaptest", Model: "big"})
	if !ok {
		t.Fatal("expected prefix auto-derive to resolve")
	}
	if want := (core.ModelRef{Provider: "cheaptest", Model: "cheap-mini-20251001"}); got != want {
		t.Fatalf("resolveCheapModel = %+v, want %+v", got, want)
	}
}

func TestResolveCheapModelAutoDeriveMissNotInLiveList(t *testing.T) {
	registerCheapTestProvider("cheaptest", "cheap-mini")
	s := newCheapResolveServer(t, []ProviderStatus{
		{Name: "cheaptest", Available: true, ModelsWithContext: []ModelWithContext{{ID: "other"}}},
	})
	if _, ok := s.resolveCheapModel(context.Background(), core.ModelRef{Provider: "cheaptest", Model: "big"}); ok {
		t.Fatal("expected no resolution when cheap id absent from live list")
	}
}

func TestResolveCheapModelNoPrimary(t *testing.T) {
	s := newCheapResolveServer(t, nil)
	if _, ok := s.resolveCheapModel(context.Background(), core.ModelRef{}); ok {
		t.Fatal("expected no resolution with no pin and no primary")
	}
}

// TestResolveCheapModelOffBeatsEverything pins the explicit decision at the top
// of the chain. Off has to outrank a working pin, not merely the derivation
// steps: the flag is the user's answer to "should there be one at all", and a
// pin left behind from before they answered must not overrule it.
func TestResolveCheapModelOffBeatsEverything(t *testing.T) {
	registerCheapTestProvider("cheaptest", "cheap-mini")
	s := newCheapResolveServer(t, []ProviderStatus{
		{Name: "cheaptest", Available: true, ModelsWithContext: []ModelWithContext{{ID: "cheap-mini"}, {ID: "big"}}},
	})
	pinCheap(t, s, core.ModelRef{Provider: "cheaptest", Model: "big"})
	turnCheapOff(t, s)

	if got, ok := s.resolveCheapModel(context.Background(), core.ModelRef{Provider: "cheaptest", Model: "big"}); ok {
		t.Fatalf("resolveCheapModel = %+v, want no resolution when the user turned it off", got)
	}
}

// TestResolveCheapModelOffBlocksAutoDerive is the case that makes Off worth
// storing at all: an unpinned user on a provider that HAS a cheap tier would
// otherwise get one derived for them however firmly they declined.
func TestResolveCheapModelOffBlocksAutoDerive(t *testing.T) {
	registerCheapTestProvider("cheaptest", "cheap-mini")
	s := newCheapResolveServer(t, []ProviderStatus{
		{Name: "cheaptest", Available: true, ModelsWithContext: []ModelWithContext{{ID: "cheap-mini"}, {ID: "big"}}},
	})
	turnCheapOff(t, s)

	if got, ok := s.resolveCheapModel(context.Background(), core.ModelRef{Provider: "cheaptest", Model: "big"}); ok {
		t.Fatalf("resolveCheapModel = %+v, want no resolution while off", got)
	}
}

// TestResolveCheapModelBorrowsTheDefaultProvidersTier covers the common shape:
// a conversation running on a provider with no cheap tier (an aggregator, a
// subscription plan) while the user's default model sits on one that has.
func TestResolveCheapModelBorrowsTheDefaultProvidersTier(t *testing.T) {
	registerCheapTestProvider("nohint", "")
	registerCheapTestProvider("cheaptest", "cheap-mini")
	s := newCheapResolveServer(t, []ProviderStatus{
		{Name: "nohint", Available: true, ModelsWithContext: []ModelWithContext{{ID: "big"}}},
		{Name: "cheaptest", Available: true, ModelsWithContext: []ModelWithContext{{ID: "cheap-mini"}}},
	})
	pinDefault(t, s, core.ModelRef{Provider: "cheaptest", Model: "cheap-mini"})

	got, ok := s.resolveCheapModel(context.Background(), core.ModelRef{Provider: "nohint", Model: "big"})
	if !ok {
		t.Fatal("expected the default model's provider to supply a cheap tier")
	}
	if want := (core.ModelRef{Provider: "cheaptest", Model: "cheap-mini"}); got != want {
		t.Fatalf("resolveCheapModel = %+v, want %+v", got, want)
	}
}

// TestResolveCheapModelNeverGoesShopping is the negative that bounds the step
// above. A cheap tier is borrowed because the user already chose that provider
// for their default, never because it happened to be configured — otherwise a
// tab title would quietly bill an account they never pointed at this
// conversation.
func TestResolveCheapModelNeverGoesShopping(t *testing.T) {
	registerCheapTestProvider("nohint", "")
	registerCheapTestProvider("cheaptest", "cheap-mini")
	s := newCheapResolveServer(t, []ProviderStatus{
		{Name: "nohint", Available: true, ModelsWithContext: []ModelWithContext{{ID: "big"}}},
		{Name: "cheaptest", Available: true, ModelsWithContext: []ModelWithContext{{ID: "cheap-mini"}}},
	})
	// The user's default is the tierless provider; cheaptest is merely present.
	pinDefault(t, s, core.ModelRef{Provider: "nohint", Model: "big"})

	if got, ok := s.resolveCheapModel(context.Background(), core.ModelRef{Provider: "nohint", Model: "big"}); ok {
		t.Fatalf("resolveCheapModel = %+v, want no resolution from an unchosen provider", got)
	}
}

// TestResolveCheapModelFreeToRunReusesThePrimary covers a local runtime: it
// bills nothing, so the conversation's own model is a perfectly good cheap
// model, and no hint could be written for it anyway — the catalog is whatever
// the user has pulled.
func TestResolveCheapModelFreeToRunReusesThePrimary(t *testing.T) {
	registerFreeToRunTestProvider("localtest")
	s := newCheapResolveServer(t, []ProviderStatus{
		{Name: "localtest", Available: true, ModelsWithContext: []ModelWithContext{{ID: "qwen3:8b"}}},
	})

	primary := core.ModelRef{Provider: "localtest", Model: "qwen3:8b"}
	got, ok := s.resolveCheapModel(context.Background(), primary)
	if !ok {
		t.Fatal("expected a free-to-run provider to re-use its own model")
	}
	if want := (core.ModelRef{Provider: "localtest", Model: "qwen3:8b"}); got != want {
		t.Fatalf("resolveCheapModel = %+v, want %+v", got, want)
	}
}

// TestResolveCheapModelFreeToRunDropsTheReasoningBudget: the micro-task
// inherits the model, not the conversation's settings. A tab title reasoned at
// the conversation's effort would spend minutes of local compute on four words.
func TestResolveCheapModelFreeToRunDropsTheReasoningBudget(t *testing.T) {
	registerFreeToRunTestProvider("localtest")
	s := newCheapResolveServer(t, []ProviderStatus{
		{Name: "localtest", Available: true, ModelsWithContext: []ModelWithContext{{ID: "qwen3:8b"}}},
	})

	primary := core.ModelRef{Provider: "localtest", Model: "qwen3:8b", Thinking: "high", ServiceTier: "priority"}
	got, ok := s.resolveCheapModel(context.Background(), primary)
	if !ok {
		t.Fatal("expected a free-to-run provider to re-use its own model")
	}
	if got.Thinking != "" || got.ServiceTier != "" {
		t.Fatalf("resolveCheapModel = %+v, want the model without the conversation's thinking/tier", got)
	}
}

// TestResolveCheapModelPaidProviderIsNeverReused is the counterpart: re-running
// the conversation's own model is only acceptable because it is free. On a
// billed provider with no cheap tier, resolving nothing (and saying so) is the
// correct answer.
func TestResolveCheapModelPaidProviderIsNeverReused(t *testing.T) {
	registerCheapTestProvider("nohint", "")
	s := newCheapResolveServer(t, []ProviderStatus{
		{Name: "nohint", Available: true, ModelsWithContext: []ModelWithContext{{ID: "big"}}},
	})

	if got, ok := s.resolveCheapModel(context.Background(), core.ModelRef{Provider: "nohint", Model: "big"}); ok {
		t.Fatalf("resolveCheapModel = %+v, want no resolution on a billed provider with no cheap tier", got)
	}
}

func TestLiveModelMatchSkipsHiddenModels(t *testing.T) {
	registerCheapTestProvider("cheaptest", "cheap-mini")
	s := newCheapResolveServer(t, []ProviderStatus{{
		Name:      "cheaptest",
		Available: true,
		ModelsWithContext: []ModelWithContext{
			{ID: "cheap-mini", Hidden: true},
			{ID: "cheap-mini-20250101"},
			{ID: "big"},
		},
	}})

	// An exact hit on a hidden model must not win: the cheap model is chosen on
	// the user's behalf, so it can never land on one they turned off. The prefix
	// pass then finds the dated sibling.
	got, ok := s.liveModelMatch("cheaptest", "cheap-mini")
	if !ok {
		t.Fatal("expected the visible dated sibling to match")
	}
	if got != "cheap-mini-20250101" {
		t.Fatalf("liveModelMatch = %q, want cheap-mini-20250101", got)
	}
}

func TestLiveModelMatchAllCandidatesHidden(t *testing.T) {
	registerCheapTestProvider("cheaptest", "cheap-mini")
	s := newCheapResolveServer(t, []ProviderStatus{{
		Name:      "cheaptest",
		Available: true,
		ModelsWithContext: []ModelWithContext{
			{ID: "cheap-mini", Hidden: true},
			{ID: "cheap-mini-20250101", Hidden: true},
			{ID: "big"},
		},
	}})

	// Nothing matching the hint is visible, so the hint doesn't resolve — it must
	// not fall back to an unrelated model like "big".
	if got, ok := s.liveModelMatch("cheaptest", "cheap-mini"); ok {
		t.Fatalf("liveModelMatch = %q, want no match when every candidate is hidden", got)
	}
}
