//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package enginehost decides which host runs Juggler's agent engine, and
// probes the host facts that decision depends on.
//
// Historically the engine only ever ran inside a hidden WebKit webview (see
// cmd/juggler/app/engine_lifecycle.go). That is still the default and the only
// production path on macOS/Windows, but on a headless Linux host — a container,
// a CI runner, an SSH session with no desktop — no webview can come up. This
// package selects a Node.js host as an alternative when one is available, so
// the same engine graph can run off a webview entirely.
//
// Everything here is a testable core: Choose and ProbeNode take the OS, the
// environment, and their probes as explicit function parameters so every branch
// is reachable from any host (mirroring internal/webviewenv). The package has
// no runtime side effects and imports nothing outside the standard library.
package enginehost

import (
	"fmt"
	"strconv"
	"strings"
)

// EnvVar selects the engine host explicitly. Accepted values: "auto" (the
// default when unset or empty), "webview", and "node". Anything else is
// reported as an error by Choose rather than silently ignored.
const EnvVar = "JUGGLER_ENGINE_HOST"

// MinNodeMajor is the lowest Node.js major version the node host accepts.
// Node 22 is the first release line where WebSocket is a global enabled by
// default (earlier lines keep it behind --experimental-websocket), so the
// engine's services/websocket.js can dial without pulling in a polyfill — the
// node host depends on that global existing. Exported so diagnostics can state
// the version floor.
const MinNodeMajor = 22

// Mode is the selected engine host.
type Mode int

const (
	// ModeWebview runs the engine inside the hidden WebKit/WebView2 webview.
	ModeWebview Mode = iota
	// ModeNode runs the engine inside a spawned Node.js process.
	ModeNode
)

// String returns the label used in log lines and diagnostics.
func (m Mode) String() string {
	switch m {
	case ModeNode:
		return "node"
	default:
		return "webview"
	}
}

// NodeInfo is the result of probing the host for a usable Node.js runtime.
// A NodeInfo is "usable" (OK) only when node is present on PATH AND meets
// MinNodeMajor; Problem always explains a false OK in one user-facing line.
type NodeInfo struct {
	Path    string // resolved path to the node binary ("" when not found)
	Version string // raw version string as reported, e.g. "v22.3.0" ("" when unknown)
	Major   int    // parsed major version (0 when unknown)
	OK      bool   // true iff node is present and meets MinNodeMajor
	Problem string // human-readable reason OK is false ("" when OK)
}

// ProbeNode looks for a usable Node.js runtime. lookPath resolves a binary on
// PATH (os/exec.LookPath in production); runVersion runs `<path> --version` and
// returns its stdout (an exec.Command in production). Both are injected so the
// probe is fully testable without a node install.
func ProbeNode(lookPath func(string) (string, error), runVersion func(path string) (string, error)) NodeInfo {
	path, err := lookPath("node")
	if err != nil {
		return NodeInfo{Problem: "Node.js was not found on PATH"}
	}
	out, err := runVersion(path)
	if err != nil {
		return NodeInfo{
			Path:    path,
			Problem: fmt.Sprintf("found node at %s but `node --version` failed: %v", path, err),
		}
	}
	version := strings.TrimSpace(out)
	major, ok := parseNodeMajor(version)
	if !ok {
		return NodeInfo{
			Path:    path,
			Version: version,
			Problem: fmt.Sprintf("found node at %s but could not parse its version %q", path, version),
		}
	}
	if major < MinNodeMajor {
		return NodeInfo{
			Path:    path,
			Version: version,
			Major:   major,
			Problem: fmt.Sprintf("found node %s at %s — need \u2265 %d", version, path, MinNodeMajor),
		}
	}
	return NodeInfo{Path: path, Version: version, Major: major, OK: true}
}

// parseNodeMajor extracts the major version from a `node --version` string such
// as "v22.3.0" (the leading "v" is optional). It returns ok=false when the
// leading numeric component cannot be read.
func parseNodeMajor(version string) (int, bool) {
	s := strings.TrimPrefix(strings.TrimSpace(version), "v")
	dot := strings.IndexByte(s, '.')
	if dot >= 0 {
		s = s[:dot]
	}
	if s == "" {
		return 0, false
	}
	major, err := strconv.Atoi(s)
	if err != nil {
		return 0, false
	}
	return major, true
}

// Choose decides which host should run the engine.
//
//   - getenv reads the process environment (os.Getenv in production).
//   - probeNode lazily probes for Node.js; it is only called when node is an
//     actual candidate, so hosts that never use node pay nothing.
//   - displayPresent reports whether a usable graphical display exists
//     (DISPLAY/WAYLAND_DISPLAY on Linux; always true on macOS/Windows, whose
//     webview runtimes need no X/Wayland display).
//
// It returns the chosen Mode, a short human-readable reason for the boot log
// line (§3.2 of the design), and a non-nil error only when the request cannot
// be honoured (an unknown env value, or a forced mode whose prerequisites are
// missing). On error the Mode is meaningless.
//
// Rollout note: on Linux, `auto` prefers a usable Node host. This avoids taking
// a dependency on GTK/WebKit availability merely because a DISPLAY variable is
// set, and avoids an unnecessary Xvfb relaunch on headless systems. When Node is
// absent or too old, the established webview path remains the fallback.
func Choose(goos string, getenv func(string) string, probeNode func() NodeInfo, displayPresent bool) (Mode, string, error) {
	switch strings.ToLower(strings.TrimSpace(getenv(EnvVar))) {
	case "webview":
		return ModeWebview, "forced by " + EnvVar + "=webview", nil
	case "node":
		info := probeNode()
		if !info.OK {
			return ModeWebview, "", fmt.Errorf("%s=node was set but %s", EnvVar, info.Problem)
		}
		return ModeNode, fmt.Sprintf("forced by %s=node (%s)", EnvVar, info.Version), nil
	case "", "auto":
		// Node is the robust Linux default: it works whether or not a graphical
		// display, GTK, WebKitGTK, or Xvfb happens to be installed. Preserve the
		// webview fallback for Linux hosts without a suitable Node runtime and for
		// all non-Linux platforms.
		if goos == "linux" {
			if info := probeNode(); info.OK {
				return ModeNode, fmt.Sprintf("auto: node host (%s)", info.Version), nil
			}
			if !displayPresent {
				return ModeWebview, "auto: no display or usable node detected", nil
			}
		}
		return ModeWebview, "auto", nil
	default:
		return ModeWebview, "", fmt.Errorf("unknown %s value %q (want auto, webview, or node)",
			EnvVar, getenv(EnvVar))
	}
}
