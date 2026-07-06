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
	Status   string // "running" | "completed" | "failed"
	Output   string // accumulated stdout+stderr (head+tail capped)
	ExitCode int
	Error    string
	Found    bool // false when no task with this id exists (or it was reaped)
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
		Status:   s.Status,
		Output:   s.Output,
		ExitCode: s.ExitCode,
		Error:    s.Error,
		Found:    true,
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
