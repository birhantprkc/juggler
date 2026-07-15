//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package app

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"time"

	"juggler/cmd/juggler/server"
	"juggler/internal/enginehost"
	"juggler/internal/jlog"
	"juggler/internal/webviewenv"

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

// engineHost abstracts the runtime that hosts the agent engine. Whichever host
// is selected, the contract is identical: Start must lead to the engine
// connecting its WebSocket back to the server, after which readiness flows
// through that socket + /api/client/report — a path that is already
// host-agnostic. Selection is made by internal/enginehost.Choose (see
// selectEngineHost); today's only production host is the webview.
type engineHost interface {
	// Start launches the host so the engine connects to addr. It returns once
	// the host has been launched — NOT once the engine has connected, which is
	// gated separately via WaitForEngineConnected. A non-nil error means the
	// host could not be launched at all.
	Start(addr string) error
	// Describe returns a short label for the boot log line ("webview",
	// "node v22.3.0").
	Describe() string
}

// webviewHost runs the engine inside the hidden WebKit/WebView2 webview — the
// original and default host. The window's throttling/GPU/sandbox semantics are
// the hard-won part and live unchanged in newEngineWindow.
type webviewHost struct{ app *application.App }

// Describe implements engineHost.
func (h *webviewHost) Describe() string { return "webview" }

// Start builds and runs the hidden engine WebView. win.Run() must be called on
// the main (Wails) thread, which startEngine's ApplicationStarted callback
// guarantees.
func (h *webviewHost) Start(addr string) error {
	win := newEngineWindow(h.app, addr)
	win.Run()
	return nil
}

// startEngine selects an engine host, brings it up at startup, and installs the
// server's engine-readiness gate. Call from ApplicationStarted (main thread),
// after onWindowReady.
//
// The gate makes a turn (or a worker-driven strategy hook) wait until the engine
// is connected before it can emit tool requests. In steady state the engine is
// already connected and the gate returns immediately; it only ever blocks during
// the startup connect window or while a main-thread-watchdog re-exec is bringing
// a fresh image back up.
//
// The engine host is the entire reason a headless server exists: it is the only
// thing that executes tools, and its engine role is loopback-restricted, so no
// external browser can ever stand in for it (see websocket_loop.go). If it fails
// to come up — a broken GL stack, a WebKit crash, a wedged compositor, a node
// crash — the server can never do useful work, yet without this it would sit
// alive forever (holding its port and instance lock) as an invisible zombie. So
// when the engine doesn't connect within the timeout we call requestQuit to tear
// the process down: a headless server whose host failed must die, not linger.
func startEngine(app *application.App, srv *server.Server, requestQuit func()) {
	host, ok := selectEngineHost(app, srv, requestQuit)
	if !ok {
		// selectEngineHost already logged the specific diagnostic.
		requestQuit()
		return
	}
	start := time.Now()
	jlog.Info("[engine] START — bringing up %s host", host.Describe())
	if err := host.Start(srv.GetAddr()); err != nil {
		jlog.Error("[engine] %s host failed to start: %v", host.Describe(), err)
		requestQuit()
		return
	}
	go func() {
		if srv.WaitForEngineConnected(engineConnectTimeout) {
			jlog.Info("[engine] connected in %v", time.Since(start).Round(time.Millisecond))
			return
		}
		// The engine host never came up (missing webview runtime, no display, a
		// wedged compositor, a WebKit crash, a node process that died…). This is
		// the catch-all for every host and every cause preflight can't detect up
		// front: print the per-OS remediation, then tear the process down so a
		// headless server whose host failed can't linger as a useless zombie
		// holding its port.
		jlog.Error("[engine] %s", engineUnavailableMessage(
			fmt.Sprintf("the hidden engine %s did not initialise within %v", host.Describe(), engineConnectTimeout)))
		requestQuit()
	}()
	srv.SetEngineReadyGate(func() bool { return srv.WaitForEngineConnected(engineConnectTimeout) })
}

// selectEngineHost chooses the engine host per the mode ladder
// (internal/enginehost.Choose), performs the chosen host's own preflight, logs
// the always-on boot one-liner, and constructs it. It returns ok=false — after
// logging the exact diagnostic itself — when the process should quit (an
// unavailable webview, an unusable forced host, or an unknown mode).
func selectEngineHost(app *application.App, srv *server.Server, requestQuit func()) (engineHost, bool) {
	// Memoise the node probe: Choose consults it to validate a forced-node
	// request, and the ModeNode branch reuses the result to build the host — one
	// `node --version` exec, not two.
	var cached *enginehost.NodeInfo
	probe := func() enginehost.NodeInfo {
		if cached == nil {
			info := probeNode()
			cached = &info
		}
		return *cached
	}

	mode, reason, err := enginehost.Choose(runtime.GOOS, os.Getenv, probe, displayPresent(runtime.GOOS))
	if err != nil {
		jlog.Error("[engine] %s", err)
		return nil, false
	}
	switch mode {
	case enginehost.ModeNode:
		info := probe()
		if !info.OK {
			// Choose only returns ModeNode when the probe passed, so reaching
			// here means node vanished between probe and now — belt and braces.
			jlog.Error("[engine] node host unavailable: %s", info.Problem)
			return nil, false
		}
		jlog.Info("[engine] host: %s (%s)", mode.String(), reason)
		return newNodeHost(srv, requestQuit, info), true
	default: // enginehost.ModeWebview
		// Fail fast on a host that provably can't host a webview (e.g. a headless
		// Linux box with no display), rather than creating a window that will
		// never come up and making the user wait out engineConnectTimeout for a
		// terse log line. Preflight is conservative — a "" result is not a
		// guarantee — so the connect timeout still backstops every other cause on
		// every OS. On a Linux host that blocks the unprivileged user namespaces
		// WebKitGTK's bwrap sandbox needs, disable that sandbox before the WebView
		// is created so the engine comes up instead of aborting the process with a
		// cgo SIGTRAP. No-op off Linux, on an unrestricted host, or when the user
		// set the var.
		if note := webviewenv.PrepareLinuxWebKit(); note != "" {
			jlog.Info("[engine] %s", note)
		}
		if problem := webviewenv.Preflight(); problem != "" {
			jlog.Error("[engine] %s", engineUnavailableMessage(problem))
			return nil, false
		}
		jlog.Info("[engine] host: %s (%s)", mode.String(), reason)
		return &webviewHost{app: app}, true
	}
}

// displayPresent reports whether a usable graphical display is available. On
// Linux that requires DISPLAY or WAYLAND_DISPLAY; macOS and Windows always have
// a window server available to a GUI-session process.
func displayPresent(goos string) bool {
	if goos != "linux" {
		return true
	}
	return os.Getenv("DISPLAY") != "" || os.Getenv("WAYLAND_DISPLAY") != ""
}

// probeNode is the production adapter around enginehost.ProbeNode: it resolves
// node on PATH and runs `node --version` with a short timeout so a wedged node
// can never stall startup.
func probeNode() enginehost.NodeInfo {
	return enginehost.ProbeNode(exec.LookPath, func(path string) (string, error) {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		out, err := exec.CommandContext(ctx, path, "--version").Output()
		return string(out), err
	})
}
