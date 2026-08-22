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

// newCheapResolveServer builds a minimal Server with the providers-ready gate
// open and a live provider list installed, plus an isolated cheap-model store.
func newCheapResolveServer(t *testing.T, providers []ProviderStatus) *Server {
	t.Helper()
	userpathstest.Isolate(t)
	store, err := core.NewCheapModelStore()
	if err != nil {
		t.Fatalf("NewCheapModelStore: %v", err)
	}
	s := &Server{
		providerRefresh: providerRefresh{providersReady: make(chan struct{})},
		serverStores:    serverStores{cheapModelStore: store},
	}
	s.providersList.Store(&providers)
	s.markProvidersReady()
	return s
}

func TestResolveCheapModelExplicitAvailable(t *testing.T) {
	registerCheapTestProvider("cheaptest", "cheap-mini")
	s := newCheapResolveServer(t, []ProviderStatus{
		{Name: "cheaptest", Available: true, ModelsWithContext: []ModelWithContext{{ID: "cheap-mini"}, {ID: "big"}}},
	})
	if err := s.cheapModelStore.Save(core.ModelRef{Provider: "cheaptest", Model: "big", Thinking: "off"}); err != nil {
		t.Fatalf("Save: %v", err)
	}
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
	if err := s.cheapModelStore.Save(core.ModelRef{Provider: "gone", Model: "ghost"}); err != nil {
		t.Fatalf("Save: %v", err)
	}
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
