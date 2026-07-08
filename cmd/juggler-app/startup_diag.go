//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"log/slog"
	"os"
	"strings"
	"time"

	"juggler/internal/jlog"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// windowStartupTimeout bounds how long we wait for the initial window to become
// visible before treating the launch as a failure. Generous, so a slow machine
// or a first-run webview warm-up never trips it — this is a "the window is never
// coming" backstop, not a performance check.
const windowStartupTimeout = 20 * time.Second

// fatalf reports an unrecoverable window-startup failure as loudly as possible —
// to the console (a terminal launch) and to app.log (a windowless launch) — then
// exits non-zero. It exists to turn an otherwise-silent GUI failure into a
// diagnosable crash: without it, a webview that fails to initialise leaves a
// process that either exits 0 with nothing on screen or sits alive with no
// window and no output. jlog.Error already writes to stderr and the file; we
// flush the file sink before exiting so the breadcrumb survives the os.Exit.
func fatalf(format string, args ...any) {
	jlog.Error("[juggler-app] FATAL: "+format, args...)
	jlog.Close()
	os.Exit(1)
}

// wailsLogHandlers builds the option fields that stop Wails from swallowing its
// own diagnostics. In a production build (-tags production) Wails defaults its
// system logger to io.Discard and, with no ErrorHandler set, routes every
// internal error — including the fatal os.Exit(1) path — into that void. That is
// exactly why a failed window launch is silent. We point all of it at jlog
// instead, so GTK/WebKit warnings, version banners, and errors reach the same
// console + app.log everything else uses.
func wailsLogHandlers() (logger *slog.Logger, onErr func(error), onWarn func(string), onPanic func(*application.PanicDetails)) {
	logger = slog.New(slog.NewTextHandler(jlogWriter{}, &slog.HandlerOptions{Level: slog.LevelDebug}))
	onErr = func(err error) { jlog.Error("[wails] %v", err) }
	onWarn = func(msg string) { jlog.Info("[wails] warning: %s", msg) }
	onPanic = func(p *application.PanicDetails) {
		if p == nil {
			fatalf("wails panic (no details)")
		}
		fatalf("wails panic: %v\n%s", p.Error, p.FullStackTrace)
	}
	return
}

// jlogWriter adapts an slog handler onto jlog so Wails' structured system log
// lines land in juggler's sink. Each Write is one formatted record; we strip the
// trailing newline slog appends and forward at Info (the level is already inside
// the line text, e.g. "level=ERROR ...").
type jlogWriter struct{}

func (jlogWriter) Write(p []byte) (int, error) {
	jlog.Info("[wails] %s", strings.TrimRight(string(p), "\n"))
	return len(p), nil
}

// windowUnavailableHint is the shared tail of the two "no window" fatal
// messages: the likely causes, in order, for a Linux webview that never paints.
const windowUnavailableHint = "the GTK/WebKit webview layer never presented a window and reported no error. " +
	"Check that a WebKitGTK runtime (libwebkit2gtk) is installed, that DISPLAY or " +
	"WAYLAND_DISPLAY is set, and try relaunching with WEBKIT_DISABLE_DMABUF_RENDERER=1 " +
	"and WEBKIT_DISABLE_COMPOSITING_MODE=1."

// watchWindowStartup crashes the process if the initial window never becomes
// visible within windowStartupTimeout. It is the backstop for the failure mode
// where the event loop stays up but the native layer presents no window and
// reports no error — the app would otherwise linger invisibly forever. It closes
// `up` the moment the window is confirmed visible (a normal, healthy launch),
// which also tells run() the loop's later exit was a real one, not a silent
// never-showed exit. Runs on its own goroutine, started before app.Run().
func (a *appState) watchWindowStartup(e *winEntry, up chan struct{}) {
	deadline := time.After(windowStartupTimeout)
	tick := time.NewTicker(250 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-deadline:
			fatalf("initial window never became visible within %s — %s", windowStartupTimeout, windowUnavailableHint)
		case <-tick.C:
			if a.windowIsVisible(e) {
				close(up)
				return
			}
		}
	}
}

// warnIfWindowNeverVisible polls a newly-opened non-initial window (File ▸ New
// Window, or a second-instance hand-off) and logs loudly if it never becomes
// visible within windowStartupTimeout. Unlike the initial-window watchdog it does
// not crash the process — other windows may be healthy — but it makes a window
// that silently fails to appear diagnosable instead of invisible. Runs on its own
// goroutine.
func (a *appState) warnIfWindowNeverVisible(e *winEntry, context string) {
	deadline := time.After(windowStartupTimeout)
	tick := time.NewTicker(250 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-deadline:
			jlog.Error("[juggler-app] window %s (%s) never became visible within %s — %s",
				e.id, context, windowStartupTimeout, windowUnavailableHint)
			return
		case <-tick.C:
			if a.windowIsVisible(e) {
				return
			}
		}
	}
}

// windowIsVisible probes the native window's visibility without letting a stalled
// main loop hang the watchdog. IsVisible marshals onto the main thread; if that
// loop never starts (a wedged GTK init), the call blocks — so we bound it and
// treat a non-answer as "not visible yet" and keep polling until the deadline.
func (a *appState) windowIsVisible(e *winEntry) bool {
	res := make(chan bool, 1)
	go func() { res <- e.win.IsVisible() }()
	select {
	case v := <-res:
		return v
	case <-time.After(500 * time.Millisecond):
		return false
	}
}
