//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !darwin || production

package app

import "github.com/wailsapp/wails/v3/pkg/application"

// unthrottleHiddenPageTimers is a no-op outside a macOS test build.
//
// Off macOS there is nothing to call: WebKitGTK aligns a hidden page's timers
// the same way but exposes no switch for it, and WebView2 keeps its controller
// visible (Windows.KeepRunningWhenHidden), so its timers are not backgrounded
// in the first place. In a production build it is excluded deliberately —
// see the macOS file for why the SPI must not reach a shipped binary.
func unthrottleHiddenPageTimers(_ *application.WebviewWindow) bool { return false }
