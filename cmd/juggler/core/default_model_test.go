//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"os"
	"testing"

	"juggler/internal/userpaths/userpathstest"
)

// newTestDefaultModelStore points the per-user home at a fresh temp dir so the
// store reads/writes an isolated default-model.json.
func newTestDefaultModelStore(t *testing.T) *DefaultModelStore {
	t.Helper()
	userpathstest.Isolate(t)
	s, err := NewDefaultModelStore()
	if err != nil {
		t.Fatalf("NewDefaultModelStore: %v", err)
	}
	return s
}

func TestDefaultModelMissingFileIsAutomatic(t *testing.T) {
	s := newTestDefaultModelStore(t)
	got, err := s.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got != (ModelRef{}) {
		t.Fatalf("expected empty ref, got %+v", got)
	}
}

// TestDefaultModelRoundTrip locks Save/Load round-tripping, including the
// optional Thinking level (empty = the model's default level).
func TestDefaultModelRoundTrip(t *testing.T) {
	s := newTestDefaultModelStore(t)
	for _, ref := range []ModelRef{
		{Provider: "anthropic", Model: "claude"},
		{Provider: "anthropic", Model: "claude", Thinking: "high"},
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

// TestDefaultModelClearOnEmptyRef verifies an empty ref reverts to automatic
// selection by deleting the file.
func TestDefaultModelClearOnEmptyRef(t *testing.T) {
	s := newTestDefaultModelStore(t)
	if err := s.Save(ModelRef{Provider: "anthropic", Model: "claude", Thinking: "high"}); err != nil {
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
		t.Fatalf("expected automatic after clear, got %+v", got)
	}
}

// TestDefaultModelBackCompatWithoutThinking loads a file written before the
// thinking field existed: it must load unchanged, with an empty Thinking
// meaning the model's default level.
func TestDefaultModelBackCompatWithoutThinking(t *testing.T) {
	s := newTestDefaultModelStore(t)
	// Seed via Save so the directory exists, then overwrite the file with the
	// pre-thinking schema.
	if err := s.Save(ModelRef{Provider: "seed", Model: "seed"}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	old := `{"provider":"anthropic","model":"claude"}`
	if err := os.WriteFile(s.filePath, []byte(old), 0600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	got, err := s.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	want := ModelRef{Provider: "anthropic", Model: "claude"}
	if got != want {
		t.Fatalf("back-compat load = %+v, want %+v", got, want)
	}
}
