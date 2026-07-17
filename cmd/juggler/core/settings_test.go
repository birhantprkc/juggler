//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"os"
	"path/filepath"
	"testing"

	"juggler/internal/userpaths"
	"juggler/internal/userpaths/userpathstest"
)

func TestLoadGlobalSettingsMissingFileDefaults(t *testing.T) {
	userpathstest.Isolate(t)
	gs, err := LoadGlobalSettings()
	if err != nil {
		t.Fatalf("LoadGlobalSettings: %v", err)
	}
	if gs.Updates.Mode != UpdateModeAutomatic {
		t.Fatalf("missing file mode = %q, want %q", gs.Updates.Mode, UpdateModeAutomatic)
	}
}

func TestSaveLoadGlobalSettingsRoundTrip(t *testing.T) {
	userpathstest.Isolate(t)
	if err := SaveGlobalSettings(&GlobalSettings{Updates: UpdateSettings{Mode: UpdateModeNotify}}); err != nil {
		t.Fatalf("SaveGlobalSettings: %v", err)
	}
	gs, err := LoadGlobalSettings()
	if err != nil {
		t.Fatalf("LoadGlobalSettings: %v", err)
	}
	if gs.Updates.Mode != UpdateModeNotify {
		t.Fatalf("round-trip mode = %q, want %q", gs.Updates.Mode, UpdateModeNotify)
	}
	// The file exists at the expected path with a canonical mode written out.
	if _, err := os.Stat(filepath.Join(userpaths.ConfigDir(), "settings.json")); err != nil {
		t.Fatalf("settings.json not written: %v", err)
	}
}

func TestLoadGlobalSettingsEmptyModeNormalises(t *testing.T) {
	userpathstest.Isolate(t)
	// A file present but with an empty mode must normalise to automatic.
	if err := os.MkdirAll(userpaths.ConfigDir(), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(userpaths.ConfigDir(), "settings.json"),
		[]byte(`{"updates":{}}`), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	gs, err := LoadGlobalSettings()
	if err != nil {
		t.Fatalf("LoadGlobalSettings: %v", err)
	}
	if gs.Updates.Mode != UpdateModeAutomatic {
		t.Fatalf("empty mode = %q, want %q", gs.Updates.Mode, UpdateModeAutomatic)
	}
}

func TestLoadGlobalSettingsCorruptDefaults(t *testing.T) {
	userpathstest.Isolate(t)
	if err := os.MkdirAll(userpaths.ConfigDir(), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(userpaths.ConfigDir(), "settings.json"),
		[]byte(`{not json`), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	gs, err := LoadGlobalSettings()
	if err == nil {
		t.Fatal("expected a parse error for corrupt file")
	}
	if gs == nil || gs.Updates.Mode != UpdateModeAutomatic {
		t.Fatalf("corrupt file must fall back to automatic defaults, got %+v", gs)
	}
}

func TestNormalizeUpdateMode(t *testing.T) {
	cases := map[string]string{
		"":          UpdateModeAutomatic,
		"automatic": UpdateModeAutomatic,
		"notify":    UpdateModeNotify,
		"off":       UpdateModeOff,
		"garbage":   UpdateModeAutomatic,
	}
	for in, want := range cases {
		if got := NormalizeUpdateMode(in); got != want {
			t.Errorf("NormalizeUpdateMode(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestIsKnownUpdateMode(t *testing.T) {
	for _, m := range []string{UpdateModeAutomatic, UpdateModeNotify, UpdateModeOff} {
		if !IsKnownUpdateMode(m) {
			t.Errorf("IsKnownUpdateMode(%q) = false, want true", m)
		}
	}
	for _, m := range []string{"", "garbage", "AUTOMATIC"} {
		if IsKnownUpdateMode(m) {
			t.Errorf("IsKnownUpdateMode(%q) = true, want false", m)
		}
	}
}
