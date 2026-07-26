//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"path/filepath"
	"testing"
)

// UI theme mode is per-project session state, like UI zoom: surfaced to the web
// viewer so a reopened project paints in the theme the user left it. This
// matters because every project's server reuses the same origin, so theme in
// localStorage alone would be shared across projects — reopening one project
// would show whichever theme another project last set. These tests pin the
// contract: the mode round-trips through the session, survives a reload from
// disk, is independent across projects, and only valid modes persist.
func TestUIThemeRoundTrip(t *testing.T) {
	m := newManagerForTest(t)

	// Absent until first save.
	if _, ok := m.GetUITheme(); ok {
		t.Fatalf("expected no saved theme on a fresh session")
	}

	if err := m.SetUITheme("dark"); err != nil {
		t.Fatalf("SetUITheme: %v", err)
	}
	got, ok := m.GetUITheme()
	if !ok || got != "dark" {
		t.Fatalf("round-trip mismatch: got %q ok=%v want \"dark\" true", got, ok)
	}
}

func TestUIThemePersistsToDisk(t *testing.T) {
	dir := t.TempDir()
	store, err := NewFileSessionStore(dir)
	if err != nil {
		t.Fatalf("NewFileSessionStore: %v", err)
	}
	if err := store.Save(NewSession()); err != nil {
		t.Fatalf("seed: %v", err)
	}
	m := startManager(store, dir, "")
	if err := m.SetUITheme("light"); err != nil {
		t.Fatalf("SetUITheme: %v", err)
	}
	m.Shutdown()

	// Reopen the same project from disk — a new process (new port, empty
	// localStorage) restoring the theme. This is the behaviour the whole change
	// exists to guarantee.
	store2, err := NewFileSessionStore(dir)
	if err != nil {
		t.Fatalf("reopen store: %v", err)
	}
	m2 := startManager(store2, dir, "")
	t.Cleanup(m2.Shutdown)
	got, ok := m2.GetUITheme()
	if !ok || got != "light" {
		t.Fatalf("expected theme to survive reload from %s: got %q ok=%v want \"light\" true",
			filepath.Join(dir, ".juggler", "session.json"), got, ok)
	}
}

func TestUIThemeIndependentPerProject(t *testing.T) {
	a := newManagerForTest(t)
	b := newManagerForTest(t)

	if err := a.SetUITheme("light"); err != nil {
		t.Fatalf("set a: %v", err)
	}
	if err := b.SetUITheme("dark"); err != nil {
		t.Fatalf("set b: %v", err)
	}

	gotA, okA := a.GetUITheme()
	gotB, okB := b.GetUITheme()
	if !okA || !okB {
		t.Fatalf("expected both projects to have saved theme (a=%v b=%v)", okA, okB)
	}
	if gotA != "light" {
		t.Fatalf("project a clobbered: got %q want \"light\"", gotA)
	}
	if gotB != "dark" {
		t.Fatalf("project b clobbered: got %q want \"dark\"", gotB)
	}
}

// An unrecognised mode is a no-op: the client only ever sends system/light/dark,
// and persisting garbage would falsely mark the session as having a saved theme,
// defeating inheritance.
func TestUIThemeInvalidIsNoOp(t *testing.T) {
	m := newManagerForTest(t)
	if err := m.SetUITheme(""); err != nil {
		t.Fatalf("SetUITheme(\"\"): %v", err)
	}
	if err := m.SetUITheme("chartreuse"); err != nil {
		t.Fatalf("SetUITheme(\"chartreuse\"): %v", err)
	}
	if _, ok := m.GetUITheme(); ok {
		t.Fatalf("expected theme to remain unset after invalid sets")
	}
}
