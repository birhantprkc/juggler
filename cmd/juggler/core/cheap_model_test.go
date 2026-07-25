//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"os"
	"testing"

	"juggler/internal/userpaths/userpathstest"
)

// newTestCheapModelStore points the per-user home at a fresh temp dir so the
// store reads/writes an isolated cheap-model.json.
func newTestCheapModelStore(t *testing.T) *CheapModelStore {
	t.Helper()
	userpathstest.Isolate(t)
	s, err := NewCheapModelStore()
	if err != nil {
		t.Fatalf("NewCheapModelStore: %v", err)
	}
	return s
}

func TestCheapModelMissingFileIsAuto(t *testing.T) {
	s := newTestCheapModelStore(t)
	got, err := s.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got != (ModelRef{}) {
		t.Fatalf("expected empty ref (Auto), got %+v", got)
	}
}

// TestCheapModelRoundTrip locks Save/Load round-tripping, including the optional
// Thinking level.
func TestCheapModelRoundTrip(t *testing.T) {
	s := newTestCheapModelStore(t)
	for _, ref := range []ModelRef{
		{Provider: "anthropic", Model: "claude-haiku-4-5"},
		{Provider: "anthropic", Model: "claude-haiku-4-5", Thinking: "off"},
	} {
		if err := s.Save(ref); err != nil {
			t.Fatalf("Save(%+v): %v", ref, err)
		}
		got, err := s.Load()
		if err != nil {
			t.Fatalf("Load: %v", err)
		}
		if got != ref {
			t.Fatalf("round-trip = %+v, want %+v", got, ref)
		}
	}
}

// TestCheapModelClearOnEmptyRef verifies an empty ref reverts to Auto by
// deleting the file.
func TestCheapModelClearOnEmptyRef(t *testing.T) {
	s := newTestCheapModelStore(t)
	if err := s.Save(ModelRef{Provider: "anthropic", Model: "claude-haiku-4-5"}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if err := s.Save(ModelRef{}); err != nil {
		t.Fatalf("Save(empty): %v", err)
	}
	got, err := s.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got != (ModelRef{}) {
		t.Fatalf("expected Auto after clear, got %+v", got)
	}
}

// TestCheapModelPartialRefClears verifies a ref with only one field set is
// treated as empty (cleared), matching DefaultModelStore semantics.
func TestCheapModelPartialRefClears(t *testing.T) {
	s := newTestCheapModelStore(t)
	if err := s.Save(ModelRef{Provider: "anthropic", Model: "claude-haiku-4-5"}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if err := s.Save(ModelRef{Provider: "anthropic"}); err != nil {
		t.Fatalf("Save(provider-only): %v", err)
	}
	if _, err := os.Stat(s.filePath); !os.IsNotExist(err) {
		t.Fatalf("expected cheap-model.json removed, stat err = %v", err)
	}
}
