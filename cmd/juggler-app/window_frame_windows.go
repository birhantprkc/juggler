//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

// platformFrameless strips the native Win32 caption on Windows so the app's own
// header fills the top of the window; the page supplies min/maximise/close
// buttons (web/js/components/window-caption-controls.js). macOS keeps its
// traffic lights via MacTitleBar instead, so it stays false there.
const platformFrameless = true

// platformWindowHidden leaves Windows windows logically visible. Wails creates
// the HWND without WS_VISIBLE and normally reveals it after WebView2 navigation;
// revealInitialWindowWhenReady also calls Show once the native frame exists, so
// a delayed navigation cannot leave the app hidden. Keeping Hidden false ensures
// either path ends with a visible window.
const platformWindowHidden = false
