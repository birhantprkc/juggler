//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package webviewenv reports whether the host can bring up the Wails/WebKit
// webview that Juggler depends on, and builds the user-facing message shown
// when it can't.
//
// Juggler runs its agent engine inside a hidden webview even in headless server
// mode (the engine is the only thing that executes tools — see
// cmd/juggler/app/engine_lifecycle.go), so a host with no display server or no
// system webview runtime — a container, a CI runner, an SSH session with no
// desktop — cannot run the engine at all. Without help that failure is silent:
// the process sits for the connect timeout and then dies with a terse log line.
// This package turns it into an immediate, actionable, per-OS error, since what
// is missing (and how to supply it) differs on Linux, macOS, and Windows.
package webviewenv

import (
	"os"
	"runtime"
	"strings"
)

// Preflight returns a short description of a prerequisite that is *definitely*
// missing (so the webview can never initialise), or "" when nothing conclusive
// can be detected cheaply. It is deliberately conservative: it only reports a
// problem it is certain about, so a "" result does NOT mean the webview will
// work — the connect timeout remains the real catch-all. Its purpose is to fail
// fast on the common, unambiguous case (a headless Linux host with no display)
// instead of making the user wait out the timeout.
func Preflight() string {
	return preflight(runtime.GOOS, os.Getenv("DISPLAY"), os.Getenv("WAYLAND_DISPLAY"))
}

// preflight is the testable core of Preflight, taking the OS and the relevant
// environment explicitly so every branch is reachable from any host.
func preflight(goos, display, wayland string) string {
	// On Linux, WebKitGTK cannot initialise without an X11 or Wayland display.
	// With neither DISPLAY nor WAYLAND_DISPLAY set there is no display server to
	// connect to — a certain failure. (A set-but-broken display is not certain,
	// so it is left to the timeout.) macOS and Windows have no equivalently cheap
	// and reliable signal, so they fall through to the timeout + message path.
	if goos == "linux" && display == "" && wayland == "" {
		return "no display server detected (neither DISPLAY nor WAYLAND_DISPLAY is set)"
	}
	return ""
}

// UnavailableMessage builds the multi-line diagnostic printed when the webview
// cannot be brought up. reason is a short lead describing how the failure was
// detected (a Preflight finding, or "the … did not initialise within 30s"); the
// body is the per-OS list of things to check.
func UnavailableMessage(reason string) string {
	return message(runtime.GOOS, reason)
}

// message is the testable core of UnavailableMessage.
func message(goos, reason string) string {
	var b strings.Builder
	b.WriteString("Juggler cannot start: ")
	b.WriteString(reason)
	b.WriteString(".\n\n")
	b.WriteString("Juggler runs its agent engine inside a webview, so it needs a graphical\n")
	b.WriteString("display and a system webview runtime even when running headless (no window).\n\n")
	b.WriteString("To fix this:\n")
	b.WriteString(remediation(goos))
	return b.String()
}

// remediation returns the per-OS bullet list of fixes.
func remediation(goos string) string {
	switch goos {
	case "linux":
		return "" +
			"  • Install a WebKitGTK runtime (e.g. libwebkit2gtk-4.1-0, or webkit2gtk4.1).\n" +
			"  • Make a display available by setting DISPLAY or WAYLAND_DISPLAY. In a\n" +
			"    container, CI runner, or over SSH with no desktop, run under a virtual\n" +
			"    framebuffer — e.g. `xvfb-run -a juggler`.\n" +
			"  • If a display exists but the webview still won't start, try setting\n" +
			"    WEBKIT_DISABLE_DMABUF_RENDERER=1 and WEBKIT_DISABLE_COMPOSITING_MODE=1.\n"
	case "darwin":
		return "" +
			"  • Run Juggler from a logged-in graphical (Aqua) session. macOS cannot\n" +
			"    create a webview from an SSH session or a session-0 LaunchDaemon.\n" +
			"  • To start it under launchd, use a LaunchAgent in your GUI login session,\n" +
			"    not a LaunchDaemon.\n"
	case "windows":
		return "" +
			"  • Install the Microsoft Edge WebView2 Runtime (Evergreen):\n" +
			"    https://developer.microsoft.com/microsoft-edge/webview2/\n" +
			"  • Run Juggler in an interactive user session. Windows Server Core and\n" +
			"    session-0 services have no desktop and cannot host a webview.\n"
	default:
		return "  • Ensure a graphical display and a system webview runtime are available.\n"
	}
}
