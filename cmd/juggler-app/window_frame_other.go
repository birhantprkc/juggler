//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !windows && !linux

package main

// platformFrameless is false on macOS (and any other non-Windows, non-Linux
// Unix): macOS gets its frameless look from MacTitleBar (transparent, full-size
// content) which keeps the traffic lights, so a real Frameless window would
// delete them. Windows (window_frame_windows.go) and Linux
// (window_frame_linux.go) are frameless and supply their own caption buttons.
const platformFrameless = false

// platformWindowHidden: macOS builds windows hidden and reveals them via
// showWindow (on ApplicationStarted / after resolve), which applies chrome
// first and avoids a white flash. Wails' Show()-before-impl race that forces
// visible-creation on Windows doesn't bite here.
const platformWindowHidden = true
