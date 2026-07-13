//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"fmt"
	"path/filepath"

	"juggler/cmd/juggler/core"
)

// lockedProjectError means another process still holds a project's OS-level
// lock, but its instance metadata cannot be verified as a running Juggler
// server. The desktop app presents this in an otherwise empty window instead of
// silently dropping a restored session.
type lockedProjectError struct {
	project string
	info    *core.InstanceInfo
}

func newLockedProjectError(project string, info *core.InstanceInfo) *lockedProjectError {
	return &lockedProjectError{project: project, info: info}
}

func (e *lockedProjectError) Error() string {
	return fmt.Sprintf("project is locked: %s", e.project)
}

func (e *lockedProjectError) message() string {
	lockPath := filepath.Join(e.project, ".juggler", "juggler.lock")
	message := "This project is locked by another process, but Juggler could not connect to the session that holds it.\n\n" +
		"The lock file is:\n" + lockPath + "\n\n" +
		"If you are sure no other Juggler process is running for this project, quit Juggler, delete that file, then reopen the project."
	if e.info != nil {
		message += fmt.Sprintf("\n\nThe lock recorded Juggler process %d at %s:%d, but it did not respond as this project.", e.info.PID, e.info.Host, e.info.Port)
	}
	return message
}
