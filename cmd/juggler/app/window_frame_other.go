//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !windows

package app

// platformFrameless is false everywhere except Windows. On macOS the frameless
// appearance comes from MacTitleBar (transparent, full-size content) which
// keeps the native traffic-light buttons; a true Frameless window would drop
// them. Linux keeps its native window manager decorations. See
// window_frame_windows.go for the Windows rationale.
const platformFrameless = false
