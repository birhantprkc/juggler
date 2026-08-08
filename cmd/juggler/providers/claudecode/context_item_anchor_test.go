//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"strings"
	"testing"

	provider "juggler/cmd/juggler/providers/registry"
)

func contextItemMsg(content string) provider.Message {
	return provider.Message{Type: "context-item", Content: content}
}

// TestStablePrefixCount_StripsTrailingContextRun verifies the anchor length
// excludes only the trailing volatile standing-context run, never conversation
// history or a context item that happens to sit mid-history.
func TestStablePrefixCount_StripsTrailingContextRun(t *testing.T) {
	cases := []struct {
		name string
		msgs []provider.Message
		want int
	}{
		{"no context items", []provider.Message{userMsg("a"), assistantMsg("b")}, 2},
		{"one trailing context item", []provider.Message{userMsg("a"), assistantMsg("b"), contextItemMsg("todo")}, 2},
		{"several trailing context items", []provider.Message{userMsg("a"), contextItemMsg("todo"), contextItemMsg("file"), contextItemMsg("plan")}, 1},
		{"all context items", []provider.Message{contextItemMsg("todo"), contextItemMsg("file")}, 0},
		{"empty", nil, 0},
		{
			// A context item mid-history (before later conversation) is NOT part
			// of the trailing run, so it stays inside the stable prefix.
			"context item not at the tail",
			[]provider.Message{userMsg("a"), contextItemMsg("stale"), userMsg("b"), contextItemMsg("todo")},
			3,
		},
		{
			// A LEADING "prefix" context item (frozen pinned/dropped file placed
			// before history) is part of the committed stable prefix — only the
			// trailing run is stripped, and there is none here.
			"leading prefix context item, no trailing run",
			[]provider.Message{contextItemMsg("pinned file"), userMsg("a"), assistantMsg("b")},
			3,
		},
		{
			// Leading prefix item AND a trailing live one: strip only the trailing
			// one; the leading prefix + history stay in the stable prefix.
			"leading prefix stays, trailing live stripped",
			[]provider.Message{contextItemMsg("pinned file"), userMsg("a"), contextItemMsg("todo")},
			2,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := stablePrefixCount(tc.msgs); got != tc.want {
				t.Fatalf("stablePrefixCount = %d, want %d", got, tc.want)
			}
		})
	}
}

// TestCaptureSentPrefix_ExcludesTrailingContextItems is the regression guard for
// the cache-busting bug: standing context items (todo list, pinned-file
// contents) ride as trailing messages, re-rendered live every turn. If the
// resume anchor counted them, the growing conversation would displace their
// positions and the next turn would always read "diverged" → a full cold-start
// re-ingest of the whole conversation, every turn.
//
// The anchor must instead stop at the last stable (non-context) message, so a
// grown conversation with freshly re-rendered context still resumes WARM, with
// the new turn plus the current context as the delta.
func TestCaptureSentPrefix_ExcludesTrailingContextItems(t *testing.T) {
	sys := "you are helpful"

	// Turn N: two real conversation messages, then a live-rendered context item.
	turnN := []provider.Message{
		userMsg("first question"),
		assistantMsg("first answer"),
		contextItemMsg("=== Context: todo ===\n[ ] step one"),
	}
	sess := &activeSession{sessionUUID: "uuid-ctx"}
	sess.captureSentPrefix(sys, turnN)

	if sess.sentCount != 2 {
		t.Fatalf("sentCount = %d, want 2 (the trailing context item must be excluded)", sess.sentCount)
	}

	// Turn N+1: the conversation grew by a new user turn AND the context item
	// re-rendered to a different live state. Both are exactly the changes that
	// broke the old len(messages) anchor.
	turnN1 := []provider.Message{
		userMsg("first question"),
		assistantMsg("first answer"),
		userMsg("second question"),
		contextItemMsg("=== Context: todo ===\n[x] step one"),
	}

	start, end, ok, reason := canResumeWithDelta(sess, sys, turnN1)
	if !ok {
		t.Fatalf("expected a warm resume, got cold start reason=%q", reason)
	}
	// Delta must be the new user turn plus the freshly-rendered context item.
	if start != 2 || end != len(turnN1) {
		t.Fatalf("delta range = [%d,%d), want [2,%d)", start, end, len(turnN1))
	}

	// Full routing: with no live CLI this is a plain user delta, so it warm
	// resumes via regimeResumeDelta rather than cold-starting.
	dec := classifyRegime(sess, "opus", sys, turnN1, false /* no live CLI */)
	if dec.Regime != regimeResumeDelta {
		t.Fatalf("grown conversation with re-rendered context must resume warm (regimeResumeDelta); got regime=%d reason=%q", dec.Regime, dec.Reason)
	}
}

// TestDiagnoseDivergence_DistinguishesShiftFromEdit proves the diagnostic can
// tell a structural prefix shift (a history item that inserted a wire message —
// e.g. a thread/delegated-tool result landing) from an in-place content edit, so
// the cache-miss log names the real destabiliser.
func TestDiagnoseDivergence_DistinguishesShiftFromEdit(t *testing.T) {
	sys := "sys"
	base := []provider.Message{
		userMsg("a"),
		toolUseMsg("call_1", "explore_code"), // thread tool_use, result pending
		assistantMsg("b"),
		userMsg("c"),
	}
	sess := &activeSession{sessionUUID: "u"}
	sess.captureSentPrefix(sys, base)

	// The thread result lands: a tool_result is now inserted after the tool_use,
	// sliding assistantMsg("b") and everything after it down one slot.
	shifted := []provider.Message{
		userMsg("a"),
		toolUseMsg("call_1", "explore_code"),
		toolResultMsg("call_1", "explored"), // <-- newly rendered
		assistantMsg("b"),
		userMsg("c"),
	}
	got := diagnoseDivergence(sess, sys, shifted)
	if !strings.Contains(got, "message[2]") || !strings.Contains(got, "shifted") || !strings.Contains(got, "INSERTED") {
		t.Fatalf("expected a prefix-shift diagnosis at message[2], got %q", got)
	}

	// An in-place edit must NOT be mislabelled as a shift.
	edited := append([]provider.Message{}, base...)
	edited[2] = assistantMsg("b-edited")
	got = diagnoseDivergence(sess, sys, edited)
	if !strings.Contains(got, "message[2]") || !strings.Contains(got, "in place") {
		t.Fatalf("expected an in-place edit diagnosis at message[2], got %q", got)
	}
}

// TestCaptureSentPrefix_ContextChurnAloneStaysWarm covers the steady-state
// churn case: the conversation did NOT grow, but the standing context re-rendered
// (a todo item ticked). The stable prefix is unchanged, so the turn still resumes
// warm — the sole delta is the updated context item.
func TestCaptureSentPrefix_ContextChurnAloneStaysWarm(t *testing.T) {
	sys := "sys"
	turnN := []provider.Message{
		userMsg("do the thing"),
		contextItemMsg("todo v1"),
	}
	sess := &activeSession{sessionUUID: "uuid-churn"}
	sess.captureSentPrefix(sys, turnN)
	if sess.sentCount != 1 {
		t.Fatalf("sentCount = %d, want 1", sess.sentCount)
	}

	turnN1 := []provider.Message{
		userMsg("do the thing"),
		contextItemMsg("todo v2"),
	}
	if _, _, ok, reason := canResumeWithDelta(sess, sys, turnN1); !ok {
		t.Fatalf("context churn alone must stay warm, got cold start reason=%q", reason)
	}
}
