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
