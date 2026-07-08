//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package app

import (
	"time"

	"juggler/cmd/juggler/server"
	"juggler/internal/jlog"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// engineConnectTimeout bounds how long the engine-readiness gate waits for the
// hidden engine WebView to load /engine and connect its WebSocket. Generous: a
// cold engine connects in ~1–2s at startup; this is the ceiling a turn waits
// before failing with engine-not-available (only ever relevant during the
// startup window or a watchdog re-exec, since the engine otherwise stays up).
const engineConnectTimeout = 30 * time.Second

// newEngineWindow builds (but does not run) the hidden engine WebviewWindow. The
// engine page boots the worker-backed runtime (web/js/engine-worker-main.js):
// the engine's WebSocket and tool execution run in a module worker, off the
// WebView's main thread, so WebKit's hidden/accessory main-thread throttling
// can't stall them.
//
// KeepRunningWhenHidden is Disabled (WKInactiveSchedulingPolicyThrottle): the
// hidden page main thread is allowed to throttle, so WebKit never pins an
// always-on CVDisplayLink — the display link is the exact path WebKit deadlocks
// on across a display reconfiguration (monitor hot-plug, display sleep, scaling
// switch). The engine's real work lives in the module worker, which keeps
// processing at full rate regardless of the main thread's throttle state, so
// the engine can safely stay alive for the whole process lifetime.
//
// WebviewGpuPolicyNever forces software rendering for this WebView on Linux
// (WebKitGTK). The engine page is off-screen and paints nothing — its work runs
// in a module worker — so it has no use for GPU acceleration. Left at the
// zero-value default (WebviewGpuPolicyAlways), WebKitGTK insists on the
// hardware path and, on a broken or absent GL stack (VM software GL, no DRI,
// headless), fails to bring the WebView up at all — the engine WebSocket never
// connects, engineConnectTimeout elapses, and tool execution never starts.
// Scoped to this window only: the visible viewer window is a separate window in
// the juggler-app process and keeps its own (accelerated) GPU policy.
func newEngineWindow(app *application.App, addr string) *application.WebviewWindow {
	return app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:   "juggler-engine",
		Title:  "Juggler Engine",
		URL:    "http://" + addr + "/engine",
		Width:  200,
		Height: 150,
		Hidden: true,
		Mac: application.MacWindow{
			WebviewPreferences: application.MacWebviewPreferences{
				KeepRunningWhenHidden: application.Disabled,
			},
		},
		Linux: application.LinuxWindow{
			WebviewGpuPolicy: application.WebviewGpuPolicyNever,
		},
	})
}

// startEngine creates the single hidden engine WebView at startup and keeps it
// alive for the process's lifetime, then installs the server's engine-readiness
// gate. Call from ApplicationStarted (main thread), after onWindowReady.
//
// The gate makes a turn (or a worker-driven strategy hook) wait until the engine
// is connected before it can emit tool requests. In steady state the engine is
// already connected and the gate returns immediately; it only ever blocks during
// the startup connect window or while a main-thread-watchdog re-exec is bringing
// a fresh image back up.
//
// This WebView is the entire reason a headless server exists: it is the only
// thing that executes tools, and its engine role is loopback-restricted, so no
// external browser can ever stand in for it (see websocket_loop.go). If it fails
// to come up — a broken GL stack, a WebKit crash, a wedged compositor — the
// server can never do useful work, yet without this it would sit alive forever
// (holding its port and instance lock) as an invisible zombie. So when the
// engine doesn't connect within the timeout we call requestQuit to tear the
// process down: a headless server whose WebView failed must die, not linger.
func startEngine(app *application.App, srv *server.Server, requestQuit func()) {
	start := time.Now()
	jlog.Info("[engine] START — creating hidden engine WebView")
	win := newEngineWindow(app, srv.GetAddr())
	win.Run()
	go func() {
		if srv.WaitForEngineConnected(engineConnectTimeout) {
			jlog.Info("[engine] connected in %v", time.Since(start).Round(time.Millisecond))
			return
		}
		jlog.Error("[engine] did not connect within %v — engine WebView failed to come up; "+
			"terminating headless server so it can't linger as a useless zombie", engineConnectTimeout)
		requestQuit()
	}()
	srv.SetEngineReadyGate(func() bool { return srv.WaitForEngineConnected(engineConnectTimeout) })
}
