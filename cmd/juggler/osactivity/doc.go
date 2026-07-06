//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package osactivity is a thin, refcounted wrapper around the macOS
// NSProcessInfo activity-assertion API. Call Begin() at the start of a
// user-facing piece of work that must not be App-Napped (an LLM request,
// a tool execution, an outbound HTTPS call); call End() when it's done.
// Defer-friendly: each Begin must be paired with exactly one End. The
// underlying NSProcessInfo activity is taken on the 0→1 transition and
// released on 1→0, so nested or concurrent callers compose correctly.
//
// On non-darwin platforms Begin/End are no-ops.
//
// Rationale: KeepRunningWhenHidden alone is not enough. macOS App Nap is
// a PROCESS-level decision; once the kernel App-Naps us, the WKWebView's
// inactiveSchedulingPolicy is overridden — timers run on a 30s+ cadence
// regardless of per-WebView preferences. The fix is to tell macOS we're
// doing user-initiated work for the duration of that work, then let App
// Nap resume normally when we're idle.
package osactivity
