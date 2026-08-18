//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package app

import (
	"fmt"
	"os"
	"time"

	"juggler/cmd/juggler/server"
	"juggler/internal/jlog"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

const (
	// serverShutdownTimeout bounds the graceful server shutdown registered as a
	// cleanup by initServer: closing WebSockets, stopping workers, and closing
	// every cached conversation (which terminates provider subprocesses).
	serverShutdownTimeout = 10 * time.Second

	// quitGraceTimeout bounds how long the shutdown goroutine waits before
	// forcing os.Exit. A normal quit kills us in well under a second; this only
	// fires if the shutdown genuinely stalled.
	//
	// It must stay comfortably above serverShutdownTimeout: the teardown runs
	// inside this window (see App.beginShutdown), and force-exiting partway
	// through would orphan the very subprocesses teardown exists to reap.
	quitGraceTimeout = serverShutdownTimeout + 5*time.Second
)

// runWindowApp blocks on the calling goroutine and dispatches by mode:
//
//   - Production with Node: starts the engine process without initializing Wails.
//   - Production with WebView: runs the hidden engine WebView in a background
//     native application; the visible UI lives in juggler-app.
//   - Test: runs the integration harness's visible tiled pool or debug lane.
//
// done is closed when an external signal (SIGTERM, server error, etc.) wants to
// quit; requestQuit triggers the single serialized shutdown path; onWindowReady
// hands the caller the *App (and main window, when there is one) once launched.
func runWindowApp(srv *server.Server, devMode bool, headless bool, testMode bool, testIframes int, selected selectedEngineHost, done <-chan struct{}, requestQuit func(), onWindowReady func(*application.App, *application.WebviewWindow)) {
	if testMode {
		runTestPoolWindowApp(srv, devMode, headless, testIframes, done, requestQuit, onWindowReady)
		return
	}
	runHeadlessServerApp(srv, selected, done, requestQuit, onWindowReady)
}

// runHeadlessServerApp runs a windowless production server. Node mode starts
// without a native application or display connection. WebView mode runs Wails
// as a macOS accessory application with only the hidden engine window: no Dock
// icon, menu bar, or main window. The visible UI lives in the separate
// juggler-app process, which connects over HTTP/WebSocket like any viewer.
// Blocks on the calling goroutine until done is closed.
//
// requestQuit is the same shutdown trigger the signal handlers use. Engine-host
// startup failures route through it so the server cannot linger without a
// functioning engine.
func runHeadlessServerApp(srv *server.Server, selected selectedEngineHost, done <-chan struct{}, requestQuit func(), onWindowReady func(*application.App, *application.WebviewWindow)) {
	if !engineHostRequiresNativeApp(selected.mode) {
		onWindowReady(nil, nil)
		startEngineHost(buildEngineHost(selected, nil, srv, requestQuit), srv, requestQuit)
		<-done
		return
	}

	// The headless server MUST NOT share a GtkApplication identity with the
	// desktop viewer (juggler-app) or with sibling per-project servers. On Linux,
	// Wails derives the GApplication ID from Name ("org.wails."+sanitized) and
	// always registers it as *unique* on the session bus (it hardcodes
	// G_APPLICATION_DEFAULT_FLAGS). Two live processes with the same ID collide:
	// the second becomes a remote instance, its GTK "activate" never fires
	// locally, and Wails' window Run() blocks forever in waitForActivation before
	// it ever calls windowNew — so that process's window is never created. For the
	// viewer that means no window at all plus gtk_widget_is_visible(NULL)
	// GTK-CRITICAL spam; for a server it means the hidden engine WebView never
	// comes up. Because both this server and juggler-app were named "Juggler",
	// every launch that runs a server alongside the app (i.e. all of them) raced
	// for org.wails.juggler and one side lost. Give each server a process-unique
	// name so its GApplication ID can never collide. The server is windowless, so
	// this name is never user-visible.
	app := application.New(application.Options{
		Name:        fmt.Sprintf("Juggler Server %d", os.Getpid()),
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
		startEngineHost(buildEngineHost(selected, app, srv, requestQuit), srv, requestQuit)
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
