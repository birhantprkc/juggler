//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import "sync/atomic"

// claudeLoginConfirmed records whether the CLI has been proven signed in this
// process lifetime — either by a clean turn (a logged-out CLI never reaches a
// result event; it stops to prompt for an interactive login first) or by a
// passive /usage spawn that returned successfully. Once set it stays set.
var claudeLoginConfirmed atomic.Bool

// usageProbeAttempted latches the single passive /usage spawn we permit before a
// sign-in has been confirmed. See claudeUsagePollAllowed.
var usageProbeAttempted atomic.Bool

// markClaudeLoginConfirmed records that the CLI is signed in. Called from the
// result parser on a clean turn and from UsageStats on a successful probe;
// idempotent and cheap.
func markClaudeLoginConfirmed() { claudeLoginConfirmed.Store(true) }

// claudeUsagePollAllowed reports whether the passive /usage poll may spawn the
// CLI right now.
//
// Spawning `claude` while logged out opens the browser auth page, so the poll
// must never fire every tick against a logged-out CLI. Once a sign-in is
// confirmed the poll is always allowed. Before then it permits exactly ONE probe
// per process: that single spawn lights up usage for an already-signed-in user,
// and if the CLI is logged out the latch stops every later tick from spawning
// again until a real turn confirms the login.
func claudeUsagePollAllowed() bool {
	if claudeLoginConfirmed.Load() {
		return true
	}
	// Not yet confirmed: permit one probe, then latch off until a turn confirms.
	return !usageProbeAttempted.Swap(true)
}
