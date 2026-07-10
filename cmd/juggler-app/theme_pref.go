//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"os"
	"path/filepath"
	"strings"

	"juggler/internal/userpaths"
)

// A new window's bare native frame is painted in the theme colour before the
// page's first paint (see buildWindow), so it doesn't flash the default colour
// on Windows, where the window is created visible. But the page's theme lives in
// per-origin localStorage owned by the webview — the Go side can't read it at
// window-build time. So at launch, before any page has reported its theme, we
// would otherwise have nothing to go on and fall back to dark, flashing a
// near-black frame at a light-theme user.
//
// To avoid that, we persist the last theme any page reported to a small file and
// read it back at startup. It's a global "last theme used" hint (not per-project
// — the per-project value only exists in the page's localStorage), which matches
// the common case of one consistent theme and, crucially, survives a relaunch.

func lastThemeFilePath() string {
	return filepath.Join(userpaths.ConfigDir(), "last-theme")
}

// loadLastTheme reads the persisted last-used theme, or "" if none is stored or
// the stored value isn't a theme we know.
func loadLastTheme() string {
	data, err := os.ReadFile(lastThemeFilePath())
	if err != nil {
		return ""
	}
	return normaliseTheme(strings.TrimSpace(string(data)))
}

// saveLastTheme records the last-used theme (best-effort; a failure just means
// the next launch falls back to its default).
func saveLastTheme(theme string) {
	if normaliseTheme(theme) == "" {
		return
	}
	path := lastThemeFilePath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		logf("last-theme: mkdir failed: %v", err)
		return
	}
	if err := os.WriteFile(path, []byte(theme), 0o644); err != nil {
		logf("last-theme: write failed: %v", err)
	}
}
