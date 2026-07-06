//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package logpaths

import (
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"time"
)

// DefaultLogRetention is how long an untouched log file is kept before the
// startup sweep removes it. Active logs are written continuously so their
// modification time stays current; only logs for a project (or a test run)
// that hasn't been touched in this long age out. Per-file size rotation
// (internal/jlog) bounds a single live log; this bounds the *count* of dead
// ones, which rotation never does.
const DefaultLogRetention = 14 * 24 * time.Hour

// logFileRe matches Juggler's own log files: a structured or stderr log and any
// rotation backup — "host.log", "myproj-a1b2.log", "app.stderr.log",
// "myproj-a1b2.log.3", etc. The sweep only ever removes files matching this, so
// an unrelated file a user dropped into the log directory is never touched.
var logFileRe = regexp.MustCompile(`\.log(\.\d+)?$`)

// SweepOldLogs removes log files anywhere under dir (recursively — including the
// per-project folders and their conversations/ sub-folders) whose most recent
// modification is older than maxAge, relative to now, and returns how many it
// removed. After removing stale files it prunes any sub-directory left empty, so
// a dead project's whole folder disappears once its last log ages out.
//
// It is best-effort startup housekeeping: it only ever touches files that match
// one of Juggler's own log names (logFileRe), and it ignores individual remove
// errors — a second juggler process may have removed the same stale file a
// moment earlier, which is success, not failure. A non-positive maxAge disables
// the sweep entirely (returns 0).
func SweepOldLogs(dir string, maxAge time.Duration, now time.Time) int {
	if maxAge <= 0 {
		return 0
	}
	cutoff := now.Add(-maxAge)
	removed := 0
	_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !logFileRe.MatchString(d.Name()) {
			return nil
		}
		info, err := d.Info()
		if err != nil || !info.ModTime().Before(cutoff) {
			return nil
		}
		if os.Remove(p) == nil {
			removed++
		}
		return nil
	})
	pruneEmptyDirs(dir)
	return removed
}

// convLogRe builds a matcher for one conversation's log files: the structured
// log and any rotation backup, with or without a human-name prefix —
// "conv_x.log", "My Tab--conv_x.log", "conv_x.log.2", etc. The conv id is the
// authoritative trailing stem (preceded by start-of-name or the "--" prefix
// separator), so a tab-name prefix never defeats the match.
func convLogRe(convID string) *regexp.Regexp {
	return regexp.MustCompile(`(^|--)` + regexp.QuoteMeta(convID) + `\.log(\.\d+)?$`)
}

// RemoveConversationLogs deletes one conversation's log files (and rotation
// backups) from its project's conversations/ folder, returning how many it
// removed. Best-effort: a missing folder or remove error is ignored. The caller
// must ensure the conversation's own log sink is closed first (an open file
// can't be removed on Windows) — the worker does this in onShutdown.
func RemoveConversationLogs(project, convID string) int {
	dir := filepath.Join(ProjectLogDir(project), "conversations")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	re := convLogRe(convID)
	removed := 0
	for _, e := range entries {
		if e.IsDir() || !re.MatchString(e.Name()) {
			continue
		}
		if os.Remove(filepath.Join(dir, e.Name())) == nil {
			removed++
		}
	}
	return removed
}

// pruneEmptyDirs removes empty sub-directories beneath root (deepest first),
// leaving root itself in place. Best-effort: a non-empty dir's Remove simply
// fails and is ignored.
func pruneEmptyDirs(root string) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		sub := filepath.Join(root, e.Name())
		pruneEmptyDirs(sub)
		_ = os.Remove(sub) // succeeds only if now empty
	}
}
