//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Command juggler-app is the Juggler desktop window. One process owns many
// windows, each a viewer pointed at a juggler server over HTTP/WebSocket:
//
//   - with --url, the first window connects to an already-running server,
//   - without --url, it spawns a local headless server for --project and
//     connects to that.
//
// "New Window" (menu or the page) opens another in-process window — reusing a
// running per-project server when one exists, else spawning a fresh one. The
// server does all the work and owns the hidden engine webview; this process is
// a pure viewer plus a small loopback endpoint that lets each page drive its
// own native window controls (theme, minimise/maximise/close, new window).
package main

import (
	"flag"
	"io"
	"os"
	"strings"

	"juggler/internal/jlog"
)

func main() {
	urlFlag := flag.String("url", "", "Connect the first window to a juggler server at this URL. When omitted, a local server is spawned.")
	project := flag.String("project", "", "Project folder for the first window's spawned server (ignored when --url is given).")
	verbose := flag.Bool("verbose", false, "Verbose logging and the dev View menu (reload, devtools).")
	dev := flag.Bool("dev", false, "Enable dev mode: web inspector + the full right-click menu, and the dev View menu. Set by a server running with --assets-from-disk when it launches a window.")
	flag.Parse()

	devMode := 0
	if *verbose || *dev {
		devMode = 1
	}
	initAppLogging()
	defer jlog.Close()
	logf("start: url=%q project=%q args=%v", *urlFlag, *project, os.Args)
	app := newAppState(devMode)

	// Build the application — and acquire the single-instance lock — BEFORE
	// resolving any server. If another juggler-app is already running, this call
	// hands our argv (--url/--project) to it and os.Exit()s here, so a redundant
	// launch never spawns a throwaway server; the running instance opens/raises
	// the window (onSecondInstance).
	app.initApplication()

	// Bind the loopback control endpoint so its port can be baked into window
	// URLs as ?nativeCtl=.
	ln, err := listenControl()
	if err != nil {
		logf("control listener: %v", err)
		return
	}
	app.serveControl(ln)

	// An explicit --url/--project opens just that window; otherwise restore the
	// last open set of windows (each at its remembered geometry).
	specs := app.startupSpecs(*urlFlag, *project)
	runErr := app.run(specs)
	app.stopAllServers()
	if runErr != nil {
		logf("window app exited with error: %v", runErr)
	}
}

// normalizeURL ensures a user-supplied --url has an http(s) scheme.
func normalizeURL(u string) string {
	if !strings.HasPrefix(u, "http://") && !strings.HasPrefix(u, "https://") {
		return "http://" + u
	}
	return u
}

// parseLaunchArgs extracts --url and --project from a second instance's argv
// (args[0] is the program). Unknown flags and parse errors are ignored — we
// only care about the two that route a window.
func parseLaunchArgs(args []string) (url, project string) {
	fs := flag.NewFlagSet("juggler-app-second", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	u := fs.String("url", "", "")
	p := fs.String("project", "", "")
	if len(args) > 1 {
		_ = fs.Parse(args[1:])
	}
	return strings.TrimSpace(*u), strings.TrimSpace(*p)
}
