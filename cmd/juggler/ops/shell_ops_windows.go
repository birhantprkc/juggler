//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build windows

package ops

import (
	"context"
	"fmt"
	"os/exec"
	"syscall"
)

// newShellCmd builds the command that runs an approved shell string through a
// POSIX shell. On Windows we route through WSL (`wsl.exe -e sh -c ...`) so the
// shell that executes is exactly the sh/bash-shaped syntax the command-approval
// analyser tokenises — running the same string through cmd.exe would mean the
// static safety proof was computed against a language other than the one that
// runs. cmd.Dir (a Windows path) is translated by the WSL interop layer to
// /mnt/<drive>/..., so relative paths in approved commands resolve unchanged.
//
// Requires WSL to be installed and provisioned; this is a developer tool, so we
// assume it is. A missing wsl.exe surfaces as a normal command-start error.
func newShellCmd(ctx context.Context, command string) *exec.Cmd {
	return exec.CommandContext(ctx, "wsl.exe", "-e", "sh", "-c", command)
}

// newPythonCmd builds the command that runs Python with the program supplied
// on stdin (caller sets cmd.Stdin), routed through WSL for the same reason as
// newShellCmd — one coherent POSIX environment, not native Windows Python.
func newPythonCmd(ctx context.Context) *exec.Cmd {
	return exec.CommandContext(ctx, "wsl.exe", "-e", "python3", "-")
}

// setProcGroup assigns a new process group so that taskkill /T can reliably
// target the entire process tree.
func setProcGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP,
	}
}

// killProcessGroup kills the process tree on Windows using taskkill
func killProcessGroup(cmd *exec.Cmd) {
	// /F = force, /T = tree (kill child processes), /PID = process ID
	kill := exec.Command("taskkill", "/F", "/T", "/PID", fmt.Sprintf("%d", cmd.Process.Pid))
	_ = kill.Run()
}
