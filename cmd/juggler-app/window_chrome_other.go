//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !darwin

package main

import "github.com/wailsapp/wails/v3/pkg/application"

// applyWindowChrome is a macOS-only chrome tweak; it's a no-op elsewhere. The
// Wails native window background suffices on Linux/Windows.
func applyWindowChrome(_ *application.WebviewWindow, _ application.RGBA) {}
