//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build windows

// On Windows, os.Signal fan-out is exercised using os.Interrupt (Ctrl+C)
// delivered via os.FindProcess(os.Getpid()).Signal(os.Interrupt). This calls
// GenerateConsoleCtrlEvent(CTRL_C_EVENT, pid), which targets the Windows
// process group whose identifier equals our PID. That group exists only when
// the test binary was started with CREATE_NEW_PROCESS_GROUP (or is itself the
// root of a new group). When the condition does not hold the call returns an
// error and the test skips gracefully — the fan-out property is then fully
// covered by the Unix counterpart in signal_fanout_test.go.
package app

import (
	"os"
	"os/signal"
	"testing"
	"time"
)

// selfInterrupt attempts to send os.Interrupt to the current process. The
// call succeeds (and is isolated to our process group) only when this binary
// is the root of its own Windows process group. If the call fails — because
// our PID is not a process group identifier — the test is skipped.
func selfInterrupt(t *testing.T) {
	t.Helper()
	p, err := os.FindProcess(os.Getpid())
	if err != nil {
		t.Fatalf("FindProcess(self): %v", err)
	}
	if err := p.Signal(os.Interrupt); err != nil {
		t.Skipf("self os.Interrupt unavailable (process not a group root): %v", err)
	}
}

// TestSignalNotifyFansOutToMultipleChannels exercises the assumption that
// underpins the dual-channel emergency-exit signal handler in app_wait.go:
// a single Ctrl+C delivery must reach BOTH the "graceful" channel and the
// independent "emergency" channel, so a wedged graceful path can never
// starve the force-quit path. If this test fails, the 3rd-Ctrl-C
// guarantee is void and the handler must be redesigned.
func TestSignalNotifyFansOutToMultipleChannels(t *testing.T) {
	a := make(chan os.Signal, 4)
	b := make(chan os.Signal, 4)
	signal.Notify(a, os.Interrupt)
	signal.Notify(b, os.Interrupt)
	defer signal.Stop(a)
	defer signal.Stop(b)

	selfInterrupt(t)

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

// TestSignalNotifyDeliversBurstToBothChannelsIndependently confirms that a
// burst of three Ctrl+C events arrives in full on both channels even if one
// channel is being drained slowly. The emergency-exit goroutine counts to
// three; if signal.Notify dropped any of the three because the graceful
// channel was slow to drain, the user's Ctrl-C × 3 would silently fail to
// escalate.
func TestSignalNotifyDeliversBurstToBothChannelsIndependently(t *testing.T) {
	slow := make(chan os.Signal, 8)
	fast := make(chan os.Signal, 8)
	signal.Notify(slow, os.Interrupt)
	signal.Notify(fast, os.Interrupt)
	defer signal.Stop(slow)
	defer signal.Stop(fast)

	p, err := os.FindProcess(os.Getpid())
	if err != nil {
		t.Fatalf("FindProcess(self): %v", err)
	}
	for i := 0; i < 3; i++ {
		if err := p.Signal(os.Interrupt); err != nil {
			t.Skipf("self os.Interrupt unavailable (process not a group root): %v", err)
		}
		// Tiny pause so the runtime has time to deliver before the next
		// event — without it the kernel may coalesce identical pending
		// Ctrl+C events.
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
