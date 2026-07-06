//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build windows

package ops

import "os/exec"

// newOpenCmd opens a path with its default Windows handler. `cmd /c start`
// resolves the association; the empty "" is start's mandatory window-title arg.
func newOpenCmd(path string) *exec.Cmd {
	return exec.Command("cmd", "/c", "start", "", path)
}

// newRevealCmd selects a path in Explorer.
func newRevealCmd(path string) *exec.Cmd {
	return exec.Command("explorer", "/select,"+path)
}
