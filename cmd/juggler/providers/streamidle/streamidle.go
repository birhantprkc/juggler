//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package streamidle wires the user-configurable stream idle timeout into the
// provider-boundary watchdog. The value is a single global setting (seconds)
// persisted in credentials.json under CredKey and read live at each stream
// start, so a gateway whose cold starts exceed the 180s default can be given
// more headroom without a restart or a rebuild.
//
// It lives here — rather than in the low-level providers/utils package — so
// utils stays free of a credentials-store dependency: utils exposes a resolver
// hook (utils.SetStreamIdleTimeoutResolver) and this package installs it at
// startup via Register.
package streamidle

import (
	"strconv"
	"strings"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/providers/utils"
)

// CredKey is the credentials.json field holding the stream idle timeout, in
// whole seconds, as a string. Set from the settings panel; read by resolve.
// Blank/invalid/non-positive ⇒ the utils.StreamIdleTimeout default applies.
const CredKey = "stream_idle_timeout"

// Register installs the live resolver so every streaming provider arms its idle
// watchdog with the user-configured timeout (or the default when unset). Called
// once at startup, alongside the provider registrations; no init() side effects.
func Register() {
	utils.SetStreamIdleTimeoutResolver(resolve)
}

// resolve reads the configured timeout from the credentials store. Returns 0
// (⇒ caller falls back to the default) when the store is unavailable or the
// stored value is blank/invalid/non-positive.
func resolve() time.Duration {
	store, err := core.NewCredentialsStore()
	if err != nil {
		return 0
	}
	return parseIdleTimeout(store.GetRawKey(CredKey))
}

// parseIdleTimeout converts the stored raw string (whole seconds) into a
// duration. Blank, non-numeric, or non-positive input yields 0, signalling the
// caller to use the default rather than an absurdly short window.
func parseIdleTimeout(raw string) time.Duration {
	s := strings.TrimSpace(raw)
	if s == "" {
		return 0
	}
	secs, err := strconv.Atoi(s)
	if err != nil || secs <= 0 {
		return 0
	}
	return time.Duration(secs) * time.Second
}
