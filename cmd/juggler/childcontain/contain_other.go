//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !linux && !windows

package childcontain

import (
	"os"
	"os/exec"
	"runtime"
	"syscall"
)

// prepare creates a process group on Unix-like platforms so explicit
// termination can kill the whole child subtree. macOS has no parent-death
// primitive, but process-group termination still prevents clean-shutdown leaks.
func prepare(cmd *exec.Cmd) {
	if runtime.GOOS != "darwin" {
		return
	}
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true
}

// adopt is a no-op on platforms without a post-start containment primitive.
func adopt(_ *exec.Cmd) (func(), error) {
	return func() {}, nil
}

func terminate(cmd *exec.Cmd, _ *Child) error {
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	if runtime.GOOS == "darwin" {
		if err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); err != nil && err != syscall.ESRCH {
			if killErr := cmd.Process.Kill(); killErr != nil && !isProcessDone(killErr) {
				return err
			}
		}
		return nil
	}
	if err := cmd.Process.Kill(); err != nil && !isProcessDone(err) {
		return err
	}
	return nil
}

func isProcessDone(err error) bool {
	return err == os.ErrProcessDone
}
