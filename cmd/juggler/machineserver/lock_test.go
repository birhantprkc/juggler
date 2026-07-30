//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import "testing"

func TestMachineLockAcquireConflictAndRelease(t *testing.T) {
	dir := t.TempDir()

	l1 := NewMachineLock(dir)
	acquired, existing, err := l1.TryAcquire("v1")
	if err != nil || !acquired || existing != nil {
		t.Fatalf("first acquire: acquired=%v existing=%v err=%v", acquired, existing, err)
	}
	if err := l1.UpdateAddr("127.0.0.1:9"); err != nil {
		t.Fatalf("UpdateAddr: %v", err)
	}

	// A second acquire against the same dir must fail and report the holder.
	l2 := NewMachineLock(dir)
	acquired, existing, err = l2.TryAcquire("v2")
	if err != nil {
		t.Fatalf("second acquire: %v", err)
	}
	if acquired {
		t.Fatal("second acquire should not succeed while the lock is held")
	}
	if existing == nil || existing.Addr != "127.0.0.1:9" || existing.Version != "v1" {
		t.Fatalf("holder info = %+v, want addr 127.0.0.1:9 version v1", existing)
	}

	if err := l1.Release(); err != nil {
		t.Fatalf("release: %v", err)
	}
	acquired, _, err = l2.TryAcquire("v2")
	if err != nil || !acquired {
		t.Fatalf("acquire after release: acquired=%v err=%v", acquired, err)
	}
	if err := l2.Release(); err != nil {
		t.Fatalf("second release: %v", err)
	}
}
