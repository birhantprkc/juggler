//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package jlog is the exported logging facade for code that composes with the
// juggler module from outside it — a wrapping distribution's ops, providers,
// routes, and tunnel modes log here and their lines land in the same sinks,
// with the same formatting, as the core's own.
//
// It forwards to the module-internal logger (internal/jlog), which the hosting
// app initialises during startup; there is deliberately no Init/Close here —
// lifecycle belongs to whichever main owns the process. Safe to call before
// initialisation (messages go to the console path only).
package jlog

import "juggler/internal/jlog"

// Info logs at info level (always shown on the console).
func Info(format string, args ...any) { jlog.Info(format, args...) }

// Debug logs at debug level (console shows it with --verbose).
func Debug(format string, args ...any) { jlog.Debug(format, args...) }

// Trace logs at trace level (file log only).
func Trace(format string, args ...any) { jlog.Trace(format, args...) }

// Error logs at error level.
func Error(format string, args ...any) { jlog.Error(format, args...) }
