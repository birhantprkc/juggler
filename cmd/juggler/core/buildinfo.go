//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package core contains build-time variables injected via ldflags.
// These are set during `make build` and default to development values.
package core

// Build-time variables set via -ldflags "-X ..."
var (
	// Version is the semantic version (e.g., "0.3.0" or "dev")
	Version = "dev"

	// Commit is the git commit hash (short form)
	Commit = "unknown"

	// BuildDate is the build timestamp in ISO 8601 format
	BuildDate = "unknown"
)
