//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !darwin && !windows

package ops

import (
	"os/exec"
	"path/filepath"
)

// newOpenCmd opens a path with the user's default handler via xdg-open.
func newOpenCmd(path string) *exec.Cmd {
	return exec.Command("xdg-open", path)
}

// newRevealCmd reveals a path in the file manager. There is no portable
// "select this file" verb across Linux desktops, so we open the containing
// directory — the closest universal equivalent.
func newRevealCmd(path string) *exec.Cmd {
	return exec.Command("xdg-open", filepath.Dir(path))
}
