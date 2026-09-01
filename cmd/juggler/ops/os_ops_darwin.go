//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build darwin

package ops

import "os/exec"

// newOpenCmds opens a path with its default macOS handler.
func newOpenCmds(path string) []*exec.Cmd {
	return []*exec.Cmd{exec.Command("open", path)}
}

// newRevealCmds selects a path in Finder (-R reveals the item in its container).
// One way to ask, because macOS has one file manager.
func newRevealCmds(path string) []*exec.Cmd {
	return []*exec.Cmd{exec.Command("open", "-R", path)}
}

// exitStatusMeansFailure reports whether the launcher's exit status is worth
// believing. `open` exits non-zero only when it has refused the path — no
// application for the type, or nothing there to reveal — so it always is.
func exitStatusMeansFailure(_ bool) bool {
	return true
}
