//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"context"
	"strings"
	"testing"

	provider "juggler/cmd/juggler/providers/registry"
)

func TestContinuationNudgeForRequest_DistinguishesHumanContinue(t *testing.T) {
	generic := continuationNudgeForRequest(provider.MessageRequest{})
	if generic != continuationNudge {
		t.Fatalf("generic nudge = %q, want %q", generic, continuationNudge)
	}

	explicit := continuationNudgeForRequest(provider.MessageRequest{ExplicitContinuation: true})
	if explicit != explicitContinuationNudge {
		t.Fatalf("explicit nudge = %q, want explicit continuation cue", explicit)
	}
	if !strings.HasPrefix(explicit, "<system-reminder>") || !strings.HasSuffix(explicit, "</system-reminder>") {
		t.Fatalf("explicit cue lost system-reminder framing: %q", explicit)
	}
	if !strings.Contains(explicit, "most recent request") || !strings.Contains(explicit, "necessary tool calls") {
		t.Fatalf("explicit cue does not instruct Claude to finish the interrupted work: %q", explicit)
	}
	if !strings.Contains(explicit, "message authored by the user") {
		t.Fatalf("explicit cue does not prevent user attribution: %q", explicit)
	}
}

// regenerateMsgs is the shape a regenerate produces: the committed prefix plus
// the assistant reply the CLI itself generated last turn, with no new user
// content. The resume anchor is captured from the REQUEST, so it stops short of
// that reply — the delta is exactly one assistant turn.
func regenerateMsgs() []provider.Message {
	return []provider.Message{
		userMsg("the original question"),
		assistantMsg("the answer the CLI just generated"),
	}
}

// TestRegenerate_NudgesLiveSessionInsteadOfColdStarting is the cache-miss
// regression.
//
// An all-assistant delta serialises to zero stdin lines, because
// formatMessagesAsStreamJSONLines drops assistant content by design — it is
// already in the CLI's own --resume session. Treating that emptiness as
// "unresumable" and cold-starting throws away a live, fully warm CLI and
// re-ingests the entire conversation: the 88,993-token miss this guards.
//
// The correct move is the nudge: the CLI holds the whole conversation, so it
// needs a prompt to generate from, not a new session. The assertion is spawn
// count — a second spawn IS the cold start.
func TestRegenerate_NudgesLiveSessionInsteadOfColdStarting(t *testing.T) {
	tracePath := installFakeClaude(t, fakeModeUntilClose, "uuid-regenerate")
	c := mkClient(t, "claude-sonnet-4-6")
	convID := "conv-regenerate"
	ctx := context.Background()

	// Turn 1 establishes the warm session and the resume anchor.
	if _, err := c.streamMessage(ctx, provider.MessageRequest{
		ConversationID: convID, SystemPrompt: "sys",
		Messages: []provider.Message{userMsg("the original question")},
	}, nopCallback()); err != nil {
		t.Fatalf("turn 1: %v", err)
	}
	if n := len(readTrace(t, tracePath)); n != 1 {
		t.Fatalf("turn 1 spawned %d CLIs; want exactly 1", n)
	}

	// The regenerate must classify as a warm resume-delta — if it doesn't,
	// this test is exercising the wrong path and its result means nothing.
	msgs := regenerateMsgs()
	assertRegime(t, c, msgs, regimeResumeDelta, "", "regenerate")

	if _, err := c.streamMessage(ctx, provider.MessageRequest{
		ConversationID: convID, SystemPrompt: "sys", Messages: msgs,
	}, nopCallback()); err != nil {
		t.Fatalf("regenerate turn: %v", err)
	}

	trace := readTrace(t, tracePath)
	if len(trace) != 1 {
		t.Errorf("regenerate spawned %d CLIs; want 1 — a second spawn is a cold start that "+
			"re-ingests the whole conversation. Spawn #2 resume id: %q",
			len(trace), trace[len(trace)-1].ResumeID)
	}

	c.dropSession(convID)
}

// TestRegenerate_WithDeadCLIResumesSameSession covers the same empty delta when
// the persistent CLI is gone (app restart, watchdog re-exec, crash). The
// session file on disk is still warm, so the respawn must --resume THAT uuid
// and cache-hit. Minting a fresh synthetic uuid instead would re-ingest the
// whole conversation — a cold start wearing a resume flag.
func TestRegenerate_WithDeadCLIResumesSameSession(t *testing.T) {
	tracePath := installFakeClaude(t, fakeModeUntilClose, "uuid-regenerate-dead")
	c := mkClient(t, "claude-sonnet-4-6")
	convID := "conv-regenerate-dead"
	ctx := context.Background()

	if _, err := c.streamMessage(ctx, provider.MessageRequest{
		ConversationID: convID, SystemPrompt: "sys",
		Messages: []provider.Message{userMsg("the original question")},
	}, nopCallback()); err != nil {
		t.Fatalf("turn 1: %v", err)
	}

	// Kill the live CLI, keeping the session (the restart case).
	c.activeSession.tearDownLiveCLI()

	if _, err := c.streamMessage(ctx, provider.MessageRequest{
		ConversationID: convID, SystemPrompt: "sys", Messages: regenerateMsgs(),
	}, nopCallback()); err != nil {
		t.Fatalf("regenerate turn: %v", err)
	}

	trace := readTrace(t, tracePath)
	if len(trace) != 2 {
		t.Fatalf("expected exactly 2 spawns (turn 1, then the respawn); got %d", len(trace))
	}
	if got := trace[1].ResumeID; got != "uuid-regenerate-dead" {
		t.Errorf("respawn resumed %q; want uuid-regenerate-dead — resuming the warm session "+
			"file is what makes this a cache hit rather than a full re-ingest", got)
	}

	c.dropSession(convID)
}
