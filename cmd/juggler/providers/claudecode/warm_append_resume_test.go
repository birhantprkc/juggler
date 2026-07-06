//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	provider "juggler/cmd/juggler/providers/registry"
	"juggler/internal/userpaths/userpathstest"
)

// seedWarmSession writes a minimal CLI-native session file ending on an
// assistant tool_use, mirroring what the real CLI leaves on disk when it parks
// on a tools/call. Returns the file path.
func seedWarmSession(t *testing.T, workingDir, sessionUUID string, toolUseIDs ...string) string {
	t.Helper()
	dir := projectsDir(workingDir)
	if dir == "" {
		t.Fatal("projectsDir empty (HOME not isolated?)")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir projects: %v", err)
	}
	var toolUseBlocks []map[string]any
	for _, id := range toolUseIDs {
		toolUseBlocks = append(toolUseBlocks, map[string]any{
			"type": "tool_use", "id": id, "name": "bash", "input": map[string]any{"command": "echo hi"},
		})
	}
	userEntry := newSyntheticEntry("user", []map[string]any{{"type": "text", "text": "do the thing"}},
		"uuid-user-1", nil, sessionUUID, workingDir, time.Now())
	asstEntry := newSyntheticEntry("assistant", toolUseBlocks,
		"uuid-asst-1", "uuid-user-1", sessionUUID, workingDir, time.Now())
	var buf strings.Builder
	for _, e := range []map[string]any{userEntry, asstEntry} {
		line, err := json.Marshal(e)
		if err != nil {
			t.Fatalf("marshal seed entry: %v", err)
		}
		buf.Write(line)
		buf.WriteByte('\n')
	}
	path := filepath.Join(dir, sessionUUID+".jsonl")
	if err := os.WriteFile(path, []byte(buf.String()), 0o644); err != nil {
		t.Fatalf("write seed session: %v", err)
	}
	return path
}

// readJSONL parses a JSONL file into a slice of generic entry maps.
func readJSONL(t *testing.T, path string) []map[string]any {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var out []map[string]any
	for _, line := range strings.Split(strings.TrimRight(string(data), "\n"), "\n") {
		if line == "" {
			continue
		}
		var e map[string]any
		if err := json.Unmarshal([]byte(line), &e); err != nil {
			t.Fatalf("unmarshal line %q: %v", line, err)
		}
		out = append(out, e)
	}
	return out
}

// TestAppendToolResultsToWarmSession_HappyPath checks the appended entry closes
// the dangling tool_use: it is a user tool_result chained to the prior tail, in
// the same uuid file, leaving the warm prefix byte-for-byte intact.
func TestAppendToolResultsToWarmSession_HappyPath(t *testing.T) {
	userpathstest.Isolate(t)
	workingDir := filepath.Join(t.TempDir(), "proj")
	if err := os.MkdirAll(workingDir, 0o755); err != nil {
		t.Fatalf("mkdir workingDir: %v", err)
	}
	const uuid = "uuid-warm-append"
	path := seedWarmSession(t, workingDir, uuid, "call_1")
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read seed: %v", err)
	}

	c := &Client{workingDir: workingDir, activeSession: &activeSession{sessionUUID: uuid}}
	results := []provider.Message{toolResultMsg("call_1", "the answer")}
	if err := c.appendToolResultsToWarmSession(results); err != nil {
		t.Fatalf("appendToolResultsToWarmSession: %v", err)
	}

	// The original two entries must be untouched (warm prefix preserved); a third
	// is appended.
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read after: %v", err)
	}
	if !strings.HasPrefix(string(after), string(before)) {
		t.Fatalf("warm prefix was modified — cache would miss.\nbefore:\n%s\nafter:\n%s", before, after)
	}
	entries := readJSONL(t, path)
	if len(entries) != 3 {
		t.Fatalf("expected 3 entries after append; got %d", len(entries))
	}
	last := entries[2]
	if last["type"] != "user" {
		t.Fatalf("appended entry type = %v, want user", last["type"])
	}
	if last["parentUuid"] != "uuid-asst-1" {
		t.Fatalf("appended entry parentUuid = %v, want uuid-asst-1 (chains to the dangling tool_use)", last["parentUuid"])
	}
	if last["sessionId"] != uuid {
		t.Fatalf("appended entry sessionId = %v, want %s (re-resumes the same warm uuid)", last["sessionId"], uuid)
	}
	msg, _ := last["message"].(map[string]any)
	content, _ := msg["content"].([]any)
	if len(content) != 1 {
		t.Fatalf("appended message content = %v, want one tool_result block", msg["content"])
	}
	block, _ := content[0].(map[string]any)
	if block["type"] != "tool_result" || block["tool_use_id"] != "call_1" || block["content"] != "the answer" {
		t.Fatalf("appended block = %+v, want tool_result for call_1 with the answer", block)
	}
}

// TestAppendToolResultsToWarmSession_MissingFile errors (so the caller falls back
// to a fresh synthetic resume) when no warm session file exists on disk.
func TestAppendToolResultsToWarmSession_MissingFile(t *testing.T) {
	userpathstest.Isolate(t)
	workingDir := filepath.Join(t.TempDir(), "proj")
	c := &Client{workingDir: workingDir, activeSession: &activeSession{sessionUUID: "uuid-absent"}}
	if err := c.appendToolResultsToWarmSession([]provider.Message{toolResultMsg("call_1", "x")}); err == nil {
		t.Fatal("expected an error for a missing warm session file (forces fresh fallback); got nil")
	}
}

// TestAppendToolResultsToWarmSession_TailNotToolUse errors when the file's last
// entry is not the dangling assistant tool_use the result answers — appending
// there would break tool_use/tool_result adjacency, so we must cold-start.
func TestAppendToolResultsToWarmSession_TailNotToolUse(t *testing.T) {
	userpathstest.Isolate(t)
	workingDir := filepath.Join(t.TempDir(), "proj")
	if err := os.MkdirAll(workingDir, 0o755); err != nil {
		t.Fatalf("mkdir workingDir: %v", err)
	}
	const uuid = "uuid-tail-text"
	dir := projectsDir(workingDir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir projects: %v", err)
	}
	// A session whose last entry is a plain assistant text turn (no tool_use).
	entry := newSyntheticEntry("assistant", []map[string]any{{"type": "text", "text": "all done"}},
		"uuid-asst-text", nil, uuid, workingDir, time.Now())
	line, _ := json.Marshal(entry)
	path := filepath.Join(dir, uuid+".jsonl")
	if err := os.WriteFile(path, append(line, '\n'), 0o644); err != nil {
		t.Fatalf("write session: %v", err)
	}

	c := &Client{workingDir: workingDir, activeSession: &activeSession{sessionUUID: uuid}}
	if err := c.appendToolResultsToWarmSession([]provider.Message{toolResultMsg("call_1", "x")}); err == nil {
		t.Fatal("expected an error when the tail entry isn't a tool_use; got nil")
	}
}

// TestWarmAppendResume_EndToEndResumesWarm drives the user-reported bug all the
// way through dispatch with a REAL warm session file on disk: a tool is parked,
// the live CLI is gone, and the continuation carries the cancelled result plus a
// fresh user message. The turn must re-resume the SAME warm uuid (proving the
// prompt cache stays warm — not a fresh synthetic cold start) and the warm file
// must gain the paired tool_result entry.
func TestWarmAppendResume_EndToEndResumesWarm(t *testing.T) {
	userpathstest.Isolate(t)
	const warmUUID = "uuid-warm-e2e"
	tracePath := installFakeClaude(t, fakeModeUntilClose, warmUUID)
	c := mkClient(t, "claude-sonnet-4-6")
	convID := "conv-warm-e2e"

	// Seed the CLI's own warm session file, ending on the assistant tool_use the
	// worker parked on (what the real CLI leaves on disk).
	path := seedWarmSession(t, c.workingDir, warmUUID, "t1")

	// Anchor the resume at the park: only the user prompt was fed (the assistant
	// tool_use is in the warm file but not in sentCount). No live CLI, no pending
	// tools — exactly the post-cancel / post-restart shape.
	fed := []provider.Message{userMsg("do the thing")}
	c.activeSession = &activeSession{
		sessionUUID: warmUUID,
		sentCount:   len(fed),
		sentHash:    hashRequestPrefix("sys", fed, len(fed)),
		model:       c.model,
	}

	// Continuation: the doc holds the assistant tool_use, t1's cancelled result,
	// and the user's fresh message.
	cont := []provider.Message{
		userMsg("do the thing"),
		toolUseMsg("t1", "bash"),
		toolResultMsg("t1", "Cancelled"),
		userMsg("do this instead"),
	}
	if res := sendMsg(t, c, convID, cont); res.StopReason != "end_turn" {
		t.Fatalf("warm-append turn: StopReason = %q, want end_turn", res.StopReason)
	}

	// The spawn must have --resumed the warm uuid, NOT a freshly-minted synthetic
	// one (which is what a cold fallback would do).
	trace := readTrace(t, tracePath)
	if len(trace) == 0 {
		t.Fatal("no CLI spawn recorded")
	}
	last := trace[len(trace)-1]
	if last.ResumeID != warmUUID {
		t.Fatalf("warm-append spawn ResumeID = %q, want %q (a fresh synthetic uuid means it cold-started instead of warm-appending)", last.ResumeID, warmUUID)
	}

	// The warm file must now carry the paired tool_result, appended after the
	// dangling tool_use (warm prefix preserved, three entries total).
	entries := readJSONL(t, path)
	if len(entries) != 3 {
		t.Fatalf("warm file = %d entries, want 3 (user, assistant tool_use, appended user tool_result)", len(entries))
	}
	last3 := entries[2]
	if last3["type"] != "user" || last3["parentUuid"] != "uuid-asst-1" {
		t.Fatalf("appended entry = %+v, want a user tool_result chained to uuid-asst-1", last3)
	}
	msg, _ := last3["message"].(map[string]any)
	content, _ := msg["content"].([]any)
	if len(content) != 1 {
		t.Fatalf("appended content = %v, want one tool_result block", msg["content"])
	}
	block, _ := content[0].(map[string]any)
	if block["type"] != "tool_result" || block["tool_use_id"] != "t1" || block["content"] != "Cancelled" {
		t.Fatalf("appended block = %+v, want tool_result for t1 with Cancelled", block)
	}
}

// TestAppendToolResultsToWarmSession_UnmatchedResult errors when the result's id
// doesn't match a tool_use the warm file is dangling on.
func TestAppendToolResultsToWarmSession_UnmatchedResult(t *testing.T) {
	userpathstest.Isolate(t)
	workingDir := filepath.Join(t.TempDir(), "proj")
	if err := os.MkdirAll(workingDir, 0o755); err != nil {
		t.Fatalf("mkdir workingDir: %v", err)
	}
	const uuid = "uuid-mismatch"
	seedWarmSession(t, workingDir, uuid, "call_1")
	c := &Client{workingDir: workingDir, activeSession: &activeSession{sessionUUID: uuid}}
	if err := c.appendToolResultsToWarmSession([]provider.Message{toolResultMsg("other_call", "x")}); err == nil {
		t.Fatal("expected an error when the result id doesn't match the dangling tool_use; got nil")
	}
}
