//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package utils

import (
	"context"
	"testing"
	"time"
)

// firedCancel returns a CancelFunc that closes done when called, so a test can
// await the watchdog firing deterministically instead of sleeping.
func firedCancel() (context.CancelFunc, <-chan struct{}) {
	done := make(chan struct{})
	var once bool
	return func() {
		if !once {
			once = true
			close(done)
		}
	}, done
}

func TestIdleWatchdog_FiresAfterIdle(t *testing.T) {
	cancel, done := firedCancel()
	w := NewIdleWatchdog(20*time.Millisecond, cancel)
	defer w.Stop()

	select {
	case <-done:
		// Cancel ran — await the observable signal, no fixed sleep.
	case <-time.After(2 * time.Second):
		t.Fatal("watchdog did not fire within the safety bound")
	}
	if !w.Fired() {
		t.Fatal("Fired() should report true after the idle window elapsed")
	}
}

func TestIdleWatchdog_ResetPreventsFire(t *testing.T) {
	cancel, done := firedCancel()
	w := NewIdleWatchdog(60*time.Millisecond, cancel)
	defer w.Stop()

	// Reset faster than the window for several cycles; it must not fire.
	ticker := time.NewTicker(15 * time.Millisecond)
	defer ticker.Stop()
	for i := 0; i < 8; i++ {
		select {
		case <-done:
			t.Fatal("watchdog fired despite being reset within the idle window")
		case <-ticker.C:
			w.Reset()
		}
	}
	if w.Fired() {
		t.Fatal("Fired() should be false while the stream keeps making progress")
	}
}

func TestIdleWatchdog_StopPreventsFire(t *testing.T) {
	cancel, done := firedCancel()
	w := NewIdleWatchdog(20*time.Millisecond, cancel)
	w.Stop()

	select {
	case <-done:
		t.Fatal("watchdog fired after Stop()")
	case <-time.After(80 * time.Millisecond):
		// Stopped before the window elapsed — cancel must never run.
	}
	if w.Fired() {
		t.Fatal("Fired() should be false after Stop() before the window elapsed")
	}
}

func TestIdleWatchdog_StopIsIdempotent(t *testing.T) {
	cancel, _ := firedCancel()
	w := NewIdleWatchdog(time.Second, cancel)
	w.Stop()
	w.Stop() // must not panic on a double close
}

func TestIdleWatchdog_ResetAfterFireIsSafe(t *testing.T) {
	cancel, done := firedCancel()
	w := NewIdleWatchdog(20*time.Millisecond, cancel)
	defer w.Stop()
	<-done    // let it fire
	w.Reset() // must not block or panic
	if !w.Fired() {
		t.Fatal("Fired() should remain true after firing")
	}
}

func TestEffectiveStreamIdleTimeout_FallsBackToDefault(t *testing.T) {
	// No resolver registered (the default state) ⇒ the package default applies.
	SetStreamIdleTimeoutResolver(nil)
	if got := EffectiveStreamIdleTimeout(); got != StreamIdleTimeout {
		t.Fatalf("with no resolver, got %v, want default %v", got, StreamIdleTimeout)
	}

	// A resolver returning a non-positive value is ignored — the default wins,
	// so a blank/invalid user setting can never shrink the window to zero.
	SetStreamIdleTimeoutResolver(func() time.Duration { return 0 })
	t.Cleanup(func() { SetStreamIdleTimeoutResolver(nil) })
	if got := EffectiveStreamIdleTimeout(); got != StreamIdleTimeout {
		t.Fatalf("with a zero resolver, got %v, want default %v", got, StreamIdleTimeout)
	}
}

func TestEffectiveStreamIdleTimeout_ResolverOverrides(t *testing.T) {
	SetStreamIdleTimeoutResolver(func() time.Duration { return 600 * time.Second })
	t.Cleanup(func() { SetStreamIdleTimeoutResolver(nil) })
	if got := EffectiveStreamIdleTimeout(); got != 600*time.Second {
		t.Fatalf("got %v, want the resolver's 600s override", got)
	}
}
