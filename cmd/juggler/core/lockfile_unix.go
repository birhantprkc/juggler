//go:build !windows

//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"fmt"
	"os"
	"syscall"
	"time"
)

// forceKillProcess forcefully terminates a process by PID on Unix systems
// First tries SIGTERM, then falls back to SIGKILL if needed
func forceKillProcess(pid int) error {
	process, err := os.FindProcess(pid)
	if err != nil {
		return fmt.Errorf("failed to find process %d: %w", pid, err)
	}

	// First try SIGTERM for graceful shutdown
	err = process.Signal(syscall.SIGTERM)
	if err != nil {
		// Process might already be dead
		return nil
	}

	// Wait a bit for process to exit
	time.Sleep(500 * time.Millisecond)

	// Check if process is still running by sending signal 0
	err = process.Signal(syscall.Signal(0))
	if err != nil {
		// Process is dead
		return nil
	}

	// Process still alive - use SIGKILL
	return process.Signal(syscall.SIGKILL)
}
