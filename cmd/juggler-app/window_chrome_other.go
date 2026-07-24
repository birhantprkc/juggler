//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !darwin

package main

import "github.com/wailsapp/wails/v3/pkg/application"

// applyWindowChrome is a macOS-only chrome tweak; it's a no-op elsewhere. The
// Wails native window background suffices on Linux/Windows.
func applyWindowChrome(_ *application.WebviewWindow, _ application.RGBA) {}

// paintSystemChrome is a no-op on Win/Linux: there's no forced NSWindow
// appearance pinning the WebView's prefers-color-scheme, so the page's own
// matchMedia already resolves the OS theme correctly. Trust the theme it sent.
func paintSystemChrome(_ *application.WebviewWindow, pageColour application.RGBA, pageTheme string) (application.RGBA, string) {
	return pageColour, pageTheme
}
