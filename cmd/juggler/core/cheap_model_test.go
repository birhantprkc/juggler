//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"encoding/json"
	"os"
	"path/filepath"
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

// cheapRef is shorthand for a setting that pins a model.
func cheapRef(provider, model string) CheapModelSetting {
	return CheapModelSetting{ModelRef: ModelRef{Provider: provider, Model: model}}
}

func TestCheapModelMissingFileIsAuto(t *testing.T) {
	s := newTestCheapModelStore(t)
	got, err := s.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got != (CheapModelSetting{}) {
		t.Fatalf("expected empty setting (Auto), got %+v", got)
	}
}

// TestCheapModelRoundTrip locks Save/Load round-tripping, including the optional
// Thinking level.
func TestCheapModelRoundTrip(t *testing.T) {
	s := newTestCheapModelStore(t)
	for _, want := range []CheapModelSetting{
		cheapRef("anthropic", "claude-haiku-4-5"),
		{ModelRef: ModelRef{Provider: "anthropic", Model: "claude-haiku-4-5", Thinking: "off"}},
	} {
		if err := s.Save(want); err != nil {
			t.Fatalf("Save(%+v): %v", want, err)
		}
		got, err := s.Load()
		if err != nil {
			t.Fatalf("Load: %v", err)
		}
		if got != want {
			t.Fatalf("round-trip = %+v, want %+v", got, want)
		}
	}
}

// TestCheapModelClearOnEmptyRef verifies an empty ref reverts to Auto by
// deleting the file.
func TestCheapModelClearOnEmptyRef(t *testing.T) {
	s := newTestCheapModelStore(t)
	if err := s.Save(cheapRef("anthropic", "claude-haiku-4-5")); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if err := s.Save(CheapModelSetting{}); err != nil {
		t.Fatalf("Save(empty): %v", err)
	}
	got, err := s.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got != (CheapModelSetting{}) {
		t.Fatalf("expected Auto after clear, got %+v", got)
	}
}

// TestCheapModelPartialRefClears verifies a ref with only one field set is
// treated as empty (cleared), matching DefaultModelStore semantics.
func TestCheapModelPartialRefClears(t *testing.T) {
	s := newTestCheapModelStore(t)
	if err := s.Save(cheapRef("anthropic", "claude-haiku-4-5")); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if err := s.Save(cheapRef("anthropic", "")); err != nil {
		t.Fatalf("Save(provider-only): %v", err)
	}
	if _, err := os.Stat(s.filePath); !os.IsNotExist(err) {
		t.Fatalf("expected cheap-model.json removed, stat err = %v", err)
	}
}

// TestCheapModelDisabledRoundTrip locks the explicit off state — the whole
// reason this store is not a plain ModelRef. "Off" and "never set" must be
// distinguishable, so Disabled has to survive a Save/Load with no model pinned
// alongside it.
func TestCheapModelDisabledRoundTrip(t *testing.T) {
	s := newTestCheapModelStore(t)
	if err := s.Save(CheapModelSetting{Disabled: true}); err != nil {
		t.Fatalf("Save(disabled): %v", err)
	}
	got, err := s.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !got.Disabled {
		t.Fatalf("expected Disabled to survive the round-trip, got %+v", got)
	}
	if got.Provider != "" || got.Model != "" {
		t.Fatalf("expected no model pinned alongside Off, got %+v", got)
	}
}

// TestCheapModelDisabledKeepsTheFile is the trap this state has to dodge: Save
// clears by DELETING the file, and an off setting names no model, so the naive
// rule would erase the very thing being recorded and read back as Auto.
func TestCheapModelDisabledKeepsTheFile(t *testing.T) {
	s := newTestCheapModelStore(t)
	if err := s.Save(CheapModelSetting{Disabled: true}); err != nil {
		t.Fatalf("Save(disabled): %v", err)
	}
	if _, err := os.Stat(s.filePath); err != nil {
		t.Fatalf("expected cheap-model.json to exist while Off, stat err = %v", err)
	}
}

// TestCheapModelTurningOffAndBackOn verifies Off is reversible: saving Auto over
// it returns to the absent-file state rather than leaving a lingering flag.
func TestCheapModelTurningOffAndBackOn(t *testing.T) {
	s := newTestCheapModelStore(t)
	if err := s.Save(CheapModelSetting{Disabled: true}); err != nil {
		t.Fatalf("Save(disabled): %v", err)
	}
	if err := s.Save(CheapModelSetting{}); err != nil {
		t.Fatalf("Save(auto): %v", err)
	}
	got, err := s.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got != (CheapModelSetting{}) {
		t.Fatalf("expected Auto after re-enabling, got %+v", got)
	}
	if _, err := os.Stat(s.filePath); !os.IsNotExist(err) {
		t.Fatalf("expected cheap-model.json removed, stat err = %v", err)
	}
}

// TestCheapModelLoadsAPreDisabledFile pins backward compatibility: a
// cheap-model.json written before the off state existed carries no `disabled`
// key, and must still load as the pinned model it names — not as Off.
func TestCheapModelLoadsAPreDisabledFile(t *testing.T) {
	s := newTestCheapModelStore(t)
	if err := os.MkdirAll(filepath.Dir(s.filePath), 0700); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	legacy := `{"provider":"anthropic","model":"claude-haiku-4-5","thinking":"off"}`
	if err := os.WriteFile(s.filePath, []byte(legacy), 0600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	got, err := s.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	want := CheapModelSetting{ModelRef: ModelRef{Provider: "anthropic", Model: "claude-haiku-4-5", Thinking: "off"}}
	if got != want {
		t.Fatalf("legacy file loaded as %+v, want %+v", got, want)
	}
}

// TestCheapModelWritesFlatJSON locks the on-disk shape. CheapModelSetting embeds
// ModelRef so the file stays a flat object rather than nesting the ref under a
// key — which is what lets a legacy file parse unchanged.
func TestCheapModelWritesFlatJSON(t *testing.T) {
	s := newTestCheapModelStore(t)
	if err := s.Save(cheapRef("anthropic", "claude-haiku-4-5")); err != nil {
		t.Fatalf("Save: %v", err)
	}
	data, err := os.ReadFile(s.filePath)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	var flat map[string]any
	if err := json.Unmarshal(data, &flat); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if flat["provider"] != "anthropic" || flat["model"] != "claude-haiku-4-5" {
		t.Fatalf("expected provider/model at the top level, got %v", flat)
	}
	if _, ok := flat["disabled"]; ok {
		t.Fatalf("expected `disabled` omitted when not off, got %v", flat)
	}
}
