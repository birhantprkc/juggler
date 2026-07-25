//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !darwin && !linux

package main

import "github.com/wailsapp/wails/v3/pkg/application"

// applyWindowChrome is a macOS-only chrome tweak; it's a no-op elsewhere. The
// Wails native window background suffices on Windows.
func applyWindowChrome(_ *application.WebviewWindow, _ application.RGBA) {}

// paintSystemChrome is a no-op on Windows: there's no forced NSWindow appearance
// pinning the WebView's prefers-color-scheme, and WebView2's matchMedia tracks
// the OS setting reliably, so the page's own guess is correct. Trust the theme
// it sent. (Linux has its own implementation in window_chrome_linux.go — its
// embedded WebKitGTK webview does NOT track the OS setting.)
func paintSystemChrome(_ *application.WebviewWindow, pageColour application.RGBA, pageTheme string) (application.RGBA, string) {
	return pageColour, pageTheme
}
