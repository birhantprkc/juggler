//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build darwin

package osactivity

// #cgo LDFLAGS: -framework Foundation
// extern void juggler_activity_begin(void);
// extern void juggler_activity_end(void);
import "C"

// Begin increments the activity refcount. On the 0→1 transition macOS is
// told this process is doing user-initiated work and must not be
// App-Napped. Safe to call from any goroutine.
func Begin() { C.juggler_activity_begin() }

// End decrements the activity refcount. On the 1→0 transition the
// assertion is released and macOS may App-Nap the process again. Pair
// every Begin with exactly one End (a `defer osactivity.End()` after
// `osactivity.Begin()` is the canonical pattern).
func End() { C.juggler_activity_end() }
