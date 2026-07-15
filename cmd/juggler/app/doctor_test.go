//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package app

import (
	"strings"
	"testing"

	"juggler/internal/enginehost"
	"juggler/internal/webviewenv"
)

func TestFormatEngineUnavailableLinux(t *testing.T) {
	t.Run("node missing, apt host offers install commands", func(t *testing.T) {
		d := engineDiagnostics{
			goos: "linux",
			node: enginehost.NodeInfo{Problem: "Node.js was not found on PATH"},
			host: webviewenv.HostInfo{
				PackageManager: "apt-get",
				XvfbInstall:    "sudo apt-get install -y xvfb",
				NodeInstall:    "sudo apt-get install -y nodejs",
			},
		}
		msg := formatEngineUnavailable("no display server detected", d)
		for _, want := range []string{
			"no display server detected",
			"Option 1 — Node.js",
			"sudo apt-get install -y nodejs",
			"Option 2 — Xvfb",
			"sudo apt-get install -y xvfb",
			"Option 3 — a graphical display",
		} {
			if !strings.Contains(msg, want) {
				t.Errorf("banner missing %q\n---\n%s", want, msg)
			}
		}
	})

	t.Run("node too old names the exact version and floor", func(t *testing.T) {
		d := engineDiagnostics{
			goos: "linux",
			node: enginehost.NodeInfo{
				Path:    "/usr/bin/node",
				Version: "v18.19.1",
				Major:   18,
				Problem: "found node v18.19.1 at /usr/bin/node — need ≥ 22",
			},
			host: webviewenv.HostInfo{PackageManager: "apt-get", NodeInstall: "sudo apt-get install -y nodejs"},
		}
		msg := formatEngineUnavailable("engine did not initialise", d)
		if !strings.Contains(msg, "v18.19.1") || !strings.Contains(msg, "need ≥ 22") {
			t.Errorf("banner should name the found version and floor:\n%s", msg)
		}
	})

	t.Run("xvfb already installed points at xvfb-run", func(t *testing.T) {
		d := engineDiagnostics{
			goos: "linux",
			node: enginehost.NodeInfo{Problem: "Node.js was not found on PATH"},
			host: webviewenv.HostInfo{HasXvfb: true},
		}
		msg := formatEngineUnavailable("no display", d)
		if !strings.Contains(msg, "xvfb-run is installed") {
			t.Errorf("banner should note xvfb-run is installed:\n%s", msg)
		}
	})

	t.Run("userns restriction adds the sandbox note", func(t *testing.T) {
		d := engineDiagnostics{
			goos:          "linux",
			node:          enginehost.NodeInfo{Problem: "Node.js was not found on PATH"},
			usernsBlocked: true,
		}
		msg := formatEngineUnavailable("no display", d)
		if !strings.Contains(msg, "WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1") {
			t.Errorf("banner should mention the sandbox escape hatch when userns blocked:\n%s", msg)
		}
	})
}

func TestFormatDoctor(t *testing.T) {
	t.Run("headless linux with good node reports node as chosen", func(t *testing.T) {
		d := engineDiagnostics{
			goos: "linux",
			node: enginehost.NodeInfo{Path: "/usr/bin/node", Version: "v22.3.0", Major: 22, OK: true},
			host: webviewenv.HostInfo{PackageManager: "apt-get"},
		}
		out := formatDoctor(d)
		for _, want := range []string{"OS:", "linux", "Node.js:", "v22.3.0", "Chosen host:", "node"} {
			if !strings.Contains(out, want) {
				t.Errorf("doctor output missing %q\n---\n%s", want, out)
			}
		}
	})

	t.Run("headless linux with no host prints remediation and webview choice", func(t *testing.T) {
		d := engineDiagnostics{
			goos: "linux",
			node: enginehost.NodeInfo{Problem: "Node.js was not found on PATH"},
			host: webviewenv.HostInfo{},
		}
		out := formatDoctor(d)
		if !strings.Contains(out, "webview") {
			t.Errorf("with no node the ladder should choose webview:\n%s", out)
		}
		if !strings.Contains(out, "Option 1 — Node.js") {
			t.Errorf("doctor should append the remediation banner when nothing backs the webview:\n%s", out)
		}
	})

	t.Run("darwin reports a display and webview without linux-only rows", func(t *testing.T) {
		d := engineDiagnostics{
			goos: "darwin",
			node: enginehost.NodeInfo{Problem: "Node.js was not found on PATH"},
		}
		out := formatDoctor(d)
		if strings.Contains(out, "WAYLAND_DISPLAY") {
			t.Errorf("darwin doctor should omit linux-only rows:\n%s", out)
		}
		if !strings.Contains(out, "Chosen host:") || !strings.Contains(out, "webview") {
			t.Errorf("darwin should choose webview:\n%s", out)
		}
	})
}
