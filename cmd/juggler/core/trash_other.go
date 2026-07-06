//go:build !windows

//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"os"

	gotrash "github.com/laurent22/go-trash"
)

// trashOrRemove moves path to the OS trash if available, falling back to
// permanent removal. On macOS/Linux this uses go-trash (Finder trash on
// darwin, gio/gvfs on Linux).
func trashOrRemove(path string) error {
	if gotrash.IsAvailable() {
		if _, err := gotrash.MoveToTrash(path); err == nil {
			return nil
		}
		// Trash failed (e.g. network volume) — fall through to permanent delete.
	}
	return os.RemoveAll(path)
}
