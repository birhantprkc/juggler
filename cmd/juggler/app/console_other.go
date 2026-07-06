//go:build !windows

//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package app

import (
	"os"

	"golang.org/x/term"
)

// launchedFromTerminal reports whether juggler has a controlling terminal. On
// macOS/Linux stdin is a TTY exactly when launched from a shell, so the std
// check is sufficient — the Windows console-subsystem dance (detaching the
// console an icon launch allocates) has no equivalent here.
func launchedFromTerminal() bool {
	return term.IsTerminal(int(os.Stdin.Fd()))
}
