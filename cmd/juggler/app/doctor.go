//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package app

import (
	"fmt"
	"os"
	"runtime"
	"strings"

	"juggler/internal/enginehost"
	"juggler/internal/webviewenv"
)

// engineDiagnostics is the set of host facts the engine-host selection depends
// on, gathered once so the fatal banner and `juggler doctor` render from the
// same snapshot. It is a plain value so the formatters below are pure and
// table-testable.
type engineDiagnostics struct {
	goos           string
	display        string // DISPLAY value ("" if unset)
	wayland        string // WAYLAND_DISPLAY value ("" if unset)
	node           enginehost.NodeInfo
	host           webviewenv.HostInfo
	usernsBlocked  bool
	forcedHostMode string // JUGGLER_ENGINE_HOST value ("" if unset/auto)
}

// gatherEngineDiagnostics runs every probe once (node --version, PATH lookups,
// /proc reads) and returns the snapshot. Side-effect free beyond the probes.
func gatherEngineDiagnostics() engineDiagnostics {
	return engineDiagnostics{
		goos:           runtime.GOOS,
		display:        os.Getenv("DISPLAY"),
		wayland:        os.Getenv("WAYLAND_DISPLAY"),
		node:           probeNode(),
		host:           webviewenv.DetectHost(),
		usernsBlocked:  webviewenv.UserNamespacesRestricted(),
		forcedHostMode: os.Getenv(enginehost.EnvVar),
	}
}

// displayAvailable reports whether a graphical display is present for this
// snapshot (always true off Linux, matching displayPresent).
func (d engineDiagnostics) displayAvailable() bool {
	if d.goos != "linux" {
		return true
	}
	return d.display != "" || d.wayland != ""
}

// engineUnavailableMessage builds the diagnostic printed when no engine host
// could be brought up. On Linux it is node-aware — it lists the display, Node,
// and Xvfb options with the exact install command for each — because node mode
// makes "install Node.js" a lighter fix than Xvfb. Off Linux the engine still
// only runs in the webview, so it defers to webviewenv's per-OS message.
func engineUnavailableMessage(reason string) string {
	d := gatherEngineDiagnostics()
	if d.goos != "linux" {
		return webviewenv.UnavailableMessage(reason)
	}
	return formatEngineUnavailable(reason, d)
}

// formatEngineUnavailable is the testable core of the Linux fatal banner.
func formatEngineUnavailable(reason string, d engineDiagnostics) string {
	var b strings.Builder
	b.WriteString("Juggler cannot start: ")
	b.WriteString(reason)
	b.WriteString(".\n\n")
	b.WriteString("Juggler's agent engine needs ONE of the following, and this host has none\n")
	b.WriteString("that works. Any one of them is enough:\n\n")

	b.WriteString("  Option 1 — Node.js (recommended, lightest): run the engine headless.\n")
	b.WriteString("    " + nodeStatusLine(d.node) + "\n")
	if !d.node.OK {
		if d.host.NodeInstall != "" {
			b.WriteString("    Install it with `" + d.host.NodeInstall + "` (Node " +
				fmt.Sprintf("%d", enginehost.MinNodeMajor) + "+ required).\n")
		} else {
			b.WriteString("    Install Node.js " + fmt.Sprintf("%d", enginehost.MinNodeMajor) +
				"+ from your package manager or https://nodejs.org.\n")
		}
	}

	b.WriteString("\n  Option 2 — Xvfb: give the webview a virtual framebuffer.\n")
	switch {
	case d.host.HasXvfb:
		b.WriteString("    xvfb-run is installed — run `xvfb-run -a juggler`.\n")
	case d.host.XvfbInstall != "":
		b.WriteString("    Install it with `" + d.host.XvfbInstall + "`, then run `xvfb-run -a juggler`.\n")
	default:
		b.WriteString("    Install your distro's Xvfb package, then run `xvfb-run -a juggler`.\n")
	}

	b.WriteString("\n  Option 3 — a graphical display: set DISPLAY or WAYLAND_DISPLAY, or run\n")
	b.WriteString("    Juggler in a desktop (X11/Wayland) session.\n")

	if d.usernsBlocked {
		b.WriteString("\nNote: this host also restricts the unprivileged user namespaces the\n")
		b.WriteString("WebKitGTK sandbox needs, so the Xvfb/display options additionally require\n")
		b.WriteString("WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1 (the Node option is unaffected).\n")
	}
	return b.String()
}

// nodeStatusLine renders one human line describing what the node probe found.
func nodeStatusLine(info enginehost.NodeInfo) string {
	if info.OK {
		return fmt.Sprintf("Found Node %s at %s — run with JUGGLER_ENGINE_HOST=node.", info.Version, info.Path)
	}
	if info.Problem != "" {
		return "Not usable: " + info.Problem + "."
	}
	return "Node.js was not found on PATH."
}

// runDoctor implements the `juggler doctor` subcommand: it prints a table of
// every engine-host probe and the mode the ladder would choose, with no server
// boot and no side effects. It is dispatched from run.go before flag parsing,
// exactly like `juggler ext`.
func runDoctor(args []string) int {
	_ = args // doctor takes no arguments today; accepted for a stable signature.
	d := gatherEngineDiagnostics()
	fmt.Print(formatDoctor(d))
	return 0
}

// formatDoctor is the testable core of runDoctor.
func formatDoctor(d engineDiagnostics) string {
	var b strings.Builder
	b.WriteString("Juggler engine-host diagnostics\n")
	b.WriteString("===============================\n\n")

	row := func(label, value string) {
		fmt.Fprintf(&b, "  %-20s %s\n", label+":", value)
	}

	row("OS", d.goos)
	row(enginehost.EnvVar, orNone(d.forcedHostMode))
	if d.goos == "linux" {
		row("DISPLAY", orNone(d.display))
		row("WAYLAND_DISPLAY", orNone(d.wayland))
	}
	row("Display available", yesNo(d.displayAvailable()))
	row("Node.js", nodeStatusLine(d.node))
	if d.goos == "linux" {
		row("Package manager", orNone(d.host.PackageManager))
		row("xvfb-run", yesNo(d.host.HasXvfb))
		row("userns restricted", yesNo(d.usernsBlocked))
	}

	// Report the mode the ladder would pick with this snapshot, so the table's
	// bottom line answers the actual question: which host will run?
	mode, reason, err := enginehost.Choose(d.goos, func(k string) string {
		if k == enginehost.EnvVar {
			return d.forcedHostMode
		}
		return ""
	}, func() enginehost.NodeInfo { return d.node }, d.displayAvailable())
	b.WriteString("\n")
	if err != nil {
		row("Chosen host", "ERROR — "+err.Error())
	} else {
		row("Chosen host", fmt.Sprintf("%s (%s)", mode.String(), reason))
	}

	// When the chosen host is the webview but no display/xvfb backs it, surface
	// the same remediation the fatal path would print, so doctor is actionable.
	if err == nil && mode == enginehost.ModeWebview && d.goos == "linux" && !d.displayAvailable() && !d.host.HasXvfb {
		b.WriteString("\n")
		b.WriteString(formatEngineUnavailable("no display, no usable Node.js, and no Xvfb", d))
	}
	return b.String()
}

// orNone renders "" as "(none)" for readability in the doctor table.
func orNone(s string) string {
	if s == "" {
		return "(none)"
	}
	return s
}

// yesNo renders a bool as yes/no for the doctor table.
func yesNo(v bool) string {
	if v {
		return "yes"
	}
	return "no"
}
