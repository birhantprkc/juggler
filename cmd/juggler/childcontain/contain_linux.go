//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build linux

package childcontain

import (
	"os"
	"os/exec"
	"syscall"
)

// prepare sets PR_SET_PDEATHSIG on the child via SysProcAttr. The kernel
// delivers SIGTERM to the child process when this process (the parent) exits,
// including exits caused by SIGKILL. It also starts the child in its own
// process group so explicit termination can signal the whole subtree.
func prepare(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Pdeathsig = syscall.SIGTERM
	cmd.SysProcAttr.Setpgid = true
}

// adopt is a no-op on Linux; Pdeathsig/Setpgid set by prepare() are sufficient.
func adopt(_ *exec.Cmd) (func(), error) {
	return func() {}, nil
}

func terminate(cmd *exec.Cmd, _ *Child) error {
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	// Negative PID means "process group whose ID is pid". Prepare set Setpgid,
	// so the child's process group ID is its PID.
	if err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); err != nil && err != syscall.ESRCH {
		// Fall back to direct-child kill in case the process group was not created
		// (for example because a caller bypassed Prepare).
		if killErr := cmd.Process.Kill(); killErr != nil && !isProcessDone(killErr) {
			return err
		}
	}
	return nil
}

func isProcessDone(err error) bool {
	return err == os.ErrProcessDone
}
