//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"encoding/json"
	"net"
	"net/http"
	"strconv"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// The page is served by the (possibly remote) juggler server, so window-control
// requests (theme repaint, minimise/maximise/close, new window) can't go to
// that server — they target this loopback listener instead, addressed per
// window as /win/<id>/<action>. The app bakes each window's base URL into its
// page as the ?nativeCtl= query param. Bound to 127.0.0.1, so only same-host
// callers can reach it regardless of the CORS origin echoed back.

// listenControl binds the control endpoint to an OS-assigned loopback port.
func listenControl() (net.Listener, error) {
	return net.Listen("tcp", "127.0.0.1:0")
}

// serveControl records the listener's loopback port (baked into window URLs as
// ?nativeCtl=) and starts handling control requests on ln. Call once, before
// building any window.
func (a *appState) serveControl(ln net.Listener) {
	a.ctlPort = ln.Addr().(*net.TCPAddr).Port
	mux := http.NewServeMux()
	mux.HandleFunc("/win/", a.handleWindowControl)
	go func() { _ = http.Serve(ln, mux) }()
}

func setCORS(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	if origin == "" {
		origin = "*"
	}
	w.Header().Set("Access-Control-Allow-Origin", origin)
	w.Header().Set("Vary", "Origin")
}

func preflight(w http.ResponseWriter, r *http.Request) bool {
	if r.Method != http.MethodOptions {
		return false
	}
	setCORS(w, r)
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.WriteHeader(http.StatusNoContent)
	return true
}

// handleWindowControl dispatches /win/<id>/<action>. <action> is theme,
// control, or new. The id selects the target window from the registry.
func (a *appState) handleWindowControl(w http.ResponseWriter, r *http.Request) {
	if preflight(w, r) {
		return
	}
	setCORS(w, r)

	rest := strings.TrimPrefix(r.URL.Path, "/win/")
	parts := strings.SplitN(rest, "/", 2)
	if len(parts) != 2 || parts[0] == "" {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	id, action := parts[0], parts[1]

	// "new" doesn't need the originating window — it opens another one. If the
	// caller includes theme/mode/zoom, pass them through so the child window's
	// first paint and native chrome match the source window. theme is the concrete
	// first-frame colour; mode is the opener's selected mode, carried so 'system'/
	// 'auto' survives into the child instead of collapsing to a fixed theme (zoom
	// only seeds a child project that has no saved size of its own; the page gives
	// its session priority).
	if action == "new" {
		zoom, _ := strconv.Atoi(r.URL.Query().Get("zoom"))
		a.openWindowForProject(r.URL.Query().Get("project"), r.URL.Query().Get("theme"), r.URL.Query().Get("mode"), zoom)
		w.WriteHeader(http.StatusNoContent)
		return
	}

	// "open" hands a URL to the system browser. WebKit only auto-routes
	// target="_blank" links to the default browser for external https URLs;
	// a plain http://<lan-ip> link (e.g. the connectivity panel's LAN address)
	// is treated as an in-app popup request, which this windowless-popup app
	// declines — so the page routes such clicks here instead. No window needed.
	if action == "open" {
		target := r.URL.Query().Get("url")
		if !isBrowserURL(target) {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if err := openInBrowser(target); err != nil {
			logf("open URL failed: %v", err)
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}

	e := a.window(id)
	if e == nil {
		w.WriteHeader(http.StatusNotFound)
		return
	}

	switch action {
	case "theme":
		pageTheme := r.URL.Query().Get("theme")
		colour, ok := a.setWindowTheme(e, pageTheme)
		if !ok {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if r.URL.Query().Get("mode") == "system" {
			// System mode: the OS light/dark setting is authoritative, and only
			// the native side can read it reliably — the WKWebView's
			// prefers-color-scheme is pinned by the window's forced appearance, so
			// the page's guessed theme can be stale. paintSystemChrome clears that
			// forced appearance (so the window follows the OS again) and reports
			// the resolved theme, which we echo back so the page can repaint.
			type chrome struct {
				colour application.RGBA
				theme  string
			}
			ch := make(chan chrome, 1)
			application.InvokeAsync(func() {
				c, t := paintSystemChrome(e.win, colour, normaliseTheme(pageTheme))
				e.win.SetBackgroundColour(c)
				ch <- chrome{c, t}
			})
			got := <-ch
			a.setWindowTheme(e, got.theme)
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]string{"theme": got.theme})
			return
		}
		application.InvokeAsync(func() {
			// Repaint the native window to the new theme. SetBackgroundColour is the
			// cross-platform lever: it updates the stored option (so the bare frame
			// exposed during a live resize — and the pre-paint fill — use the new
			// colour) AND repaints the window immediately. On Windows/Linux this is
			// what makes a theme flip actually update the window background, since
			// applyWindowChrome is a no-op there. On macOS applyWindowChrome then
			// additionally repaints the NSWindow appearance and traffic lights.
			e.win.SetBackgroundColour(colour)
			applyWindowChrome(e.win, colour)
		})
		w.WriteHeader(http.StatusNoContent)
	case "title":
		// The page reports the project it's viewing. Two uses: the display title
		// names the window in the macOS "Window" menu (which lists windows by
		// NSWindow title, else every window reads "Juggler"); and the raw project
		// path becomes the window's workspace identity, so a relaunch reopens the
		// right project (projects are chosen in-page, so this report is the only
		// way the app learns which one a window actually shows).
		title := strings.TrimSpace(r.URL.Query().Get("title"))
		if title == "" {
			title = "Juggler"
		}
		application.InvokeAsync(func() { e.win.SetTitle(title) })
		a.setWindowProject(e, r.URL.Query().Get("project"))
		w.WriteHeader(http.StatusNoContent)
	case "control":
		done := make(chan bool, 1)
		application.InvokeAsync(func() {
			switch r.URL.Query().Get("action") {
			case "minimise":
				e.win.Minimise()
			case "maximise":
				e.win.ToggleMaximise()
			case "close":
				e.win.Close()
			}
			done <- e.win.IsMaximised()
		})
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]bool{"maximised": <-done})
	case "attention":
		// Bounce the Dock icon once to pull the user back to a window that needs
		// them (a tool awaiting approval, or a turn that just came to rest). The
		// page only posts this for an unwatched window, so it never fires on the
		// conversation the user is actively looking at.
		application.InvokeAsync(func() { e.win.Flash(true) })
		w.WriteHeader(http.StatusNoContent)
	case "zoom":
		// The page reports its UI zoom (root font-size %) on load and whenever the
		// user changes it. We only track it as the cross-window inheritance seed
		// (the next window built without an inherited zoom opens at this size) —
		// no native window is touched, since zoom is a web-only root font-size.
		zoom, _ := strconv.Atoi(r.URL.Query().Get("zoom"))
		a.setWindowZoom(zoom)
		w.WriteHeader(http.StatusNoContent)
	case "pick-directory":
		// Native folder chooser for the in-page project picker. Runs as a sheet on
		// the requesting window and returns the chosen absolute path (empty string
		// on cancel). Browser clients have no native host and never reach here —
		// they keep using the text path input.
		path, err := a.app.Dialog.OpenFile().
			CanChooseDirectories(true).
			CanChooseFiles(false).
			CanCreateDirectories(true).
			SetTitle("Open project folder").
			AttachToWindow(e.win).
			PromptForSingleSelection()
		if err != nil {
			logf("directory picker failed: %v", err)
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"path": path})
	case "updater":
		a.handleUpdaterControl(w, r, e)
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

// updaterStateResponse is the JSON the page reads from op=state: the global
// updater snapshot plus a per-window flag it can only be answered here, since it
// depends on which window (hence which server) asked — see appManagedServer.
type updaterStateResponse struct {
	UpdaterSnapshot
	// AppManagedServer is true when this window's server was spawned by this app
	// (recorded in st.servers), and so will be replaced by a bundle swap +
	// relaunch. When false the window views a server the app did not start (a
	// terminal/URL/LAN server) — restarting the app won't update it, and the
	// page scopes its messaging accordingly (edge case 18).
	AppManagedServer bool `json:"appManagedServer"`
}

// handleUpdaterControl serves /win/<id>/updater?op=state|install|check|restart.
// state reports the updater snapshot merged with this window's app-managed-server
// flag; install kicks the download/stage flow; check runs a check-only probe
// (reveal availability, never download); restart relaunches into a staged
// update, guarded by the same in-flight-turn check as Cmd+Q. All ops are POST.
func (a *appState) handleUpdaterControl(w http.ResponseWriter, r *http.Request, e *winEntry) {
	switch r.URL.Query().Get("op") {
	case "state":
		snap := updaterSnapshot()
		var managed bool
		a.reg(func(st *regState) { _, managed = st.servers[e.serverURL] })
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(updaterStateResponse{UpdaterSnapshot: snap, AppManagedServer: managed})
	case "install":
		// Fire-and-forget; the overlay guards against a double-start itself. The
		// page learns the outcome from the pushed snapshot, not this response.
		// auto=1 marks the page's own proactive kick rather than a click, so a
		// failure nobody asked to see stays in the log.
		go updaterInstall(r.URL.Query().Get("auto") != "1")
		w.WriteHeader(http.StatusNoContent)
	case "check":
		// Check-only probe: reveal availability without starting a download. The
		// page learns the outcome from the pushed snapshot, not this response.
		go updaterCheck()
		w.WriteHeader(http.StatusNoContent)
	case "restart":
		a.handleUpdaterRestart(w, r)
	default:
		w.WriteHeader(http.StatusBadRequest)
	}
}

// handleUpdaterRestart relaunches into the staged update. It first re-checks
// in-flight turns across every distinct server the open windows view (the exact
// tally confirmThenQuit does) and, unless force=1, returns 409 with the busy
// count so the page can confirm the discard and re-POST with force=1.
//
// CRITICAL sequencing: it authorises the quit (st.quitting + notify pages)
// BEFORE calling updaterRestart(). updaterRestart spawns the swap helper and
// then dispatches Host.Quit(); without a pre-authorised quit the shouldQuit hook
// would veto that quit and show its own native confirm — double-prompting, and
// worse, leaving the already-spawned helper alive to swap the bundle at whatever
// later moment the app eventually quits. On failure it un-authorises the quit so
// the app keeps running and the page can surface the reason.
func (a *appState) handleUpdaterRestart(w http.ResponseWriter, r *http.Request) {
	if r.URL.Query().Get("force") != "1" {
		var urls []string
		a.reg(func(st *regState) {
			seen := map[string]bool{}
			for _, win := range st.windows {
				if !seen[win.serverURL] {
					seen[win.serverURL] = true
					urls = append(urls, win.serverURL)
				}
			}
		})
		total := 0
		for _, u := range urls {
			total += serverBusy(u)
		}
		if total > 0 {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusConflict)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"busy":    total,
				"message": busyMessage(total, "Restarting to update"),
			})
			return
		}
	}

	// Authorise the quit before the updater dispatches it (see the doc comment).
	// notifyAllWindowsCloseRequested also flushes page-owned workspace state so
	// windows/projects restore after the relaunch.
	a.reg(func(st *regState) { st.quitting = true })
	a.notifyAllWindowsCloseRequested()

	if err := updaterRestart(); err != nil {
		// Restart failed — nothing was relaunched. Roll back the authorisation so
		// the app stays runnable and hand the reason to the page.
		a.reg(func(st *regState) { st.quitting = false })
		logf("updater: restart: %v", err)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		_ = json.NewEncoder(w).Encode(map[string]any{"error": err.Error()})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
