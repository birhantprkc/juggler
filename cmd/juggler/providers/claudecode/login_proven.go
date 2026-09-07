//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"sync/atomic"
	"time"
)

// loginState is what this process knows about the CLI's sign-in. Juggler holds
// no Anthropic credential of its own — the CLI owns its OAuth entirely — so this
// is knowledge gathered from what the CLI did, never read from a token store.
// Reading the store directly was considered and rejected: it is the macOS
// Keychain on one platform and a file on the others, its schema is internal and
// undocumented, and token rotation can leave the two disagreeing.
type loginState int32

const (
	// loginUnknown is the startup state: no turn has run and nothing has been
	// observed either way. Treated as usable, because a working setup is by far
	// the common case and refusing to try would strand every user we cannot
	// prove is signed in.
	loginUnknown loginState = iota

	// loginConfirmed means the CLI served something this process saw: a clean
	// turn result, or a successful /usage probe.
	loginConfirmed

	// loginExpired means the CLI refused a real turn on authentication grounds.
	// Only an actual failed call sets this — never a probe, whose verdict is not
	// reliable enough to disable a provider on.
	loginExpired
)

// claudeLogin holds a loginState. Atomic rather than actor-owned because it is a
// single scalar read on the usage-poll path and written from the parser
// goroutine; there is no invariant spanning it and anything else.
var claudeLogin atomic.Int32

// usageProbeRetryInterval is how long a failed passive /usage probe holds the
// latch shut. It has to be long enough that a tick every few seconds cannot turn
// into a spawn every few seconds, and short enough that a probe lost to a slow
// or busy CLI heals on its own rather than waiting for the user to happen to
// send a message.
const usageProbeRetryInterval = 5 * time.Minute

// usageProbeAt holds the instant of the last passive /usage spawn permitted while
// the sign-in is still unknown, as Unix nanoseconds (0 = never). See
// claudeUsagePollAllowed.
var usageProbeAt atomic.Int64

// usageProbeNow reads the clock the probe latch ages against, replaced in tests
// to step over usageProbeRetryInterval without waiting it out.
var usageProbeNow = time.Now

// markClaudeLoginConfirmed records that the CLI is signed in. Called from the
// result parser on a clean turn and from UsageStats on a successful probe;
// idempotent and cheap. It also clears a previous expiry, so signing back in and
// running a turn restores the provider without a restart.
func markClaudeLoginConfirmed() { claudeLogin.Store(int32(loginConfirmed)) }

// markClaudeLoginExpired records that the CLI refused a turn because it is not
// authenticated. Called from the result parser when the CLI reports an auth
// failure, which is the only evidence strong enough to justify it: the state
// gates the provider's readiness, so a false positive here takes away the user's
// only way of working.
func markClaudeLoginExpired() { claudeLogin.Store(int32(loginExpired)) }

// clearClaudeLoginExpired returns an expired state to unknown, leaving any other
// state alone. This is the re-check path: the user has been told to sign in, and
// says they have. We drop back to "unknown" rather than to "confirmed" because
// nothing has actually served a turn yet — only a real turn earns confirmation.
func clearClaudeLoginExpired() {
	claudeLogin.CompareAndSwap(int32(loginExpired), int32(loginUnknown))
}

// currentClaudeLoginState reports what this process knows about the CLI sign-in.
func currentClaudeLoginState() loginState { return loginState(claudeLogin.Load()) }

// claudeUsagePollAllowed reports whether the passive /usage poll may spawn the
// CLI right now.
//
// The poll must not spawn `claude` on every tick against a CLI that cannot serve
// it: at best that is a pointless process per tick, and on a logged-out CLI it
// risks provoking an interactive login. Once a sign-in is confirmed the poll is
// always allowed. A known-expired sign-in blocks it outright — we already know
// what the answer would be. While the state is unknown it permits one probe per
// usageProbeRetryInterval: that spawn lights up usage for an already-signed-in
// user, and if the CLI cannot serve it the latch stops every later tick from
// spawning again until either a real turn settles the question or the interval
// is up. It ages rather than latching for the life of the process because the
// probe fails for reasons that pass — a CLI too slow to answer inside the
// timeout, a machine still waking up — and a single unlucky probe at startup
// must not leave usage blank until the user next sends a message.
func claudeUsagePollAllowed() bool {
	switch currentClaudeLoginState() {
	case loginConfirmed:
		return true
	case loginExpired:
		return false
	default:
		return claimUsageProbe()
	}
}

// claimUsageProbe reports whether a probe may spawn now, recording it when it
// may. The compare-and-swap keeps concurrent pollers to one spawn between them.
func claimUsageProbe() bool {
	now := usageProbeNow().UnixNano()
	for {
		last := usageProbeAt.Load()
		if last != 0 && now-last < int64(usageProbeRetryInterval) {
			return false
		}
		if usageProbeAt.CompareAndSwap(last, now) {
			return true
		}
	}
}
