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
	"sync"
	"syscall"
)

// The reaper supplies the parent-death containment macOS has no kernel
// primitive for. Linux gets Pdeathsig and Windows gets a kill-on-job-close job
// object, both of which the kernel honours however the parent dies; on macOS
// nothing does, so a SIGKILL, a crash, a force-quit, or a same-PID
// syscall.Exec leaves contained children with no one to shut them down.
//
// The stand-in is one small `sh` process per parent, holding the read end of a
// pipe nobody else inherits (Go opens its fds O_CLOEXEC). It reads the set of
// contained pids as they come and go, and the moment the pipe reaches EOF —
// which every form of parent death produces, since the kernel closes the write
// end — it kills whatever is still in the set. A parent that shuts down
// properly has released every child first, so the reaper wakes to an empty set
// and exits having done nothing.
//
// Pids are only ever killed while the parent believes it owns them, which is
// what makes this safe: a released pid is forgotten immediately, so a recycled
// pid can never be mistaken for a child of ours.
const reaperScript = `
pids=""
while IFS= read -r line; do
	case "$line" in
	"+"*) pids="$pids ${line#+}" ;;
	"-"*)
		kept=""
		for p in $pids; do
			[ "$p" = "${line#-}" ] || kept="$kept $p"
		done
		pids="$kept"
		;;
	esac
done
for p in $pids; do
	kill -9 "-$p" 2>/dev/null || kill -9 "$p" 2>/dev/null
done
exit 0
`

var (
	// reaperOnce guards the one-time reaper launch. It also publishes
	// reaperPipe and reaperStartErr to every later caller: sync.Once
	// establishes the happens-before edge, so neither needs a lock.
	reaperOnce sync.Once
	// reaperPipe is the write end of the reaper's stdin. It is deliberately
	// never closed — the kernel closing it on process death is the signal.
	reaperPipe     *os.File
	reaperStartErr error
)

// startReaper launches the parent-death reaper. Called once, via reaperOnce.
func startReaper() {
	r, w, err := os.Pipe()
	if err != nil {
		reaperStartErr = fmt.Errorf("childcontain: reaper pipe: %w", err)
		return
	}

	cmd := exec.Command("/bin/sh", "-c", reaperScript)
	cmd.Stdin = r
	// Its own process group, so a Ctrl-C aimed at the parent's foreground
	// group never reaches the one process whose job is to outlive the parent.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		_ = r.Close()
		_ = w.Close()
		reaperStartErr = fmt.Errorf("childcontain: start reaper: %w", err)
		return
	}
	// The child holds the read end now; keeping our copy open would mean the
	// reaper never sees EOF.
	_ = r.Close()
	// Reap the reaper itself if it ever exits early, so it can't linger as a
	// zombie for the rest of this process's life.
	go func() { _ = cmd.Wait() }()

	reaperPipe = w
}

// noteToReaper sends one pid record to the reaper. Writes this short are
// atomic on a pipe (well under PIPE_BUF) and os.File serialises its own fd, so
// concurrent callers cannot interleave and no lock is needed.
func noteToReaper(op string, pid int) error {
	reaperOnce.Do(startReaper)
	if reaperStartErr != nil {
		return reaperStartErr
	}
	if _, err := fmt.Fprintf(reaperPipe, "%s%d\n", op, pid); err != nil {
		return fmt.Errorf("childcontain: notify reaper: %w", err)
	}
	return nil
}

// registerWithReaper puts pid under parent-death containment. It returns only
// once the reaper has the record, so a parent that dies the instant after
// Adopt returns is still covered.
func registerWithReaper(pid int) error {
	if runtime.GOOS != "darwin" {
		return nil
	}
	return noteToReaper("+", pid)
}

// releaseFromReaper drops pid from parent-death containment. Safe to call more
// than once, and safe to call for a pid that was never registered.
func releaseFromReaper(pid int) {
	if runtime.GOOS != "darwin" {
		return
	}
	_ = noteToReaper("-", pid)
}
