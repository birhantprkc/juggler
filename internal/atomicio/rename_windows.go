//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build windows

package atomicio

import (
	"errors"
	"os"
	"syscall"
	"time"
)

// Windows surfaces these as transient when another handle momentarily holds the
// destination: an antivirus scanner, the search indexer, or a racing writer.
// POSIX rename-replace has no such window.
const (
	errAccessDenied     = syscall.Errno(5)  // ERROR_ACCESS_DENIED
	errSharingViolation = syscall.Errno(32) // ERROR_SHARING_VIOLATION
)

// RobustRename renames oldpath to newpath, retrying for a bounded window on the
// transient sharing-violation / access-denied errors Windows raises when a
// scanner or racing handle briefly holds the destination open. This is the
// established Go-toolchain idiom (cmd/go's internal/robustio) — the only
// reliable way to make temp+rename atomic publishing work on Windows. The
// sleeps are an OS-transient backoff, not a synchronization stand-in: the
// non-Windows build retries nothing.
func RobustRename(oldpath, newpath string) error {
	const maxWait = time.Second
	start := time.Now()
	for {
		err := os.Rename(oldpath, newpath)
		if err == nil || !isTransient(err) || time.Since(start) >= maxWait {
			return err
		}
		time.Sleep(time.Millisecond)
	}
}

// RobustReadFile reads path, retrying for the same bounded window on the
// transient sharing-violation / access-denied errors Windows raises when a
// concurrent RobustRename is mid-replace of path. POSIX has no such open
// window, so its build reads directly.
func RobustReadFile(path string) ([]byte, error) {
	const maxWait = time.Second
	start := time.Now()
	for {
		data, err := os.ReadFile(path)
		if err == nil || !isTransient(err) || time.Since(start) >= maxWait {
			return data, err
		}
		time.Sleep(time.Millisecond)
	}
}

func isTransient(err error) bool {
	return errors.Is(err, errAccessDenied) || errors.Is(err, errSharingViolation)
}
