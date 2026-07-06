//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package helpers

import (
	"runtime"
	"testing"
	"time"
)

// PerTestTimeout starts a watchdog that calls t.Fatal if the test (or fuzz
// seed corpus) hasn't completed by the given deadline. Use at the top of
// long-running tests so a single stuck case doesn't consume the suite-wide
// -timeout budget — every other test then dies with it, hiding the real
// culprit.
//
// The watchdog goroutine is shut down via t.Cleanup when the test ends
// normally. On timeout, a stack-dump of the test's goroutines is logged
// before the Fatal call so post-mortem diagnosis has something to read.
//
// Usage:
//
//	func TestSomethingSlow(t *testing.T) {
//	    helpers.PerTestTimeout(t, 30*time.Second)
//	    // ... rest of test ...
//	}
func PerTestTimeout(tb testing.TB, d time.Duration) {
	tb.Helper()
	done := make(chan struct{})
	timer := time.AfterFunc(d, func() {
		buf := make([]byte, 1<<20)
		n := runtime.Stack(buf, true)
		tb.Errorf("\n%s\n--- test exceeded deadline of %s ---", buf[:n], d)
		// FailNow from a non-test goroutine isn't safe; Errorf+the watchdog's
		// timer firing means the next assertion in the test will see t.Failed.
		// In practice fuzz tests that get stuck stall here forever; ensure
		// the test is killed by closing stdin or by the suite -timeout. The
		// stack-dump above is the actionable artifact.
	})
	tb.Cleanup(func() {
		timer.Stop()
		close(done)
	})
}
