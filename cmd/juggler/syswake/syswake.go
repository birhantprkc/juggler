//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package syswake is a tiny, lock-free pub/sub for "the OS resumed from
// sleep" events. The platform sleep/wake observer (darwin: the NSWorkspace
// DidWake hook in cmd/juggler) calls Fire(); interested subsystems (the
// worker Manager, which cancels LLM requests orphaned by the sleep) register
// via OnWake() at startup.
//
// It exists to decouple the cgo wake callback (package main) from the worker
// Manager (created in the server package) without either importing the
// other. Subscribers run in their own goroutines so a slow handler can't
// stall the wake callback, which on macOS may run on the main thread.
//
// Lock-free by design (per the project's goroutines-and-channels rule): the
// subscriber list is an atomic pointer swapped append-only, mirroring the
// wakeNudge pattern in the main-thread watchdog.
package syswake

import "sync/atomic"

var subs atomic.Pointer[[]func()]

func init() {
	empty := []func(){}
	subs.Store(&empty)
}

// OnWake registers fn to be invoked on every system-wake. Registration is
// append-only and lock-free; callers register once at startup, before any
// wake can meaningfully race.
//
// Registration is cross-platform, but only platforms with a sleep/wake
// observer that calls Fire (currently darwin) will ever invoke the handlers;
// elsewhere subscribers register harmlessly and never fire.
func OnWake(fn func()) {
	if fn == nil {
		return
	}
	for {
		old := subs.Load()
		next := make([]func(), len(*old)+1)
		copy(next, *old)
		next[len(*old)] = fn
		if subs.CompareAndSwap(old, &next) {
			return
		}
	}
}
