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
	c.reapIdleCLI(time.Hour)
	if !c.activeSession.hasLiveCLI() {
		t.Fatal("a fresh (non-idle) session must not be reaped")
	}

	// Force idle, then reap: process freed, resumable record kept.
	c.activeSession.lastUsedAt = time.Now().Add(-time.Hour)
	c.reapIdleCLI(time.Minute)

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
