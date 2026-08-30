//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package jlog

import (
	"path/filepath"
	"testing"
)

// TestFilePathTracksTheFileSink covers the contract callers place diagnostic
// artifacts by: FilePath names the open log file and goes empty the moment there
// isn't one. A stale path would put a wedge sample (or a crash dump) next to a
// log nobody is writing, in a folder no bug report collects.
func TestFilePathTracksTheFileSink(t *testing.T) {
	// Init is a "once at startup" call, so the package globals it sets outlive
	// any single test. Start from no sink whatever ran before.
	Close()
	t.Cleanup(Close)

	if got := FilePath(); got != "" {
		t.Fatalf("FilePath with no sink = %q; want \"\"", got)
	}

	path := filepath.Join(t.TempDir(), "server.log")
	Init(Options{LogFilePath: path, DiscardConsole: true, MaxSizeMB: 1, MaxBackups: 1})
	if got := FilePath(); got != path {
		t.Fatalf("FilePath after Init = %q; want %q", got, path)
	}

	Close()
	if got := FilePath(); got != "" {
		t.Fatalf("FilePath after Close = %q; want \"\" — the sink is gone", got)
	}
}

// TestFilePathIsEmptyWhenLoggingIsOff pins the other half: a run with on-disk
// logging disabled must not name a file, so features that hang artifacts off the
// log directory stay off too rather than creating the files the user turned off.
func TestFilePathIsEmptyWhenLoggingIsOff(t *testing.T) {
	Close()
	t.Cleanup(Close)
	Init(Options{DiscardConsole: true})

	if got := FilePath(); got != "" {
		t.Fatalf("FilePath with no LogFilePath = %q; want \"\"", got)
	}
	if FileLoggingEnabled() {
		t.Fatal("FileLoggingEnabled with no LogFilePath")
	}
}
