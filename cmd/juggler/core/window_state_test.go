//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"path/filepath"
	"testing"
)

// newManagerForTest spins up a SessionManager rooted at a fresh temp project
// dir, seeding an empty session so Load() succeeds. The manager is shut down
// on test cleanup.
func newManagerForTest(t *testing.T) *SessionManager {
	t.Helper()
	dir := t.TempDir()
	store, err := NewFileSessionStore(dir)
	if err != nil {
		t.Fatalf("NewFileSessionStore: %v", err)
	}
	if err := store.Save(NewSession()); err != nil {
		t.Fatalf("seed session: %v", err)
	}
	m := startManager(store, dir, "")
	t.Cleanup(m.Shutdown)
	return m
}

// Window geometry is a per-project session global, not a machine-global file
// that every window would read and fight over (which would land a freshly
// spawned window exactly on top of its sibling). These tests pin the contract:
// geometry round-trips through the project's own session, survives a reload
// from disk, and is independent across projects.
func TestWindowStateRoundTrip(t *testing.T) {
	m := newManagerForTest(t)

	// Absent until first save.
	if _, ok := m.GetWindowState(); ok {
		t.Fatalf("expected no saved window state on a fresh session")
	}

	want := WindowState{X: 120, Y: 80, Width: 1024, Height: 768, HasPos: true, Maximised: false, Fullscreen: false}
	if err := m.SetWindowState(want); err != nil {
		t.Fatalf("SetWindowState: %v", err)
	}

	got, ok := m.GetWindowState()
	if !ok {
		t.Fatalf("expected saved window state after SetWindowState")
	}
	if got != want {
		t.Fatalf("round-trip mismatch: got %+v want %+v", got, want)
	}
}

func TestWindowStatePersistsToDisk(t *testing.T) {
	dir := t.TempDir()
	store, err := NewFileSessionStore(dir)
	if err != nil {
		t.Fatalf("NewFileSessionStore: %v", err)
	}
	if err := store.Save(NewSession()); err != nil {
		t.Fatalf("seed: %v", err)
	}
	m := startManager(store, dir, "")
	want := WindowState{X: 5, Y: 6, Width: 800, Height: 600, HasPos: true, Maximised: true}
	if err := m.SetWindowState(want); err != nil {
		t.Fatalf("SetWindowState: %v", err)
	}
	m.Shutdown()

	// Reopen the same project from disk — a new process restoring the window.
	store2, err := NewFileSessionStore(dir)
	if err != nil {
		t.Fatalf("reopen store: %v", err)
	}
	m2 := startManager(store2, dir, "")
	t.Cleanup(m2.Shutdown)
	got, ok := m2.GetWindowState()
	if !ok {
		t.Fatalf("expected window state to survive reload from %s", filepath.Join(dir, ".juggler", "session.json"))
	}
	if got != want {
		t.Fatalf("reloaded mismatch: got %+v want %+v", got, want)
	}
}

func TestWindowStateIndependentPerProject(t *testing.T) {
	a := newManagerForTest(t)
	b := newManagerForTest(t)

	aState := WindowState{X: 10, Y: 10, Width: 1200, Height: 900, HasPos: true}
	bState := WindowState{X: 700, Y: 400, Width: 640, Height: 480, HasPos: true}
	if err := a.SetWindowState(aState); err != nil {
		t.Fatalf("set a: %v", err)
	}
	if err := b.SetWindowState(bState); err != nil {
		t.Fatalf("set b: %v", err)
	}

	gotA, okA := a.GetWindowState()
	gotB, okB := b.GetWindowState()
	if !okA || !okB {
		t.Fatalf("expected both projects to have saved state (a=%v b=%v)", okA, okB)
	}
	if gotA != aState {
		t.Fatalf("project a clobbered: got %+v want %+v", gotA, aState)
	}
	if gotB != bState {
		t.Fatalf("project b clobbered: got %+v want %+v", gotB, bState)
	}
}
