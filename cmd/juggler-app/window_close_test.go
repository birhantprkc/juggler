//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄▄▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"sync"
	"testing"
)

// A window's teardown waits seconds for the page's draft flush while the window
// is still clickable, so a second close event can arrive mid-teardown. Only one
// caller may run the teardown: the second would announce the flush again and
// close stopSave twice, which panics.
func TestClaimCloseAdmitsOnlyTheFirstCaller(t *testing.T) {
	a := newTestAppState(t)
	e := registerTestWindow(a, "w1")

	if !a.claimClose(e) {
		t.Fatal("the first close of a window must be allowed to tear it down")
	}
	if a.claimClose(e) {
		t.Fatal("a repeat close of the same window must not run a second teardown")
	}
}

// Teardown deletes the entry from the registry partway through, so a close
// arriving after that point must still be turned away.
func TestClaimCloseHoldsAfterTheEntryLeavesTheRegistry(t *testing.T) {
	a := newTestAppState(t)
	e := registerTestWindow(a, "w1")

	a.claimClose(e)
	a.reg(func(st *regState) { delete(st.windows, e.id) })

	if a.claimClose(e) {
		t.Fatal("a close arriving after the entry was removed must not re-run the teardown")
	}
}

func TestClaimCloseAdmitsOneOfManyConcurrentClosers(t *testing.T) {
	a := newTestAppState(t)
	e := registerTestWindow(a, "w1")

	var wg sync.WaitGroup
	claims := make(chan bool, 8)
	for range cap(claims) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			claims <- a.claimClose(e)
		}()
	}
	wg.Wait()
	close(claims)

	won := 0
	for c := range claims {
		if c {
			won++
		}
	}
	if won != 1 {
		t.Fatalf("exactly one concurrent closer must win the teardown, got %d", won)
	}
}
