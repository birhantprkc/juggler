//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package app

import (
	"os"
	"time"

	"juggler/cmd/juggler/server"
	"juggler/internal/jlog"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

const (
	// quitGraceTimeout bounds how long the shutdown goroutine waits for
	// app.Quit() to actually terminate the process before forcing os.Exit.
	// A normal terminate kills us in well under a second; this only fires if
	// the macOS quit genuinely stalled.
	quitGraceTimeout = 5 * time.Second
)

// runWindowApp runs the Wails event loop on the calling (main) goroutine and
// blocks until it exits. It is the single entry point app_wait.go calls; it
// dispatches by mode:
//
//   - Production: the server is windowless. runHeadlessServerApp creates ONLY
//     the hidden engine WebView and runs as a background accessory process; the
//     visible UI lives in the separate juggler-app desktop process.
//   - Test: the integration harness needs the server to host a visible window
//     (the tiled test-pool or a single debug lane). That path is isolated in
//     window_testpool.go and gated entirely on testMode.
//
// done is closed when an external signal (SIGTERM, server error, etc.) wants to
// quit; requestQuit triggers the single serialized shutdown path; onWindowReady
// hands the caller the *App (and main window, when there is one) once launched.
func runWindowApp(srv *server.Server, devMode bool, headless bool, testMode bool, testIframes int, done <-chan struct{}, requestQuit func(), onWindowReady func(*application.App, *application.WebviewWindow)) {
	if testMode {
		runTestPoolWindowApp(srv, devMode, headless, testIframes, done, requestQuit, onWindowReady)
		return
	}
	runHeadlessServerApp(srv, done, onWindowReady)
}

// runHeadlessServerApp runs the Wails event loop for a windowless production
// server. It creates ONLY the hidden engine WebviewWindow — the backend-JS
// runtime — and runs as a macOS *accessory* application: no Dock icon, no menu
// bar, and crucially no main window, so Cocoa never activates or shows a window.
// (The accessory policy must be set at construction: with a single window and
// the default Regular policy, app activation makes that window key and visible,
// and flipping the policy at runtime is too late to prevent that flash.) The
// visible UI lives in the separate
// juggler-app process, which connects over HTTP/WebSocket like any viewer.
// Blocks on the calling goroutine until done is closed.
func runHeadlessServerApp(srv *server.Server, done <-chan struct{}, onWindowReady func(*application.App, *application.WebviewWindow)) {
	app := application.New(application.Options{
		Name:        "Juggler",
		Description: "AI Code Agent",
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: false,
			// Background process with no main window — the engine WebView stays
			// hidden and the app never shows or activates a window.
			ActivationPolicy: application.ActivationPolicyAccessory,
		},
		// This server's lifetime is governed by signals / the done channel, NOT
		// by how many windows are open. Its only window is the hidden engine
		// WebView, which the lifecycle controller tears down after an idle
		// window (engine_lifecycle.go) and recreates on demand. Without these,
		// Wails' default "quit when the last window closes" fires the moment the
		// idle engine is reaped, killing the headless server out from under its
		// viewers (the desktop app sees the WS drop a few minutes after going
		// idle: "accept tcp: use of closed network connection"). These are the
		// Windows/Linux twins of the macOS ApplicationShouldTerminate... = false
		// above.
		Linux: application.LinuxOptions{
			ProgramName:                   "Juggler",
			DisableQuitOnLastWindowClosed: true,
		},
		Windows: application.WindowsOptions{
			AdditionalBrowserArgs:         []string{"--disable-logging"},
			DisableQuitOnLastWindowClosed: true,
		},
	})

	app.Event.OnApplicationEvent(events.Common.ApplicationStarted, func(_ *application.ApplicationEvent) {
		// Hand the App reference up to app_wait.go (no window in this mode), then
		// bring the hidden engine WebView up. It stays alive for the process's
		// lifetime — its work runs in a module worker that WebKit doesn't throttle
		// while hidden, and KeepRunningWhenHidden=Disabled keeps it off the
		// CVDisplayLink path that deadlocks on display reconfiguration (see
		// engine_lifecycle.go).
		onWindowReady(app, nil)
		startEngine(app, srv)
	})

	go func() {
		<-done
		jlog.Info("[server] shutdown requested — quitting Wails")
		app.Quit()
		// Safety net: if [NSApp terminate:] fails to land under main-queue
		// contention it can leave the process alive; force-exit after the grace
		// window (mirrors runTestPoolWindowApp's non-test path).
		time.Sleep(quitGraceTimeout)
		jlog.Error("[server] quit did not complete within %v — forcing exit", quitGraceTimeout)
		os.Exit(0)
	}()

	if err := app.Run(); err != nil {
		jlog.Error("application.Run failed: %v", err)
		os.Exit(1)
	}
}
