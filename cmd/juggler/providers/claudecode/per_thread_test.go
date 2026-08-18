//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	provider "juggler/cmd/juggler/providers/registry"
)

// TestSubthread_InMemoryOnly pins the per-thread CLI contract: a sub-thread
// handle (threadID != "") gets its own in-memory session (own warm CLI) but
// must NEVER touch the conversation-level on-disk sidecar — neither writing it
// (which would clobber the root thread's warm-resume anchor with the
// sub-thread's session) nor reading it. The root thread's sidecar behaviour is
// covered by sidecar_release_test.go.
func TestSubthread_InMemoryOnly(t *testing.T) {
	installFakeClaude(t, fakeModeUntilClose, "uuid-subthread")
	c := mkClient(t, "claude-sonnet-4-6")
	convID := "conv_subthread"

	// A SUB-thread session (non-empty threadID), as the conversation registry
	// creates one per thread.
	s := c.newThreadSession("thread-1")

	// Create the per-conversation folder so a sidecar WOULD resolve if written.
	convDir := filepath.Join(c.workingDir, ".juggler", "release--"+convID)
	if err := os.MkdirAll(convDir, 0o755); err != nil {
		t.Fatalf("mkdir conv folder: %v", err)
	}

	if _, err := s.streamMessage(context.Background(), provider.MessageRequest{
		ConversationID: convID, SystemPrompt: "sys", Messages: []provider.Message{userMsg("hello")},
	}, nopCallback()); err != nil {
		t.Fatalf("turn: %v", err)
	}

	// The sub-thread still has a warm in-memory session (own CLI/UUID)...
	if s.activeSession == nil || s.activeSession.sessionUUID == "" {
		t.Fatal("sub-thread turn must still capture an in-memory session (own warm CLI)")
	}
	// ...but NOTHING on disk.
	sidecar := filepath.Join(convDir, "claude_session.json")
	if _, err := os.Stat(sidecar); !os.IsNotExist(err) {
		t.Fatalf("sub-thread must not write a disk sidecar (stat err = %v)", err)
	}
	// And it must refuse to READ the conversation sidecar (would steal the root
	// thread's session).
	if got := s.loadSidecar(convID); got != nil {
		t.Fatal("sub-thread loadSidecar must return nil — in-memory only")
	}

	s.dropSession(convID)
}

// TestRootThread_PersistsSidecar is the paired control: the root thread
// (threadID == "") DOES persist, so warm-resume across restart still works.
func TestRootThread_PersistsSidecar(t *testing.T) {
	installFakeClaude(t, fakeModeUntilClose, "uuid-rootthread")
	c := mkClient(t, "claude-sonnet-4-6") // root-thread session (threadID == "")
	convID := "conv_rootthread"

	convDir := filepath.Join(c.workingDir, ".juggler", "release--"+convID)
	if err := os.MkdirAll(convDir, 0o755); err != nil {
		t.Fatalf("mkdir conv folder: %v", err)
	}

	if _, err := c.streamMessage(context.Background(), provider.MessageRequest{
		ConversationID: convID, SystemPrompt: "sys", Messages: []provider.Message{userMsg("hello")},
	}, nopCallback()); err != nil {
		t.Fatalf("turn: %v", err)
	}

	sidecar := filepath.Join(convDir, "claude_session.json")
	if _, err := os.Stat(sidecar); err != nil {
		t.Fatalf("root thread must persist its sidecar for warm resume: %v", err)
	}
}

// TestReapIdleCLI_FreesProcessKeepsSession pins the idle-reaper contract that
// makes per-thread CLIs safe: an idle handle's live subprocess is freed (so
// processes don't accumulate, one per thread), but the resumable session
// record (sessionUUID) survives so a re-opened thread --resumes warm. A fresh
// (non-idle) handle is never reaped.
func TestReapIdleCLI_FreesProcessKeepsSession(t *testing.T) {
	installFakeClaude(t, fakeModeUntilClose, "uuid-reap")
	c := mkClient(t, "claude-sonnet-4-6") // root-thread session
	convID := "conv_reap"

	if _, err := c.streamMessage(context.Background(), provider.MessageRequest{
		ConversationID: convID, SystemPrompt: "sys", Messages: []provider.Message{userMsg("hello")},
	}, nopCallback()); err != nil {
		t.Fatalf("turn: %v", err)
	}
	if c.activeSession == nil || !c.activeSession.hasLiveCLI() {
		t.Fatal("precondition: expected a live persistent CLI after the turn")
	}
	uuid := c.activeSession.sessionUUID
	if uuid == "" {
		t.Fatal("precondition: expected a captured sessionUUID")
	}

	// Fresh session (lastUsedAt just now) — must NOT be reaped.
	c.reapIdleCLI(time.Hour, time.Hour)
	if !c.activeSession.hasLiveCLI() {
		t.Fatal("a fresh (non-idle) session must not be reaped")
	}

	// Force idle, then reap: process freed, resumable record kept.
	c.activeSession.lastUsedAt = time.Now().Add(-time.Hour)
	c.reapIdleCLI(time.Minute, time.Hour)

	if c.activeSession == nil {
		t.Fatal("reap must KEEP the resumable session record (warm --resume)")
	}
	if c.activeSession.hasLiveCLI() {
		t.Fatal("reap must free the idle live CLI process")
	}
	if c.activeSession.sessionUUID != uuid {
		t.Fatalf("reap must preserve sessionUUID (got %q want %q)", c.activeSession.sessionUUID, uuid)
	}
}

// warmSessionForReap runs one turn against the fake CLI so the returned client
// holds a live persistent CLI with a captured sessionUUID — the state the
// idle reaper acts on.
func warmSessionForReap(t *testing.T, sessionID, convID string) *Client {
	t.Helper()
	installFakeClaude(t, fakeModeUntilClose, sessionID)
	c := mkClient(t, "claude-sonnet-4-6") // root-thread session
	if _, err := c.streamMessage(context.Background(), provider.MessageRequest{
		ConversationID: convID, SystemPrompt: "sys", Messages: []provider.Message{userMsg("hello")},
	}, nopCallback()); err != nil {
		t.Fatalf("turn: %v", err)
	}
	if c.activeSession == nil || !c.activeSession.hasLiveCLI() {
		t.Fatal("precondition: expected a live persistent CLI after the turn")
	}
	if c.activeSession.sessionUUID == "" {
		t.Fatal("precondition: expected a captured sessionUUID")
	}
	return c
}

// TestReapIdleCLI_ParkedSessionIsNotIdle pins the parked exemption: while the
// CLI is blocked on stdin awaiting tool results it is waiting on US, and
// lastUsedAt stands still for the whole park — so a tool that outruns the idle
// timeout (a sub-agent thread, a long build) must not have its CLI reaped out
// from under it. Clearing the pending tools puts the same session straight back
// under the plain idle rule.
func TestReapIdleCLI_ParkedSessionIsNotIdle(t *testing.T) {
	c := warmSessionForReap(t, "uuid-parked", "conv_parked")
	uuid := c.activeSession.sessionUUID

	// Parked on a tool call twenty minutes ago: idle by lastUsedAt, but well
	// inside the parked ceiling.
	c.activeSession.pendingTools = []pendingToolMeta{{ID: "toolu_1", Name: "Explore", Args: []byte("{}")}}
	c.activeSession.parkedAt = time.Now().Add(-20 * time.Minute)
	c.activeSession.lastUsedAt = time.Now().Add(-20 * time.Minute)

	c.reapIdleCLI(10*time.Minute, time.Hour)
	if !c.activeSession.hasLiveCLI() {
		t.Fatal("a session parked on pending tools must not be reaped as idle")
	}
	if c.activeSession.sessionUUID != uuid {
		t.Fatalf("exempt sweep must leave the session untouched (uuid %q want %q)", c.activeSession.sessionUUID, uuid)
	}

	// Same session, same timestamps, no pending tools: the plain idle rule
	// applies again and the process goes.
	c.activeSession.pendingTools = nil
	c.reapIdleCLI(10*time.Minute, time.Hour)
	if c.activeSession == nil {
		t.Fatal("reap must KEEP the resumable session record (warm --resume)")
	}
	if c.activeSession.hasLiveCLI() {
		t.Fatal("an idle session with no pending tools must still be reaped")
	}
	if c.activeSession.sessionUUID != uuid {
		t.Fatalf("reap must preserve sessionUUID (got %q want %q)", c.activeSession.sessionUUID, uuid)
	}
}

// TestReapIdleCLI_ParkedPastCeilingIsReaped pins the bound on that exemption: a
// park nobody ever answers (a wedged tool, an unanswered approval, an abandoned
// window) would otherwise hold its subprocess forever, so once the park outlives
// the parked ceiling the process is reclaimed — while the resumable session
// record survives, exactly as an idle reap.
func TestReapIdleCLI_ParkedPastCeilingIsReaped(t *testing.T) {
	c := warmSessionForReap(t, "uuid-parked-ceiling", "conv_parked_ceiling")
	uuid := c.activeSession.sessionUUID

	c.activeSession.pendingTools = []pendingToolMeta{{ID: "toolu_1", Name: "Bash", Args: []byte("{}")}}
	c.activeSession.parkedAt = time.Now().Add(-2 * defaultCLIReapParkedTimeout)
	c.activeSession.lastUsedAt = time.Now() // recent activity must not save it

	c.reapIdleCLI(10*time.Minute, defaultCLIReapParkedTimeout)

	if c.activeSession == nil {
		t.Fatal("reap must KEEP the resumable session record (warm --resume)")
	}
	if c.activeSession.hasLiveCLI() {
		t.Fatalf("a session parked past the %v ceiling must be reaped", defaultCLIReapParkedTimeout)
	}
	if c.activeSession.sessionUUID != uuid {
		t.Fatalf("reap must preserve sessionUUID (got %q want %q)", c.activeSession.sessionUUID, uuid)
	}
}
