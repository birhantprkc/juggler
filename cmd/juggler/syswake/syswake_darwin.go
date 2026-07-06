//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package syswake

// Fire notifies every registered subscriber that the system woke. Each
// handler runs in its own goroutine so a blocking subscriber cannot stall
// the (possibly main-thread) OS wake callback.
//
// Only darwin has a sleep/wake observer (the NSWorkspace DidWake hook in
// cmd/juggler), so Fire is darwin-only: on other platforms nothing fires
// wake events and the function would be unreachable.
func Fire() {
	for _, fn := range *subs.Load() {
		go fn()
	}
}
