//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"testing"

	"juggler/internal/userpaths/userpathstest"
)

// newTestRecentModelsStore points the per-user home at a fresh temp dir so the
// store reads/writes an isolated recent-models.json.
func newTestRecentModelsStore(t *testing.T) *RecentModelsStore {
	t.Helper()
	userpathstest.Isolate(t)
	s, err := NewRecentModelsStore()
	if err != nil {
		t.Fatalf("NewRecentModelsStore: %v", err)
	}
	return s
}

func assertModels(t *testing.T, got []ModelRef, want []ModelRef) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("recent models = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("recent models = %v, want %v", got, want)
		}
	}
}

func TestRecentModelsMissingFileIsEmpty(t *testing.T) {
	s := newTestRecentModelsStore(t)
	got, err := s.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("expected empty list, got %v", got)
	}
}

func TestRecentModelsMostRecentFirst(t *testing.T) {
	s := newTestRecentModelsStore(t)
	if err := s.Add(ModelRef{Provider: "anthropic", Model: "claude"}); err != nil {
		t.Fatalf("Add: %v", err)
	}
	if err := s.Add(ModelRef{Provider: "openaicodex", Model: "gpt-5"}); err != nil {
		t.Fatalf("Add: %v", err)
	}
	got, err := s.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	assertModels(t, got, []ModelRef{
		{Provider: "openaicodex", Model: "gpt-5"},
		{Provider: "anthropic", Model: "claude"},
	})
}

func TestRecentModelsDedupMovesToFront(t *testing.T) {
	s := newTestRecentModelsStore(t)
	_ = s.Add(ModelRef{Provider: "anthropic", Model: "claude"})
	_ = s.Add(ModelRef{Provider: "openaicodex", Model: "gpt-5"})
	_ = s.Add(ModelRef{Provider: "anthropic", Model: "claude"})
	got, _ := s.Load()
	assertModels(t, got, []ModelRef{
		{Provider: "anthropic", Model: "claude"},
		{Provider: "openaicodex", Model: "gpt-5"},
	})
}

func TestRecentModelsCappedAtCap(t *testing.T) {
	s := newTestRecentModelsStore(t)
	ids := []string{"a", "b", "c", "d", "e", "f", "g"}
	for _, id := range ids {
		if err := s.Add(ModelRef{Provider: "p", Model: id}); err != nil {
			t.Fatalf("Add: %v", err)
		}
	}
	got, _ := s.Load()
	if len(got) != RecentModelsCap {
		t.Fatalf("expected %d entries, got %d (%v)", RecentModelsCap, len(got), got)
	}
	// Most-recent-first: the last RecentModelsCap adds, newest first.
	assertModels(t, got, []ModelRef{
		{Provider: "p", Model: "g"},
		{Provider: "p", Model: "f"},
		{Provider: "p", Model: "e"},
		{Provider: "p", Model: "d"},
		{Provider: "p", Model: "c"},
	})
}

func TestRecentModelsIgnoresEmptyRef(t *testing.T) {
	s := newTestRecentModelsStore(t)
	_ = s.Add(ModelRef{Provider: "", Model: "x"})
	_ = s.Add(ModelRef{Provider: "p", Model: ""})
	got, _ := s.Load()
	if len(got) != 0 {
		t.Fatalf("expected empty list, got %v", got)
	}
}
