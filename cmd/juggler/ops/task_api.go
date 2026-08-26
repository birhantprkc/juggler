//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

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
