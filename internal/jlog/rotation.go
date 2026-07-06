//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package jlog

import (
	"fmt"
	"os"

	"juggler/internal/atomicio"
)

// rotatingWriter is a size-capped append writer: when a write would push the
// file past maxBytes, the current file is renamed to "<path>.1" (shifting any
// existing backups up by one and dropping the oldest beyond maxBackups) and a
// fresh file takes over. A pure-Go rename shuffle keeps the Windows build
// cgo-free.
//
// It is NOT internally synchronised: jlog drives it exclusively through a
// log.Logger, whose own lock serialises every Write — so the size check and the
// rotate-then-write are already mutually exclusive without a new mutex here.
type rotatingWriter struct {
	path       string
	maxBytes   int64 // <= 0 disables rotation (file grows unbounded)
	maxBackups int   // number of "<path>.N" backups to keep
	f          *os.File
	size       int64
}

// newRotatingWriter opens path for appending. If the existing file already
// exceeds maxBytes it is rotated out at open, so a process restart can't keep
// growing a file that was already oversized.
func newRotatingWriter(path string, maxBytes int64, maxBackups int) (*rotatingWriter, error) {
	w := &rotatingWriter{path: path, maxBytes: maxBytes, maxBackups: maxBackups}

	if maxBytes > 0 {
		if fi, err := os.Stat(path); err == nil && fi.Size() > maxBytes {
			if err := w.shiftBackups(); err != nil {
				return nil, err
			}
		}
	}
	if err := w.open(); err != nil {
		return nil, err
	}
	return w, nil
}

// open (re)opens the main file in append mode and records its current size.
func (w *rotatingWriter) open() error {
	f, err := os.OpenFile(w.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	fi, err := f.Stat()
	if err != nil {
		f.Close()
		return err
	}
	w.f = f
	w.size = fi.Size()
	return nil
}

// Write appends p, rotating first if appending it would exceed the cap. A write
// is never split across a rotation, so each logical log line stays intact.
func (w *rotatingWriter) Write(p []byte) (int, error) {
	if w.maxBytes > 0 && w.size > 0 && w.size+int64(len(p)) > w.maxBytes {
		if err := w.rotate(); err != nil {
			return 0, err
		}
	}
	n, err := w.f.Write(p)
	w.size += int64(n)
	return n, err
}

// rotate closes the current file, shifts it into the backup chain, and opens a
// fresh main file.
func (w *rotatingWriter) rotate() error {
	if w.f != nil {
		w.f.Close()
		w.f = nil
	}
	if err := w.shiftBackups(); err != nil {
		return err
	}
	return w.open()
}

// shiftBackups renames "<path>" → ".1", ".1" → ".2", … dropping the backup at
// index maxBackups (the oldest). The main path is left free for a fresh file.
func (w *rotatingWriter) shiftBackups() error {
	if w.maxBackups <= 0 {
		// No backups kept: just discard the current file.
		return os.Remove(w.path)
	}
	// Drop the oldest backup that would otherwise overflow the retained set.
	_ = os.Remove(fmt.Sprintf("%s.%d", w.path, w.maxBackups))
	// Shift remaining backups up by one, newest-last so we never clobber a
	// not-yet-moved file: .N-1 → .N, …, .1 → .2.
	for i := w.maxBackups - 1; i >= 1; i-- {
		from := fmt.Sprintf("%s.%d", w.path, i)
		to := fmt.Sprintf("%s.%d", w.path, i+1)
		if _, err := os.Stat(from); err == nil {
			if err := atomicio.RobustRename(from, to); err != nil {
				return err
			}
		}
	}
	// Finally, the current file becomes ".1".
	if _, err := os.Stat(w.path); err == nil {
		return atomicio.RobustRename(w.path, w.path+".1")
	}
	return nil
}

// Close closes the underlying file.
func (w *rotatingWriter) Close() error {
	if w.f != nil {
		err := w.f.Close()
		w.f = nil
		return err
	}
	return nil
}
