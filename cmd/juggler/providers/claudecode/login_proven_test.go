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
func resetLoginState(t *testing.T, confirmed, probed bool) {
	t.Helper()
	prevConfirmed := claudeLoginConfirmed.Load()
	prevProbed := usageProbeAttempted.Load()
	claudeLoginConfirmed.Store(confirmed)
	usageProbeAttempted.Store(probed)
	t.Cleanup(func() {
		claudeLoginConfirmed.Store(prevConfirmed)
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
	resetLoginState(t, false, false)
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
	resetLoginState(t, false, true) // already probed once, but not confirmed
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
