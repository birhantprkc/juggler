//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
)

// resetLoginState pins both login-proof latches for a test and restores them on
// cleanup, so ordering with other tests can't leak the process-lifetime state.
func resetLoginState(t *testing.T, state loginState, probed bool) {
	t.Helper()
	prevState := claudeLogin.Load()
	prevProbed := usageProbeAttempted.Load()
	claudeLogin.Store(int32(state))
	usageProbeAttempted.Store(probed)
	t.Cleanup(func() {
		claudeLogin.Store(prevState)
		usageProbeAttempted.Store(prevProbed)
	})
}

// TestUsagePollAllowsOneProbeBeforeLogin verifies a logged-out CLI is spawned at
// most once. Before any sign-in is confirmed, the FIRST poll is permitted (so
// usage lights up for an already-signed-in user on startup) but every subsequent
// poll is skipped WITHOUT spawning `claude`.
// The binary path is pinned to a non-existent file, so a probe that does reach a
// spawn fails on the missing binary rather than the skip guard.
func TestUsagePollAllowsOneProbeBeforeLogin(t *testing.T) {
	resetLoginState(t, loginUnknown, false)
	restore := SetBinaryPathForTesting(filepath.Join(t.TempDir(), "does-not-exist-claude"))
	t.Cleanup(restore)

	// First probe: allowed past the guard, so it fails on the missing binary.
	_, err := (&Client{}).UsageStats(context.Background())
	if err == nil {
		t.Fatalf("expected the first probe to reach the (missing) binary")
	}
	if strings.Contains(err.Error(), "poll skipped") {
		t.Fatalf("first probe should not be skipped, got %v", err)
	}

	// Second probe: latched off, so it bails before any spawn.
	_, err = (&Client{}).UsageStats(context.Background())
	if err == nil || !strings.Contains(err.Error(), "poll skipped") {
		t.Fatalf("expected the second probe to be skipped, got %v", err)
	}
}

// TestUsagePollAlwaysAllowedAfterLogin verifies a confirmed sign-in re-enables
// the poll unconditionally: UsageStats proceeds past the guard (and then fails
// only for the pinned-missing binary, proving it got that far) on every call.
func TestUsagePollAlwaysAllowedAfterLogin(t *testing.T) {
	resetLoginState(t, loginUnknown, true) // already probed once, but not confirmed
	markClaudeLoginConfirmed()
	restore := SetBinaryPathForTesting(filepath.Join(t.TempDir(), "does-not-exist-claude"))
	t.Cleanup(restore)

	for i := 0; i < 2; i++ {
		_, err := (&Client{}).UsageStats(context.Background())
		if err == nil {
			t.Fatalf("expected an error from the missing binary")
		}
		if strings.Contains(err.Error(), "poll skipped") {
			t.Fatalf("guard should stay unlocked after a confirmed login, got %v", err)
		}
	}
}

// TestUsagePollBlockedWhileExpired verifies a known-expired sign-in stops the
// poll outright, including the one probe an unknown state would have allowed.
// We already know what spawning would achieve, and repeating it every tick
// against a CLI that cannot serve is exactly the behaviour the guard exists to
// prevent.
func TestUsagePollBlockedWhileExpired(t *testing.T) {
	resetLoginState(t, loginExpired, false) // not yet probed, but known expired
	restore := SetBinaryPathForTesting(filepath.Join(t.TempDir(), "does-not-exist-claude"))
	t.Cleanup(restore)

	_, err := (&Client{}).UsageStats(context.Background())
	if err == nil || !strings.Contains(err.Error(), "poll skipped") {
		t.Fatalf("expected the probe to be skipped while expired, got %v", err)
	}
}

// TestLoginStateTransitions covers the state machine directly: an expiry is
// recorded from a failed turn, a later successful turn clears it (so signing
// back in restores the provider without a restart), and the re-check drops an
// expiry to unknown rather than claiming a confirmation nothing has earned.
func TestLoginStateTransitions(t *testing.T) {
	resetLoginState(t, loginUnknown, false)

	if got := currentClaudeLoginState(); got != loginUnknown {
		t.Fatalf("initial state = %v, want loginUnknown", got)
	}

	markClaudeLoginExpired()
	if got := currentClaudeLoginState(); got != loginExpired {
		t.Fatalf("after markClaudeLoginExpired state = %v, want loginExpired", got)
	}

	// A real turn succeeding is the strongest evidence there is, and must beat
	// a previously recorded expiry.
	markClaudeLoginConfirmed()
	if got := currentClaudeLoginState(); got != loginConfirmed {
		t.Fatalf("after markClaudeLoginConfirmed state = %v, want loginConfirmed", got)
	}

	// The re-check must not demote a confirmed sign-in.
	clearClaudeLoginExpired()
	if got := currentClaudeLoginState(); got != loginConfirmed {
		t.Fatalf("clearClaudeLoginExpired touched a confirmed state: %v", got)
	}

	markClaudeLoginExpired()
	clearClaudeLoginExpired()
	if got := currentClaudeLoginState(); got != loginUnknown {
		t.Fatalf("after clearing an expiry state = %v, want loginUnknown", got)
	}
}
