//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"testing"
	"time"
)

// TestWatchedMutexSampleTracksHolds covers the detector's input: sample must
// report nothing while the lock is free, a growing age while one goroutine
// holds it, and a fresh generation for each new acquisition — the signal that
// separates one stuck hold from a busy series of short ones.
func TestWatchedMutexSampleTracksHolds(t *testing.T) {
	var m watchedMutex

	if _, _, ok := m.sample(time.Now()); ok {
		t.Fatal("a free lock must not sample as held")
	}

	m.Lock()
	start := time.Now()
	age, gen1, ok := m.sample(start.Add(2 * time.Second))
	if !ok {
		t.Fatal("a held lock must sample as held")
	}
	if age < 2*time.Second {
		t.Errorf("age = %s, want at least 2s", age)
	}
	if _, gen, _ := m.sample(start.Add(3 * time.Second)); gen != gen1 {
		t.Errorf("generation changed (%d -> %d) without a new acquisition", gen1, gen)
	}
	m.Unlock()

	if _, _, ok := m.sample(time.Now()); ok {
		t.Fatal("the lock must not sample as held once released")
	}

	m.Lock()
	_, gen2, _ := m.sample(time.Now())
	m.Unlock()
	if gen2 == gen1 {
		t.Errorf("a new acquisition must get a new generation, got %d twice", gen1)
	}
}

// TestWatchYcrdtStallsReportsOncePerStall is the behaviour that keeps a real
// deadlock readable: the dump costs megabytes of log, so a lock stuck for
// hours must produce exactly one report, not one per tick. A later, separate
// stall must still be reported.
func TestWatchYcrdtStallsReportsOncePerStall(t *testing.T) {
	var m watchedMutex
	reports := make(chan time.Duration, 16)
	go watchYcrdtStalls(&m, time.Millisecond, 5*time.Millisecond, func(age time.Duration) {
		reports <- age
	})

	m.Lock()
	select {
	case <-reports:
	case <-time.After(2 * time.Second):
		t.Fatal("a hold past the threshold was never reported")
	}
	// Stay locked well past several more ticks: no second report may arrive
	// for the same acquisition.
	time.Sleep(50 * time.Millisecond)
	select {
	case <-reports:
		t.Fatal("the same stalled acquisition was reported more than once")
	default:
	}
	m.Unlock()

	// A distinct stall later is a distinct generation, so it reports again.
	m.Lock()
	defer m.Unlock()
	select {
	case <-reports:
	case <-time.After(2 * time.Second):
		t.Fatal("a second, separate stall was not reported")
	}
}

// TestWatchYcrdtStallsIgnoresShortHolds guards against false positives: normal
// doc mutations take microseconds and must never trigger a dump.
func TestWatchYcrdtStallsIgnoresShortHolds(t *testing.T) {
	var m watchedMutex
	reports := make(chan time.Duration, 16)
	go watchYcrdtStalls(&m, time.Millisecond, 250*time.Millisecond, func(age time.Duration) {
		reports <- age
	})

	for range 200 {
		m.Lock()
		m.Unlock() //nolint:staticcheck // deliberately a short hold, not a defer
	}
	time.Sleep(50 * time.Millisecond)

	select {
	case age := <-reports:
		t.Fatalf("a short hold was reported as a stall (age %s)", age)
	default:
	}
}
