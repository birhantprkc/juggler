//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !windows

package ops

import (
	"context"
	"os/exec"
	"syscall"
)

// newShellCmd builds the command that runs an approved shell string through a
// POSIX shell. On Unix that shell is the local `sh` — the same syntax the
// command-approval analyser tokenises.
func newShellCmd(ctx context.Context, command string) *exec.Cmd {
	return exec.CommandContext(ctx, "sh", "-c", command)
}

// newPythonCmd builds the command that runs Python with the program supplied
// on stdin (caller sets cmd.Stdin).
func newPythonCmd(ctx context.Context) *exec.Cmd {
	return exec.CommandContext(ctx, "python3", "-")
}

// setProcGroup sets up process group for the command so we can kill all children
func setProcGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// killProcessGroup kills the process and all its children
func killProcessGroup(cmd *exec.Cmd) {
	_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
}
