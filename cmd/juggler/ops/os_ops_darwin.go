//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build darwin

package ops

import "os/exec"

// newOpenCmd opens a path with its default macOS handler.
func newOpenCmd(path string) *exec.Cmd {
	return exec.Command("open", path)
}

// newRevealCmd selects a path in Finder (-R reveals the item in its container).
func newRevealCmd(path string) *exec.Cmd {
	return exec.Command("open", "-R", path)
}
