//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !windows

package app

import (
	"os/exec"
	"syscall"
	"testing"
	"time"

	"juggler/cmd/juggler/childcontain"
)

// The engine process must not outlive the server that spawned it: it dials that
// address forever, and the next server to bind it adopts whatever engine turns
// up — so one left behind takes the new server's engine slot and silently eats
// the work meant for the real one. Stop is the ordinary-exit half of preventing
// that (containment covers the deaths no cleanup runs for).
//
// A stand-in child stands in for node: what is under test is the wiring, not the
// engine.
func TestNodeHostStopKillsTheEngineProcess(t *testing.T) {
	h := &nodeHost{}
	cmd := exec.Command("sleep", "30")
	childcontain.Prepare(cmd)
	if err := cmd.Start(); err != nil {
		t.Fatalf("start stand-in engine: %v", err)
	}
	child, err := childcontain.Adopt(cmd)
	if err != nil {
		t.Fatalf("contain stand-in engine: %v", err)
	}
	h.child.Store(child)
	pid := cmd.Process.Pid
	// Reap it, as Start's watcher goroutine does, so the pid is released rather
	// than left a zombie that still answers signal 0.
	reaped := make(chan struct{})
	go func() { _ = cmd.Wait(); close(reaped) }()

	h.Stop()

	select {
	case <-reaped:
	case <-time.After(5 * time.Second):
		t.Fatal("Stop left the engine process running")
	}
	if err := syscall.Kill(pid, 0); err != syscall.ESRCH {
		t.Errorf("the engine process is still there after Stop (kill 0 = %v)", err)
	}
	if !h.stopping.Load() {
		t.Error("a death we asked for must be recorded, or the watcher reports the exit as a failure and asks for a shutdown already under way")
	}
}
