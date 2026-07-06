//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package userpaths is the single source of truth for Juggler's per-user home
// directory and the regenerable cache beneath it.
//
//	~/.juggler/            ConfigDir — durable, worth copying (credentials,
//	                       default-model, extensions, sessions live here)
//	~/.juggler/cache/      CacheDir — regenerable, safe to delete (recents,
//	                       learned model specs, and similar ephemera)
//
// Logs deliberately do NOT live here — see internal/logpaths, which resolves
// them to the platform-conventional log directory so ~/.juggler stays copyable.
package userpaths

import (
	"os"
	"path/filepath"
)

// ConfigDir returns Juggler's per-user config directory.
//
// JUGGLER_CONFIG_DIR overrides it outright when set, relocating every piece of
// per-user state (credentials, default model, recents, extensions, sessions) to
// that directory. CI and tests use this to isolate state per run, so concurrent
// or back-to-back runs on a shared/persistent machine never bleed into each
// other; it also lets a user keep a portable config location.
//
// Otherwise it is ~/.juggler, falling back to the OS temp dir when the home
// directory can't be resolved, so a path is always produced.
func ConfigDir() string {
	if dir := os.Getenv("JUGGLER_CONFIG_DIR"); dir != "" {
		return dir
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		return filepath.Join(home, ".juggler")
	}
	return filepath.Join(os.TempDir(), "juggler")
}

// CacheDir returns the regenerable cache directory: ~/.juggler/cache. Files here
// are safe to delete — Juggler rebuilds them on demand. Callers MkdirAll it
// before writing.
func CacheDir() string {
	return filepath.Join(ConfigDir(), "cache")
}
