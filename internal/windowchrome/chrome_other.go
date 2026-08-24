//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !darwin

// Package windowchrome paints a Wails window's native chrome to match the page
// theme. Everything it does is macOS-specific: the Wails native window
// background suffices on Windows and Linux, and the desktop app handles the OS
// colour scheme there in its own platform files. These no-ops exist so the
// package still builds everywhere rather than being import-guarded per caller.
package windowchrome

import "github.com/wailsapp/wails/v3/pkg/application"

// Apply is a no-op off macOS.
func Apply(_ *application.WebviewWindow, _ application.RGBA) {}

// PaintSystem is a no-op off macOS: there is no forced NSWindow appearance to
// clear, so the page's own guess stands.
func PaintSystem(_ *application.WebviewWindow, pageColour application.RGBA, pageTheme string, _, _ application.RGBA) (application.RGBA, string) {
	return pageColour, pageTheme
}
