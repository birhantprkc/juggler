//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"juggler/internal/windowchrome"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// applyWindowChrome syncs the native NSWindow chrome with the page theme. Call
// it once after window creation and again on every theme toggle.
func applyWindowChrome(win *application.WebviewWindow, bg application.RGBA) {
	windowchrome.Apply(win, bg)
}

// paintSystemChrome makes the window follow the OS light/dark setting and
// reports the theme that resolves to. It clears the forced NSWindow appearance
// (so the WKWebView's prefers-color-scheme tracks System Settings again), then
// reads the effective appearance to pick the background colour and theme name.
// When the window has no native handle yet it falls back to the page's guess.
// Must run on the main thread. See control.go's "system" theme branch.
func paintSystemChrome(win *application.WebviewWindow, pageColour application.RGBA, pageTheme string) (application.RGBA, string) {
	return windowchrome.PaintSystem(win, pageColour, pageTheme, themeColours["dark"], themeColours["light"])
}

// watchSystemColorScheme is Linux-only: on macOS "system" mode clears the forced
// NSWindow appearance, so the WKWebView's prefers-color-scheme tracks System
// Settings and the page's own matchMedia 'change' listener follows live toggles.
// No-op here.
func (a *appState) watchSystemColorScheme() {}
