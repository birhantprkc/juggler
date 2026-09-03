//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"context"
	"os/exec"
	"runtime"
	"sync/atomic"
	"testing"
	"time"
)

// A force-kill names a whole process TREE by one pid, and that pid means what
// the killer thinks only until the process is reaped: cmd.Wait releases the
// handle reserving the number, and the OS is then free to hand the same number
// to something else — Windows recycles pids within seconds. Each of the three
// escalations here runs on a timer, seconds after the polite stop, so each must
// establish that its target is still un-reaped before taking its group.
//
// These tests count escalations rather than their effect: an escalation aimed at
// a reaped pid is indistinguishable from a correct one once it has landed, and
// its victim is whatever inherited the number.

// countEscalations installs a hook that counts force-kill escalations and
// deliberately does not perform them — provoking the defect for real would kill
// whatever process on this machine now holds the recycled pid. Returns the count
// so far.
func countEscalations(t *testing.T) func() int {
	t.Helper()
	var count atomic.Int64
	killGroupHook.Store(func(*exec.Cmd) { count.Add(1) })
	t.Cleanup(func() { killGroupHook.Store((func(*exec.Cmd))(nil)) })
	return func() int { return int(count.Load()) }
}

// TestStreamingCancelDoesNotForceKillAReapedPid covers ExecuteStreaming's
// cancel path. The command's only process dies with the context and is reaped
// long before the kill grace elapses, so by the time the escalation is due there
// is nothing of ours left to take.
func TestStreamingCancelDoesNotForceKillAReapedPid(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX-only shell command")
	}

	shellOps := NewShellOperations(NewPathScope(t.TempDir(), nil))
	shellOps.killGrace = 100 * time.Millisecond
	shellOps.reapGrace = 300 * time.Millisecond
	escalations := countEscalations(t)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	out := make(chan ShellStreamChunk, 64)
	drained := make(chan struct{})
	go func() {
		defer close(drained)
		for range out { //nolint:revive // draining is the point
		}
	}()

	go func() {
		time.Sleep(100 * time.Millisecond)
		cancel()
	}()
	shellOps.ExecuteStreaming(ctx, "shell-cancel", "", "sleep 5", "", 10000, out)
	<-drained

	// Well past the kill grace the escalation was armed for.
	time.Sleep(shellOps.killGrace + 400*time.Millisecond)
	if n := escalations(); n != 0 {
		t.Fatalf("cancelled command was force-killed %d time(s) after its process had been reaped; that pid can name something else by then", n)
	}
}

// TestStreamingCancelStillForceKillsWhatOutlivesTheGrace is the other half: a
// child that stays in the leader's group holds the output pipe open, so cmd.Wait
// has not returned when the grace expires and the group still has to be taken.
// Without this, "never escalate" would pass the test above by doing nothing.
func TestStreamingCancelStillForceKillsWhatOutlivesTheGrace(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX process-group semantics only")
	}

	shellOps := NewShellOperations(NewPathScope(t.TempDir(), nil))
	shellOps.killGrace = 100 * time.Millisecond
	shellOps.reapGrace = 300 * time.Millisecond
	escalations := countEscalations(t)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	out := make(chan ShellStreamChunk, 64)
	drained := make(chan struct{})
	go func() {
		defer close(drained)
		for range out { //nolint:revive // draining is the point
		}
	}()

	go func() {
		time.Sleep(100 * time.Millisecond)
		cancel()
	}()
	// The backgrounded child inherits the leader's process group and the pipe's
	// write end, so killing the leader alone leaves cmd.Wait blocked.
	shellOps.ExecuteStreaming(ctx, "shell-cancel-child", "", "sleep 5 & sleep 5", "", 10000, out)
	<-drained

	if n := escalations(); n < 1 {
		t.Fatalf("a process group still holding the pipe past the kill grace was never force-killed (%d escalations)", n)
	}
}

// startLoneProcessTask spawns a background task whose whole tree is a single
// process: `exec` replaces the shell, so cancelling the context leaves nothing
// behind to hold the output pipe and the spawner reaps the task at once. That is
// the ordinary shape of a monitored command — one process that has already
// finished by the time any escalation is due.
func startLoneProcessTask(t *testing.T, root, convID string) string {
	t.Helper()
	shellOps := NewShellOperations(NewPathScope(root, nil))
	res, err := shellOps.startBackground(map[string]any{
		"command": "echo ready; exec sleep 30",
		"conv_id": convID,
	})
	if err != nil {
		t.Fatalf("startBackground failed: %v", err)
	}
	id, _ := res.(map[string]any)["task_id"].(string)
	if id == "" {
		t.Fatalf("startBackground returned no task_id: %+v", res)
	}
	t.Cleanup(func() { KillTask(id) })
	waitForOutput(t, id, "ready", 5*time.Second)
	return id
}

// TestKilledBackgroundTaskIsNotForceKilledAfterItIsReaped covers the registry's
// delayed escalation behind a user's Stop. The task's process dies with its
// cancelled context immediately and its spawner reaps it, so the escalation
// scheduled for two seconds later has no target of ours.
func TestKilledBackgroundTaskIsNotForceKilledAfterItIsReaped(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX-only shell command")
	}

	id := startLoneProcessTask(t, t.TempDir(), "conv-kill")
	escalations := countEscalations(t)

	if !KillTask(id) {
		t.Fatalf("KillTask did not stop a running task")
	}
	time.Sleep(2500 * time.Millisecond) // past the registry's two-second escalation

	if n := escalations(); n != 0 {
		t.Fatalf("killed task was force-killed %d time(s) after its process had been reaped; that pid can name something else by then", n)
	}
}

// TestKilledBackgroundTaskStillForceKillsSurvivors is the other half: a child
// left in the task's process group outlives the leader and holds the output pipe
// open, so the task is not reaped and its group still has to be taken.
func TestKilledBackgroundTaskStillForceKillsSurvivors(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX process-group semantics only")
	}

	// startTestTask's command leaves `sleep 30` running as a child of the shell.
	id := startTestTask(t, t.TempDir(), "conv-survivor")
	escalations := countEscalations(t)

	if !KillTask(id) {
		t.Fatalf("KillTask did not stop a running task")
	}
	time.Sleep(2500 * time.Millisecond) // past the registry's two-second escalation

	if n := escalations(); n < 1 {
		t.Fatalf("a task whose child survived the polite stop was never force-killed (%d escalations)", n)
	}
}

// TestStopBackgroundTasksDoesNotForceKillReapedPids covers the project-switch
// and shutdown stop, which signals every task and then takes the groups of any
// that ignored it after one shared grace.
func TestStopBackgroundTasksDoesNotForceKillReapedPids(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX-only shell command")
	}

	root := t.TempDir()
	startLoneProcessTask(t, root, "conv-stop")
	escalations := countEscalations(t)

	if stopped := StopBackgroundTasks(root, "Stopped when the project changed", time.Second); stopped != 1 {
		t.Fatalf("expected to stop 1 task, stopped %d", stopped)
	}
	if n := escalations(); n != 0 {
		t.Fatalf("stopped task was force-killed %d time(s) after its process had been reaped; that pid can name something else by then", n)
	}
}
