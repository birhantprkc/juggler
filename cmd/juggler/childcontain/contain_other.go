//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !linux && !windows

package childcontain

import (
	"fmt"
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

// adopt registers the started child with the parent-death reaper on macOS,
// which kills it if this process dies without running any cleanup. Elsewhere
// there is no post-start containment primitive and adopt is a no-op.
//
// The returned cleanup func releases the child from the reaper, so a pid we no
// longer own is never a kill candidate.
func adopt(cmd *exec.Cmd) (func(), error) {
	if runtime.GOOS != "darwin" {
		return func() {}, nil
	}
	if cmd.Process == nil {
		return func() {}, fmt.Errorf("childcontain: Adopt called before cmd.Start()")
	}
	pid := cmd.Process.Pid
	if err := registerWithReaper(pid); err != nil {
		return func() {}, err
	}
	return func() { releaseFromReaper(pid) }, nil
}

func terminate(cmd *exec.Cmd, child *Child) error {
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	if runtime.GOOS == "darwin" {
		// Kill first, release second: between the two the child is dead but
		// still contained, so a parent that dies mid-Terminate leaves nothing
		// behind. Cleanup is idempotent, so callers that also call it after
		// Wait are unaffected.
		defer child.Cleanup()
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
