//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

// platformFrameless strips the native Win32 caption on Windows so the app's own
// header fills the top of the window; the page supplies min/maximise/close
// buttons (web/js/components/window-caption-controls.js). macOS keeps its
// traffic lights via MacTitleBar instead, so it stays false there.
const platformFrameless = true

// platformWindowHidden: create windows VISIBLE on Windows. Wails' Show()
// has a race — if the native window impl isn't created yet when Show() runs
// (which happens when startup is fast), it creates the window with the current
// options (Hidden:true) and returns without revealing it, so the window never
// appears. Creating it visible makes it show as soon as the impl materialises,
// independent of timing. The geometry is set in the window options, so there's
// no wrong-position flash.
const platformWindowHidden = false
