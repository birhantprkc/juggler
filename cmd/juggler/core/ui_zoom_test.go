//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"path/filepath"
	"testing"
)

// UI zoom is per-project session state, like window geometry, but surfaced to
// the web viewer so a reopened project paints at the size the user left it —
// the whole point being that a new window (a separate process on a fresh,
// empty localStorage) restores the saved size instead of resetting. These
// tests pin that contract: zoom round-trips through the session, survives a
// reload from disk, is independent across projects, and the no-op guards hold.
func TestUIZoomRoundTrip(t *testing.T) {
	m := newManagerForTest(t)

	// Absent until first save.
	if _, ok := m.GetUIZoom(); ok {
		t.Fatalf("expected no saved zoom on a fresh session")
	}

	if err := m.SetUIZoom(130); err != nil {
		t.Fatalf("SetUIZoom: %v", err)
	}
	got, ok := m.GetUIZoom()
	if !ok || got != 130 {
		t.Fatalf("round-trip mismatch: got %d ok=%v want 130 true", got, ok)
	}
}

func TestUIZoomPersistsToDisk(t *testing.T) {
	dir := t.TempDir()
	store, err := NewFileSessionStore(dir)
	if err != nil {
		t.Fatalf("NewFileSessionStore: %v", err)
	}
	if err := store.Save(NewSession()); err != nil {
		t.Fatalf("seed: %v", err)
	}
	m := startManager(store, dir, "")
	if err := m.SetUIZoom(90); err != nil {
		t.Fatalf("SetUIZoom: %v", err)
	}
	m.Shutdown()

	// Reopen the same project from disk — a new process (new port, empty
	// localStorage) restoring the size. This is the behaviour the whole change
	// exists to guarantee.
	store2, err := NewFileSessionStore(dir)
	if err != nil {
		t.Fatalf("reopen store: %v", err)
	}
	m2 := startManager(store2, dir, "")
	t.Cleanup(m2.Shutdown)
	got, ok := m2.GetUIZoom()
	if !ok || got != 90 {
		t.Fatalf("expected zoom to survive reload from %s: got %d ok=%v want 90 true",
			filepath.Join(dir, ".juggler", "session.json"), got, ok)
	}
}

func TestUIZoomIndependentPerProject(t *testing.T) {
	a := newManagerForTest(t)
	b := newManagerForTest(t)

	if err := a.SetUIZoom(140); err != nil {
		t.Fatalf("set a: %v", err)
	}
	if err := b.SetUIZoom(70); err != nil {
		t.Fatalf("set b: %v", err)
	}

	gotA, okA := a.GetUIZoom()
	gotB, okB := b.GetUIZoom()
	if !okA || !okB {
		t.Fatalf("expected both projects to have saved zoom (a=%v b=%v)", okA, okB)
	}
	if gotA != 140 {
		t.Fatalf("project a clobbered: got %d want 140", gotA)
	}
	if gotB != 70 {
		t.Fatalf("project b clobbered: got %d want 70", gotB)
	}
}

// A non-positive zoom is a no-op: the client only ever sends a clamped positive
// value, and 0 is the "unset" sentinel — persisting it would falsely mark the
// session as having a saved size, defeating inheritance.
func TestUIZoomNonPositiveIsNoOp(t *testing.T) {
	m := newManagerForTest(t)
	if err := m.SetUIZoom(0); err != nil {
		t.Fatalf("SetUIZoom(0): %v", err)
	}
	if err := m.SetUIZoom(-5); err != nil {
		t.Fatalf("SetUIZoom(-5): %v", err)
	}
	if _, ok := m.GetUIZoom(); ok {
		t.Fatalf("expected zoom to remain unset after non-positive sets")
	}
}
