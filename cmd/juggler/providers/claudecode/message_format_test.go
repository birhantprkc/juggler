//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"encoding/json"
	"strings"
	"testing"

	provider "juggler/cmd/juggler/providers/registry"
)

// TestFormatMessagesCoalescesToSingleEnvelope guards the load-bearing
// invariant that one juggler StreamMessage turn writes exactly ONE
// stream-json user envelope to the persistent CLI's stdin. The CLI answers
// each '\n'-terminated envelope as its own turn, but readUntilPauseOrComplete
// reads exactly one terminal turn per call — so emitting more than one
// envelope leaves the surplus turns' responses buffered and mis-attributed
// to a later message (the "submitted-read gap" sync warning).
//
// A history of user/assistant/user/assistant/user (assistant turns split the
// users apart, so TransformToAPIMessages can't group them) must still produce
// a single envelope carrying every user content block.
func TestFormatMessagesCoalescesToSingleEnvelope(t *testing.T) {
	c := &Client{}
	msgs := []provider.Message{
		{Type: "user", Content: "first"},
		{Type: "assistant", Content: "answer one"},
		{Type: "user", Content: "second"},
		{Type: "assistant", Content: "answer two"},
		{Type: "user", Content: "third"},
	}

	lines, err := c.formatMessagesAsStreamJSONLines(msgs, "sess-1")
	if err != nil {
		t.Fatalf("formatMessagesAsStreamJSONLines: %v", err)
	}
	if len(lines) != 1 {
		t.Fatalf("got %d envelope line(s); want exactly 1 (one turn == one envelope). Lines: %v", len(lines), lines)
	}

	// The single envelope must carry every user content block, in order, and
	// must NOT carry the dropped assistant turns.
	var env struct {
		Type    string `json:"type"`
		Message struct {
			Role    string `json:"role"`
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		} `json:"message"`
		SessionID string `json:"session_id"`
	}
	if err := json.Unmarshal([]byte(lines[0]), &env); err != nil {
		t.Fatalf("unmarshal envelope: %v", err)
	}
	if env.Type != "user" || env.Message.Role != "user" {
		t.Fatalf("envelope role = %q/%q; want user/user", env.Type, env.Message.Role)
	}
	if env.SessionID != "sess-1" {
		t.Fatalf("session_id = %q; want sess-1", env.SessionID)
	}
	var texts []string
	for _, b := range env.Message.Content {
		if b.Type == "text" {
			texts = append(texts, b.Text)
		}
	}
	got := strings.Join(texts, "|")
	if got != "first|second|third" {
		t.Fatalf("coalesced user text = %q; want first|second|third (assistant turns dropped, user blocks preserved in order)", got)
	}
}

// TestFormatMessagesNoUserMessagesReturnsEmpty confirms a delta with no
// user-role content produces no envelope (callers treat empty as "nothing
// to send" and fall back).
func TestFormatMessagesNoUserMessagesReturnsEmpty(t *testing.T) {
	c := &Client{}
	lines, err := c.formatMessagesAsStreamJSONLines([]provider.Message{
		{Type: "assistant", Content: "only an assistant turn"},
	}, "sess-2")
	if err != nil {
		t.Fatalf("formatMessagesAsStreamJSONLines: %v", err)
	}
	if len(lines) != 0 {
		t.Fatalf("got %d line(s); want 0 for an all-assistant delta", len(lines))
	}
}

// TestDisallowedNativeToolsCoversCollidingNames guards the deny list that
// keeps the CLI's own built-ins switched off. A built-in whose name collides
// with a juggler tool is the dangerous case: canonicalToolName strips the
// absent mcp__juggler__ prefix, the parser dispatches the block as juggler's
// own, and the CLI answers its native call itself — so juggler's result finds
// no parked tools/call, stashes forever, and the conversation hangs until
// teardown. Monitor is the name that actually did this in the wild.
func TestDisallowedNativeToolsCoversCollidingNames(t *testing.T) {
	denied := map[string]bool{}
	for _, name := range disallowedNativeTools {
		if denied[name] {
			t.Errorf("duplicate entry %q in disallowedNativeTools", name)
		}
		denied[name] = true
	}
	// Names juggler serves itself that are ALSO Claude-native built-ins.
	for _, name := range []string{"Monitor", "Read", "Write", "Edit", "Bash", "Grep", "Glob", "WebFetch", "WebSearch", "AskUserQuestion", "Skill", "TaskOutput", "TaskStop", "KillShell"} {
		if !denied[name] {
			t.Errorf("%q is both a CLI built-in and a juggler tool but is not in disallowedNativeTools — a call to it deadlocks the conversation", name)
		}
	}
}

// TestCommonArgsDisallowsNativeTools confirms the deny list actually reaches
// the CLI: --disallowedTools must carry every entry, comma-joined.
func TestCommonArgsDisallowsNativeTools(t *testing.T) {
	c := &Client{}
	args := c.commonArgs("sys")
	idx := -1
	for i, a := range args {
		if a == "--disallowedTools" {
			idx = i
			break
		}
	}
	if idx < 0 {
		t.Skip("no MCP config in this environment, so no --disallowedTools flag")
	}
	if idx+1 >= len(args) {
		t.Fatal("--disallowedTools passed with no value")
	}
	got := strings.Split(args[idx+1], ",")
	if len(got) != len(disallowedNativeTools) {
		t.Fatalf("--disallowedTools carries %d entries, want %d", len(got), len(disallowedNativeTools))
	}
	for i, want := range disallowedNativeTools {
		if got[i] != want {
			t.Errorf("--disallowedTools[%d] = %q, want %q", i, got[i], want)
		}
	}
}
