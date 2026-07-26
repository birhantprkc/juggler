//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build linux

package main

import (
	"github.com/godbus/dbus/v5"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// applyWindowChrome is a macOS-only chrome tweak; it's a no-op on Linux. The
// Wails native window background (set via SetBackgroundColour) suffices here.
func applyWindowChrome(_ *application.WebviewWindow, _ application.RGBA) {}

// watchSystemColorScheme keeps "system" mode tracking live desktop light/dark
// toggles. The embedded WebKitGTK webview derives prefers-color-scheme from the
// app's GTK theme, not the desktop's appearance preference, so the page's own
// matchMedia 'change' listener never fires when the desktop is toggled (see
// theme-manager.js). We instead watch the XDG desktop portal directly — the same
// authoritative signal portalColorScheme() reads on demand — and nudge every
// window to repaint. The page filters: only windows actually in "system" mode
// re-resolve the OS theme (via their usual native POST) and repaint.
//
// Runs on its own private session-bus connection so the signal subscription is
// isolated from the shared method-call bus portalColorScheme() uses. Best-effort:
// on any setup failure (no portal, no session bus) it logs and returns, leaving
// system mode to catch up on the next reload/mode-pick as before.
func (a *appState) watchSystemColorScheme() {
	go func() {
		conn, err := dbus.ConnectSessionBus()
		if err != nil {
			logf("color-scheme watch: session bus: %v", err)
			return
		}
		if err := conn.AddMatchSignal(
			dbus.WithMatchInterface("org.freedesktop.portal.Settings"),
			dbus.WithMatchMember("SettingChanged"),
			dbus.WithMatchObjectPath("/org/freedesktop/portal/desktop"),
		); err != nil {
			logf("color-scheme watch: add match: %v", err)
			_ = conn.Close()
			return
		}
		ch := make(chan *dbus.Signal, 8)
		conn.Signal(ch)
		for sig := range ch {
			// SettingChanged body: namespace string, key string, value variant.
			if len(sig.Body) < 2 {
				continue
			}
			ns, _ := sig.Body[0].(string)
			key, _ := sig.Body[1].(string)
			if ns == "org.freedesktop.appearance" && key == "color-scheme" {
				a.broadcastSystemThemeChanged()
			}
		}
	}()
}

// broadcastSystemThemeChanged dispatches the juggler:system-theme-changed DOM
// event to every open window. Windows not in "system" mode ignore it; those in
// system mode re-resolve the OS theme and repaint (see theme-manager.js). ExecJS
// must run on the main thread, hence InvokeAsync.
func (a *appState) broadcastSystemThemeChanged() {
	var wins []*application.WebviewWindow
	a.reg(func(st *regState) {
		for _, e := range st.windows {
			if e.win != nil {
				wins = append(wins, e.win)
			}
		}
	})
	for _, win := range wins {
		win := win
		application.InvokeAsync(func() {
			win.ExecJS("window.dispatchEvent(new CustomEvent('juggler:system-theme-changed'))")
		})
	}
}

// paintSystemChrome resolves the OS light/dark preference for "system" mode.
//
// Unlike a standalone browser, the embedded WebKitGTK webview derives its
// prefers-color-scheme from the app's GTK theme, NOT from the desktop's
// color-scheme preference (the GNOME 42+ dark toggle / freedesktop appearance
// portal). So the page's matchMedia guess is unreliable in the desktop app and
// "system" mode sticks on light regardless of the OS setting. We read the
// authoritative preference from the XDG desktop portal — the same
// desktop-agnostic signal Chromium/Firefox use — and return that theme, which
// control.go echoes back to the page to paint via data-theme. On any failure
// (no portal, no session bus, "no preference") we fall back to the page's guess.
//
// No GTK handle is needed, so the win arg is unused; the D-Bus read is a fast
// local IPC and touches no GTK, so running on the main thread is harmless.
func paintSystemChrome(_ *application.WebviewWindow, pageColour application.RGBA, pageTheme string) (application.RGBA, string) {
	theme, ok := portalColorScheme()
	if !ok {
		return pageColour, pageTheme // portal unavailable — trust the page's guess
	}
	return themeColours[theme], theme
}

// portalColorScheme reads org.freedesktop.appearance/color-scheme from the XDG
// desktop portal over the session bus. It returns "dark" or "light", or ok=false
// when the preference can't be resolved (portal missing, bus unavailable, or the
// desktop reports "no preference"). Values per the portal spec: 0 = no
// preference, 1 = prefer dark, 2 = prefer light.
func portalColorScheme() (string, bool) {
	conn, err := dbus.SessionBus() // shared connection — do not Close()
	if err != nil {
		return "", false
	}
	obj := conn.Object("org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop")

	// ReadOne (portal Settings v2) returns the value variant directly. Older
	// portals only have Read, which double-wraps the value in an outer variant.
	var v dbus.Variant
	if err := obj.Call("org.freedesktop.portal.Settings.ReadOne", 0,
		"org.freedesktop.appearance", "color-scheme").Store(&v); err != nil {
		var outer dbus.Variant
		if err := obj.Call("org.freedesktop.portal.Settings.Read", 0,
			"org.freedesktop.appearance", "color-scheme").Store(&outer); err != nil {
			return "", false
		}
		inner, ok := outer.Value().(dbus.Variant)
		if !ok {
			return "", false
		}
		v = inner
	}

	n, ok := v.Value().(uint32)
	if !ok {
		return "", false
	}
	switch n {
	case 1:
		return "dark", true
	case 2:
		return "light", true
	default: // 0 (no preference) or anything unexpected: keep the page's guess
		return "", false
	}
}
