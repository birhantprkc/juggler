//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build windows

package ops

import "os/exec"

// newOpenCmds opens a path with its default Windows handler. `cmd /c start`
// resolves the association; the empty "" is start's mandatory window-title arg.
func newOpenCmds(path string) []*exec.Cmd {
	return []*exec.Cmd{exec.Command("cmd", "/c", "start", "", path)}
}

// newRevealCmds selects a path in Explorer. One way to ask, because Windows has
// one file manager.
func newRevealCmds(path string) []*exec.Cmd {
	return []*exec.Cmd{exec.Command("explorer", "/select,"+path)}
}

// exitStatusMeansFailure reports whether the launcher's exit status is worth
// believing.
//
// Not for a reveal: `explorer` returns a non-zero status as a matter of course,
// having done exactly what was asked, so reading it would report every
// successful reveal as a failure. `cmd /c start` is honest, and its status is
// the only report of an association that could not be resolved.
func exitStatusMeansFailure(reveal bool) bool {
	return !reveal
}
