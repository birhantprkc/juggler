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

	// slow is never read inside the loop — it stands in for the graceful
	// path sitting on its signal while the user keeps pressing. Each press
	// is sent only once fast has seen the previous one, which proves the
	// runtime's handler has already run for it: POSIX lets the kernel
	// coalesce a non-realtime signal that is still pending, and on a loaded
	// machine a press sent blind on a timer is swallowed there rather than
	// by signal.Notify, which is what this asserts about.
	for i := 0; i < 3; i++ {
		if err := syscall.Kill(syscall.Getpid(), syscall.SIGUSR2); err != nil {
			t.Fatalf("kill #%d: %v", i+1, err)
		}
		select {
		case <-fast:
		case <-time.After(2 * time.Second):
			t.Fatalf("press #%d never arrived on the fast channel", i+1)
		}
	}

	for i := 0; i < 3; i++ {
		select {
		case <-slow:
		case <-time.After(2 * time.Second):
			t.Fatalf("undrained channel holds only %d of 3 presses — signal.Notify drops when a receiver is slow, so Ctrl-C × 3 cannot escalate", i)
		}
	}
}
