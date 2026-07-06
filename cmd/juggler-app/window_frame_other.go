//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !windows

package main

// platformFrameless is false everywhere except Windows. macOS gets its
// frameless look from MacTitleBar (transparent, full-size content) which keeps
// the traffic lights; Linux keeps its window-manager decorations.
const platformFrameless = false

// platformWindowHidden: macOS/Linux build windows hidden and reveal them via
// showWindow (on ApplicationStarted / after resolve), which applies chrome
// first and avoids a white flash. Wails' Show()-before-impl race that forces
// visible-creation on Windows doesn't bite here.
const platformWindowHidden = true
