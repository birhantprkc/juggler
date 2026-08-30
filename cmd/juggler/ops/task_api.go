//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import "time"

// Public read/stop accessors for background tasks, for consumers outside this
// package (the worker's generic task-output delivery, cmd/juggler/worker). They
// run in the same process as this registry but in another package, so they
// cannot reach the unexported helpers — these thin wrappers expose exactly the
// generic read/stop surface and nothing more. Every call is serialized through
// the registry goroutine, so they are safe from any goroutine.

// TaskSnapshot is an immutable view of a background task's state.
type TaskSnapshot struct {
	Status          string // "running" | "completed" | "failed"
	Output          string // accumulated stdout+stderr (head+tail capped)
	ExitCode        int
	Error           string
	OutputFile      string
	OutputBytes     int64
	OutputTruncated bool
	Found           bool // false when no task with this id exists (or it was reaped)
}

// BackgroundTaskSnapshot is the durable, observable state of a background task.
// The live process handle remains in the shell registry; consumers persist this
// bounded snapshot so its output and terminal result survive registry reaping.
type BackgroundTaskSnapshot struct {
	TaskID          string `json:"taskId"`
	ConvID          string `json:"-"`
	ToolUseID       string `json:"toolUseId"`
	Status          string `json:"status"`
	Output          string `json:"output"`
	ExitCode        int    `json:"exitCode"`
	Error           string `json:"error,omitempty"`
	OutputFile      string `json:"outputFile,omitempty"`
	OutputBytes     int64  `json:"outputBytes,omitempty"`
	OutputTruncated bool   `json:"truncated,omitempty"`
}

// BackgroundTaskObserver receives bounded snapshots outside the registry actor.
type BackgroundTaskObserver func(BackgroundTaskSnapshot)

// SetBackgroundTaskObserver installs the process-wide persistence sink. The
// server wires it to the owning conversation worker; tests may replace or clear it.
func SetBackgroundTaskObserver(observer BackgroundTaskObserver) {
	setBackgroundTaskObserver(observer)
}

// TaskState returns a snapshot of a background task by id. Found is false when
// no such task exists. A registered task always has a non-empty status, so an
// empty status uniquely means "not found".
func TaskState(taskID string) TaskSnapshot {
	s := getShellState(taskID)
	if s.Status == "" {
		return TaskSnapshot{}
	}
	return TaskSnapshot{
		Status:          s.Status,
		Output:          s.Output,
		ExitCode:        s.ExitCode,
		Error:           s.Error,
		OutputFile:      s.OutputFile,
		OutputBytes:     s.OutputBytes,
		OutputTruncated: s.OutputTruncated,
		Found:           true,
	}
}

// StopBackgroundTasks stops every running background task under projectRoot, or
// under every project when projectRoot is empty, and returns how many it
// signalled. reason is recorded as each task's error text, so say what happened
// in words the user will read on the tool action later.
//
// Background tasks run in their own process group precisely so that a cancelled
// turn cannot take them with it, which also means process exit does not signal
// them: without this they are reparented to init and keep running with no handle
// anywhere. Every task therefore has to be stopped deliberately, at the two
// moments the handle stops being reachable — a project switch and shutdown.
//
// Blocks for at most grace between the polite signal and taking the process
// group, so a caller on the shutdown path pays a bounded, known cost.
func StopBackgroundTasks(projectRoot, reason string, grace time.Duration) int {
	resp := make(chan registryResp, 1)
	registryCh <- registryOp{kind: "killMatching", projectRoot: projectRoot, errMsg: reason, resp: resp}
	result := <-resp
	cmds := result.cmds
	if len(cmds) == 0 {
		return result.stopped
	}

	// One grace for the batch rather than one each: they were all signalled
	// together, so they are all equally far through it. Aliveness is deliberately
	// not polled — cmd.ProcessState is written by the spawner's Wait, and reading
	// it here would race that. Killing a group that has already gone is harmless.
	if grace > 0 {
		time.Sleep(grace)
	}
	for _, cmd := range cmds {
		killProcessGroup(cmd)
	}
	return result.stopped
}

// KillTask terminates a running background task by id. Returns true if the task
// was running and is now stopped. Idempotent: a no-op (returns false) for an
// already-finished or unknown task.
func KillTask(taskID string) bool {
	if getBackgroundShell(taskID) == nil {
		return false
	}
	// killShell sets status to "failed" when it stops a running shell; for a
	// task that was not running it returns the unchanged status.
	return killShell(taskID).Status == "failed"
}
