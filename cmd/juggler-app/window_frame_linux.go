//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

// platformFrameless strips the native GTK window decorations on Linux so the
// app's own header fills the top of the window; the page supplies
// min/maximise/close buttons (web/js/components/window-caption-controls.js),
// matching the frameless Windows look (macOS keeps its traffic lights via
// MacTitleBar instead). The vendored Wails fork keeps a frameless GTK window
// draggable (the --wails-draggable header region) and edge-resizable (its
// IsLinux()+frameless resize gate → gtk_window_begin_resize_drag), so dropping
// the decorations loses no window management.
const platformFrameless = true

// platformWindowHidden: Linux builds windows hidden and reveals them via
// showWindow once chrome is applied, avoiding a white flash. Wails'
// Windows-only Show()-before-impl race doesn't bite here.
const platformWindowHidden = true
