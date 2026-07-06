//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package app

// platformFrameless reports whether the production window should be created
// without a native OS title bar. On Windows we strip the default Win32 caption
// (it clashes with the app's own header) and supply min/maximise/close buttons
// from the page — see web/js/components/window-caption-controls.js. macOS gets
// its frameless look from MacTitleBar's transparent/full-size-content config
// instead (which keeps the native traffic-light buttons), so it stays false
// there; setting Frameless on macOS would remove the traffic lights entirely.
const platformFrameless = true
