//go:build !windows

//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// SIGUSR1 and syscall.Kill are Unix-only; the signal.Notify fan-out guarantee
// this asserts is exercised on the platforms where the emergency-exit handler
// in app_wait.go relies on it.
package app

import (
	"os"
	"os/signal"
	"syscall"
	"testing"
	"time"
)

// TestSignalNotifyFansOutToMultipleChannels exercises the assumption that
// underpins the dual-channel emergency-exit signal handler in app_wait.go:
// a single SIGINT delivery must reach BOTH the "graceful" channel and the
// independent "emergency" channel, so a wedged graceful path can never
// starve the force-quit path. If this test fails, the 3rd-Ctrl-C
// guarantee is void and the handler must be redesigned.
func TestSignalNotifyFansOutToMultipleChannels(t *testing.T) {
	a := make(chan os.Signal, 4)
	b := make(chan os.Signal, 4)
	signal.Notify(a, syscall.SIGUSR1)
	signal.Notify(b, syscall.SIGUSR1)
	defer signal.Stop(a)
	defer signal.Stop(b)

	// SIGUSR1 not SIGINT — running `go test` shouldn't kill itself.
	if err := syscall.Kill(syscall.Getpid(), syscall.SIGUSR1); err != nil {
		t.Fatalf("kill: %v", err)
	}

	for _, ch := range []struct {
		name string
		c    chan os.Signal
	}{{"a", a}, {"b", b}} {
		select {
		case <-ch.c:
		case <-time.After(2 * time.Second):
			t.Fatalf("signal did not arrive on channel %s — signal.Notify does not fan out, dual-channel emergency-exit design is broken", ch.name)
		}
	}
}

// TestSignalNotifyDeliversBurstToBothChannelsIndependently confirms that
// a burst of three signals arrives in full on both channels even if one
// channel is being drained slowly. The emergency-exit goroutine counts
// to three; if signal.Notify dropped any of the three presses because
// the graceful channel was slow to drain, the user's Ctrl-C × 3 would
// silently fail to escalate.
func TestSignalNotifyDeliversBurstToBothChannelsIndependently(t *testing.T) {
	slow := make(chan os.Signal, 8)
	fast := make(chan os.Signal, 8)
	signal.Notify(slow, syscall.SIGUSR2)
	signal.Notify(fast, syscall.SIGUSR2)
	defer signal.Stop(slow)
	defer signal.Stop(fast)

	for i := 0; i < 3; i++ {
		if err := syscall.Kill(syscall.Getpid(), syscall.SIGUSR2); err != nil {
			t.Fatalf("kill #%d: %v", i, err)
		}
		// Tiny pause so the runtime has time to deliver before the next
		// kill — without it the kernel may coalesce identical pending
		// signals (POSIX permits this for non-realtime signals). The
		// emergency handler's worst case is realistic user keystrokes,
		// which are tens of ms apart minimum.
		time.Sleep(20 * time.Millisecond)
	}

	deadline := time.After(2 * time.Second)
	fastCount, slowCount := 0, 0
	for fastCount < 3 || slowCount < 3 {
		select {
		case <-fast:
			fastCount++
		case <-slow:
			slowCount++
		case <-deadline:
			t.Fatalf("burst undercounted: fast=%d slow=%d (need 3 each) — signal.Notify dropping in burst", fastCount, slowCount)
		}
	}
}
