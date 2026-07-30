//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import "testing"

func TestRegistryReserveReuseAndErrorReplace(t *testing.T) {
	r := newRegistry()

	s1, created := r.reserve("/proj/a")
	if !created || s1.State != SessionStarting {
		t.Fatalf("first reserve: created=%v state=%s", created, s1.State)
	}

	// A second reserve for the same project reuses the in-flight reservation.
	s2, created := r.reserve("/proj/a")
	if created || s2.ID != s1.ID {
		t.Fatalf("expected reuse of starting session, got created=%v id=%s (want %s)", created, s2.ID, s1.ID)
	}

	// A different project gets its own reservation.
	other, created := r.reserve("/proj/b")
	if !created || other.ID == s1.ID {
		t.Fatalf("distinct project should create: created=%v", created)
	}

	if !r.setRunning(s1.ID, &child{addr: "127.0.0.1:1"}, 42) {
		t.Fatal("setRunning on a live reservation should succeed")
	}
	s3, created := r.reserve("/proj/a")
	if created || s3.State != SessionRunning || s3.PID != 42 || s3.Addr != "127.0.0.1:1" {
		t.Fatalf("expected reuse of running session, got created=%v %+v", created, s3)
	}

	// An errored entry is replaced by a fresh reservation.
	r.setError(s1.ID, "boom")
	s4, created := r.reserve("/proj/a")
	if !created || s4.ID == s1.ID {
		t.Fatalf("errored session should be replaced: created=%v id=%s", created, s4.ID)
	}
	if _, ok := r.get(s1.ID); ok {
		t.Fatal("errored entry should have been dropped on replace")
	}
}

func TestRegistryStopAndExitInterplay(t *testing.T) {
	r := newRegistry()
	c := &child{addr: "127.0.0.1:2", exited: make(chan struct{})}

	s, _ := r.reserve("/p")
	r.setRunning(s.ID, c, 7)

	got, ok := r.beginStop(s.ID)
	if !ok || got != c {
		t.Fatalf("beginStop should hand back the live child (ok=%v)", ok)
	}
	// The child's exit during a supervised stop must not flip the entry to
	// error — the stopper owns removing it.
	r.noteExit(s.ID)
	if cur, _ := r.get(s.ID); cur.State != SessionStopping {
		t.Fatalf("state after exit-during-stop = %s, want stopping", cur.State)
	}
	r.remove(s.ID)
	if _, ok := r.get(s.ID); ok {
		t.Fatal("removed session still present")
	}

	// An unsupervised exit (crash) flips the entry to error.
	s2, _ := r.reserve("/p")
	r.setRunning(s2.ID, c, 8)
	r.noteExit(s2.ID)
	cur, _ := r.get(s2.ID)
	if cur.State != SessionError || cur.PID != 0 || cur.Addr != "" {
		t.Fatalf("crashed session should be errored and cleared, got %+v", cur)
	}
	if _, ok := r.beginStop(s2.ID); ok {
		t.Fatal("beginStop on an errored session should fail")
	}
}

func TestRegistrySetRunningOnRemovedReservation(t *testing.T) {
	r := newRegistry()
	s, _ := r.reserve("/p")
	r.remove(s.ID)
	if r.setRunning(s.ID, &child{addr: "x"}, 1) {
		t.Fatal("setRunning on a removed reservation should report failure")
	}
}
