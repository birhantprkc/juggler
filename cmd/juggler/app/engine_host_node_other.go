//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !linux

package app

import "os/exec"

// setChildDeathSignal is a no-op off Linux: only Linux exposes Pdeathsig. On
// macOS/Windows the node engine host is a dev/debug path, and node death is
// still handled by the cmd.Wait watcher in Start (which quits the server).
func setChildDeathSignal(*exec.Cmd) {}
