//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package logpaths

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// writeAged creates a file in dir with the given age (mtime = now-age).
func writeAged(t *testing.T, dir, name string, age time.Duration, now time.Time) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
	mt := now.Add(-age)
	if err := os.Chtimes(p, mt, mt); err != nil {
		t.Fatalf("chtimes %s: %v", name, err)
	}
	return p
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// SweepOldLogs removes only stale Juggler log files: fresh logs, non-log files,
// and sub-directories must all survive, and the returned count must match.
func TestSweepOldLogsRemovesOnlyStaleLogs(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	const maxAge = 7 * 24 * time.Hour

	// A dead project's whole folder: all logs stale, nested in <slug>/ and
	// <slug>/conversations/ — every file should be removed and the now-empty
	// folders pruned.
	deadDir := filepath.Join(dir, "deadproj-a1b2c3d4")
	deadConvDir := filepath.Join(deadDir, "conversations")
	if err := os.MkdirAll(deadConvDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	staleMain := writeAged(t, deadDir, "server.log", 30*24*time.Hour, now)
	staleErr := writeAged(t, deadDir, "server.stderr.log", 30*24*time.Hour, now)
	staleBackup := writeAged(t, deadDir, "server.log.3", 30*24*time.Hour, now)
	staleConv := writeAged(t, deadConvDir, "conv_abc123xyz.log", 30*24*time.Hour, now)

	// Survivors: a fresh log in a live project's folder, a non-log file (even if
	// old) at the top level, and the app log.
	liveDir := filepath.Join(dir, "liveproj-99887766")
	if err := os.MkdirAll(liveDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	freshLog := writeAged(t, liveDir, "server.log", time.Hour, now)
	oldNotes := writeAged(t, dir, "notes.txt", 30*24*time.Hour, now)
	appLog := writeAged(t, dir, "app.log", time.Hour, now)

	removed := SweepOldLogs(dir, maxAge, now)
	if removed != 4 {
		t.Errorf("SweepOldLogs removed %d, want 4", removed)
	}
	for _, p := range []string{staleMain, staleErr, staleBackup, staleConv} {
		if exists(p) {
			t.Errorf("stale log %q should have been removed", p)
		}
	}
	// The emptied dead-project folder (and its conversations/ sub-folder) pruned.
	if exists(deadDir) {
		t.Errorf("emptied dead-project folder %q should have been pruned", deadDir)
	}
	for _, p := range []string{freshLog, oldNotes, appLog, liveDir} {
		if !exists(p) {
			t.Errorf("%q should have survived the sweep", p)
		}
	}
}

// A non-positive maxAge disables the sweep entirely — nothing is removed.
func TestSweepOldLogsDisabledByNonPositiveAge(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	ancient := writeAged(t, dir, "ancient.log", 365*24*time.Hour, now)

	for _, maxAge := range []time.Duration{0, -time.Hour} {
		if n := SweepOldLogs(dir, maxAge, now); n != 0 {
			t.Errorf("SweepOldLogs(maxAge=%v) removed %d, want 0 (disabled)", maxAge, n)
		}
		if !exists(ancient) {
			t.Fatalf("file removed despite disabled sweep (maxAge=%v)", maxAge)
		}
	}
}

// A missing directory is not an error — the sweep just reports zero removals.
func TestSweepOldLogsMissingDir(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "does-not-exist")
	if n := SweepOldLogs(missing, DefaultLogRetention, time.Now()); n != 0 {
		t.Errorf("SweepOldLogs(missing dir) = %d, want 0", n)
	}
}

// RemoveConversationLogs deletes exactly one conversation's log files — the
// bare-id and name-prefixed forms plus rotation backups — and leaves other
// conversations' logs untouched, matching on the authoritative conv-id suffix.
func TestRemoveConversationLogs(t *testing.T) {
	t.Setenv("JUGGLER_LOG_DIR", t.TempDir())
	const proj = "/Users/jules/code/myproj"
	const target, other = "conv_target01", "conv_other99"

	convDir := filepath.Join(ProjectLogDir(proj), "conversations")
	if err := os.MkdirAll(convDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	now := time.Now()
	// Target conversation: prefixed file + a rotation backup.
	mine := writeAged(t, convDir, "My Tab--"+target+".log", time.Hour, now)
	mineBackup := writeAged(t, convDir, "My Tab--"+target+".log.1", time.Hour, now)
	// A different conversation that must survive, and an unrelated file.
	theirs := writeAged(t, convDir, other+".log", time.Hour, now)
	stray := writeAged(t, convDir, "notes.txt", time.Hour, now)

	if n := RemoveConversationLogs(proj, target); n != 2 {
		t.Errorf("RemoveConversationLogs removed %d, want 2", n)
	}
	for _, p := range []string{mine, mineBackup} {
		if exists(p) {
			t.Errorf("target log %q should have been removed", filepath.Base(p))
		}
	}
	for _, p := range []string{theirs, stray} {
		if !exists(p) {
			t.Errorf("%q should have survived", filepath.Base(p))
		}
	}
}
