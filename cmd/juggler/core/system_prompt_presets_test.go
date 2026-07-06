//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"strings"
	"testing"

	"juggler/internal/userpaths/userpathstest"
)

// newTestPresetStore points the per-user home at a fresh temp dir so the store
// reads/writes an isolated system-prompt-presets.json.
func newTestPresetStore(t *testing.T) *SystemPromptPresetStore {
	t.Helper()
	userpathstest.Isolate(t)
	s, err := NewSystemPromptPresetStore()
	if err != nil {
		t.Fatalf("NewSystemPromptPresetStore: %v", err)
	}
	return s
}

func TestPresetsMissingFileIsEmpty(t *testing.T) {
	s := newTestPresetStore(t)
	presets, defaultID, err := s.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(presets) != 0 {
		t.Fatalf("expected no presets, got %v", presets)
	}
	if defaultID != "" {
		t.Fatalf("expected empty defaultId, got %q", defaultID)
	}
}

func TestPresetsCreateAndLoad(t *testing.T) {
	s := newTestPresetStore(t)
	p, err := s.Create("My Prompt", "You are a helpful assistant.")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if p.ID != "user-my-prompt" {
		t.Fatalf("id = %q, want user-my-prompt", p.ID)
	}
	if p.Name != "My Prompt" || p.Content != "You are a helpful assistant." {
		t.Fatalf("preset round-trip mismatch: %+v", p)
	}

	presets, _, err := s.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(presets) != 1 || presets[0].ID != "user-my-prompt" {
		t.Fatalf("loaded presets = %+v", presets)
	}
}

func TestPresetsCreateRequiresNameAndContent(t *testing.T) {
	s := newTestPresetStore(t)
	if _, err := s.Create("   ", "body"); err == nil {
		t.Fatal("expected error for blank name")
	}
	if _, err := s.Create("name", "   "); err == nil {
		t.Fatal("expected error for blank content")
	}
}

func TestPresetsIDCollisionGetsSuffix(t *testing.T) {
	s := newTestPresetStore(t)
	a, _ := s.Create("Same Name", "a")
	b, _ := s.Create("Same Name", "b")
	if a.ID != "user-same-name" {
		t.Fatalf("first id = %q", a.ID)
	}
	if b.ID != "user-same-name-2" {
		t.Fatalf("second id = %q, want user-same-name-2", b.ID)
	}
}

func TestPresetsUserIDNeverCollidesWithBuiltin(t *testing.T) {
	s := newTestPresetStore(t)
	// A user naming their preset "default" must not produce the built-in id.
	p, _ := s.Create("default", "body")
	if p.ID == "default" {
		t.Fatalf("user preset id collided with built-in: %q", p.ID)
	}
	if !strings.HasPrefix(p.ID, "user-") {
		t.Fatalf("user preset id missing user- prefix: %q", p.ID)
	}
}

func TestPresetsDelete(t *testing.T) {
	s := newTestPresetStore(t)
	p, _ := s.Create("Doomed", "body")
	if err := s.Delete(p.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	presets, _, _ := s.Load()
	if len(presets) != 0 {
		t.Fatalf("expected empty after delete, got %v", presets)
	}
	// Idempotent.
	if err := s.Delete(p.ID); err != nil {
		t.Fatalf("second Delete should be no-op: %v", err)
	}
}

func TestPresetsSetDefault(t *testing.T) {
	s := newTestPresetStore(t)
	// A built-in id is accepted even though no user preset exists.
	if err := s.SetDefault("code-reviewer"); err != nil {
		t.Fatalf("SetDefault: %v", err)
	}
	_, defaultID, _ := s.Load()
	if defaultID != "code-reviewer" {
		t.Fatalf("defaultId = %q, want code-reviewer", defaultID)
	}
}

func TestPresetsDeletingDefaultClearsIt(t *testing.T) {
	s := newTestPresetStore(t)
	p, _ := s.Create("Mine", "body")
	if err := s.SetDefault(p.ID); err != nil {
		t.Fatalf("SetDefault: %v", err)
	}
	if err := s.Delete(p.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	_, defaultID, _ := s.Load()
	if defaultID != "" {
		t.Fatalf("expected default cleared after deleting the default preset, got %q", defaultID)
	}
}

func TestPresetsSetDefaultEmptyClears(t *testing.T) {
	s := newTestPresetStore(t)
	_ = s.SetDefault("minimal")
	if err := s.SetDefault(""); err != nil {
		t.Fatalf("SetDefault(\"\"): %v", err)
	}
	_, defaultID, _ := s.Load()
	if defaultID != "" {
		t.Fatalf("expected cleared default, got %q", defaultID)
	}
}
