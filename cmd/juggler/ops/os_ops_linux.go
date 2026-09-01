//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !darwin && !windows

package ops

import (
	"net/url"
	"os/exec"
	"path/filepath"
)

// newOpenCmds opens a path with the user's default handler via xdg-open.
func newOpenCmds(path string) []*exec.Cmd {
	return []*exec.Cmd{exec.Command("xdg-open", path)}
}

// newRevealCmds reveals a path in the file manager, best way first.
//
// The freedesktop way is org.freedesktop.FileManager1.ShowItems, which every
// major file manager implements (Nautilus, Dolphin, Nemo, Thunar) and which
// actually selects the file — the thing the button says it does.
// `--print-reply` is what makes it a question: without it dbus-send returns
// success whether or not anyone was listening, and there would be nothing to
// fall back from.
//
// Where no file manager answers that call, opening the containing directory is
// the universal equivalent: not a selection, but the folder the file is in.
func newRevealCmds(path string) []*exec.Cmd {
	item := (&url.URL{Scheme: "file", Path: path}).String()
	return []*exec.Cmd{
		exec.Command(
			"dbus-send", "--session", "--print-reply",
			"--dest=org.freedesktop.FileManager1",
			"/org/freedesktop/FileManager1",
			"org.freedesktop.FileManager1.ShowItems",
			"array:string:"+item, "string:",
		),
		exec.Command("xdg-open", filepath.Dir(path)),
	}
}

// exitStatusMeansFailure reports whether the launcher's exit status is worth
// believing. `xdg-open` documents its failures as exit codes — no handler for
// the type, or a path it could not act on — so it always is.
func exitStatusMeansFailure(_ bool) bool {
	return true
}
