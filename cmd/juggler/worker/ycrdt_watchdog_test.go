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

// watchdogHarness drives watchYcrdtStalls one sample at a time. The ticks a
// test sends carry the sample time, so a stall is a tick stamped long after
// the hold began rather than a hold the test has to sit and wait out: nothing
// here depends on elapsed time, a timer firing promptly, or a goroutine being
// scheduled within some deadline.
type watchdogHarness struct {
	m       watchedMutex
	ticks   chan time.Time
	reports chan time.Duration
	done    chan struct{}
}

func newWatchdogHarness(threshold time.Duration) *watchdogHarness {
	h := &watchdogHarness{
		ticks:   make(chan time.Time),
		reports: make(chan time.Duration, 16),
		done:    make(chan struct{}),
	}
	go func() {
		defer close(h.done)
		watchYcrdtStalls(&h.m, h.ticks, threshold, func(age time.Duration) {
			select {
			case h.reports <- age:
			default: // a watchdog reporting every tick fails the count, never wedges the test
			}
		})
	}()
	return h
}

// sample takes one sample stamped at, and returns once the watchdog has
// finished handling it. The wait is the barrier tick that follows: ticks is
// unbuffered, so that send completes only after the loop has come back round
// from the sample before it. A zero-stamped tick is an age below any
// threshold, so the barrier itself can never report, whenever it is handled.
func (h *watchdogHarness) sample(at time.Time) {
	h.ticks <- at
	h.ticks <- time.Time{}
}

// heldSince is when the current holder acquired the lock — the instant every
// age the watchdog reports is measured from, so stamping ticks relative to it
// makes those ages exact.
func (h *watchdogHarness) heldSince() time.Time {
	return time.Unix(0, h.m.heldSince.Load())
}

// finish stops the watchdog and returns every age it reported.
func (h *watchdogHarness) finish() []time.Duration {
	close(h.ticks)
	<-h.done // every tick handled, so every report is already in the channel
	var ages []time.Duration
	for {
		select {
		case age := <-h.reports:
			ages = append(ages, age)
		default:
			return ages
		}
	}
}

// TestWatchYcrdtStallsReportsOncePerStall is the behaviour that keeps a real
// deadlock readable: the dump costs megabytes of log, so a lock stuck for
// hours must produce exactly one report, not one per tick. A later, separate
// stall must still be reported.
func TestWatchYcrdtStallsReportsOncePerStall(t *testing.T) {
	h := newWatchdogHarness(time.Minute)

	h.m.Lock()
	held := h.heldSince()
	h.sample(held.Add(time.Hour))     // a stall: reported
	h.sample(held.Add(2 * time.Hour)) // the same acquisition: silent
	h.sample(held.Add(3 * time.Hour))
	h.m.Unlock()

	// A distinct stall later is a distinct generation, so it reports again.
	h.m.Lock()
	held = h.heldSince()
	h.sample(held.Add(time.Hour))
	h.sample(held.Add(2 * time.Hour))
	h.m.Unlock()

	ages := h.finish()
	if len(ages) != 2 {
		t.Fatalf("got %d reports (%v), want one per stalled acquisition", len(ages), ages)
	}
	for _, age := range ages {
		if age != time.Hour {
			t.Errorf("reported age %s, want 1h — the time since that hold began", age)
		}
	}
}

// TestWatchYcrdtStallsIgnoresShortHolds guards against false positives: normal
// doc mutations take microseconds and must never trigger a dump.
func TestWatchYcrdtStallsIgnoresShortHolds(t *testing.T) {
	const threshold = 250 * time.Millisecond
	h := newWatchdogHarness(threshold)

	// Two hundred brief holds, each sampled from inside.
	for range 200 {
		h.m.Lock()
		h.sample(time.Now())
		h.m.Unlock()
	}

	// And the boundary: a hold sampled a nanosecond short of the threshold.
	h.m.Lock()
	h.sample(h.heldSince().Add(threshold - time.Nanosecond))
	h.m.Unlock()

	if ages := h.finish(); len(ages) > 0 {
		t.Fatalf("a short hold was reported as a stall (ages %v)", ages)
	}
}
