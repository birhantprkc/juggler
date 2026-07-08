//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package app is the importable entrypoint for the juggler server binary.
// The public cmd/juggler main is a thin shim over Run(Config{}); a wrapping
// distribution builds its own main that passes a Config carrying its extension
// points (asset overlay, extra routes) and performs its own registrations
// (ops.Register, registry.RegisterProvider) before calling Run. Everything
// else about startup — flags, phases, teardown — is identical between the two.
package app

import (
	"flag"
	"fmt"
	"io/fs"
	"os"

	"github.com/gorilla/mux"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/mcp"
	"juggler/cmd/juggler/ops"
	"juggler/cmd/juggler/providers/anthropic"
	"juggler/cmd/juggler/providers/claudecode"
	"juggler/cmd/juggler/providers/deepseek"
	"juggler/cmd/juggler/providers/gemini"
	"juggler/cmd/juggler/providers/ollama"
	"juggler/cmd/juggler/providers/openai"
	"juggler/cmd/juggler/providers/openaicodex"
	"juggler/cmd/juggler/providers/openrouter"
	"juggler/cmd/juggler/providers/zai"
	"juggler/cmd/juggler/server"
	"juggler/web"
)

// Config carries the optional extension points a wrapping distribution injects
// into the server. The zero value is the stock public binary. Pro-style
// add-ons register through these seams and through the public registries —
// they never edit files in this repository (see the additive-only contract in
// LICENSING.md).
type Config struct {
	// AssetOverlay, if set, is layered over the embedded web assets via
	// web.SetOverlay: lookups prefer the overlay, directory listings merge.
	// Extra extensions placed under extensions/<name>/ in the overlay are
	// discovered exactly like the built-in ones.
	AssetOverlay fs.FS
	// ExtraRoutes, if set, registers additional HTTP routes on the server's
	// router after the built-in ones (see server.Config.ExtraRoutes).
	ExtraRoutes func(r *mux.Router)
}

// Run executes the juggler server: CLI dispatch, flag parsing, registrations,
// then the App startup phases, blocking until shutdown. It returns the
// process exit code — the caller owns os.Exit so its own defers run.
func Run(cfg Config) int {
	// Developer CLI: `juggler ext …` is a self-contained tool (scaffold/link/add
	// an extension) that must NOT boot a server. Dispatch it before flag parsing
	// or the banner so it behaves like a plain command-line utility.
	if len(os.Args) > 1 && os.Args[1] == "ext" {
		return runExtCommand(os.Args[2:])
	}

	// Determine terminal-vs-icon launch first, before anything writes to stdout.
	// On Windows an icon launch detaches the console Windows allocated for us as
	// a side effect (see launchedFromTerminal), so this must run early.
	hasTerminal := launchedFromTerminal()

	// A GUI launch inherits a stripped PATH that omits everything the user's
	// shell adds (Homebrew, version managers, ~/go/bin, ~/.local/bin, rustup,
	// …). Repair PATH before any child process (bash tool, git, the claude CLI)
	// is spawned so they resolve tools the same way a terminal launch would.
	// No-op for a terminal launch and on Windows.
	repairPathForGUILaunch(hasTerminal)

	flags, version := parseFlags(hasTerminal)
	if version {
		fmt.Printf("juggler %s (commit: %s, built: %s)\n",
			core.Version, core.Commit, core.BuildDate)
		return 0
	}

	// Install the asset overlay before anything reads web.Files.
	if cfg.AssetOverlay != nil {
		web.SetOverlay(cfg.AssetOverlay)
	}

	ops.RegisterAll()
	mcp.Register()
	registerProviders()

	// Self-terminate if our parent dies, so a server spawned by juggler-app (or
	// the test harness) never outlives its owner. The app passes
	// --exit-with-parent; the test harness relies on --test.
	if flags.testMode || flags.exitWithParent {
		startParentWatchdog()
	}

	printBanner()

	app := &App{flags: flags, config: cfg}
	if err := app.Run(); err != nil {
		return 1
	}
	return 0
}

// registerProviders registers every built-in provider with the global registry.
// Called once at startup. Tests that want a subset compose their own calls.
func registerProviders() {
	anthropic.Register()
	claudecode.Register()
	deepseek.Register()
	gemini.Register()
	ollama.Register()
	openai.Register()
	openaicodex.Register()
	openrouter.Register()
	zai.Register()
}

// startParentWatchdog self-terminates the process if the parent dies — e.g. the
// juggler-app desktop process that spawned this server quit or crashed, or the
// test harness was SIGKILL'd before it could signal the pool. This is what makes
// a spawned server never outlive its owner. The actual wait is platform-specific
// (waitParentExit): macOS/Linux poll PPID (no Pdeathsig wired here); Windows
// waits on the parent's process handle, since Windows never reparents an orphan
// so PPID polling there would never fire.
func startParentWatchdog() {
	startPPID := os.Getppid()
	if startPPID <= 1 {
		return
	}
	go func() {
		waitParentExit(startPPID)
		fmt.Fprintln(os.Stderr, "parent gone — self-terminating")
		os.Exit(0)
	}()
}

func parseFlags(hasTerminal bool) (appFlags, bool) {
	verbose := flag.Bool("verbose", false, "Verbose logging (debug level)")
	flag.BoolVar(verbose, "v", false, "Verbose logging (debug level) (shorthand)")
	assetsFromDisk := flag.Bool("assets-from-disk", false, "Load web assets from disk (web/) instead of the embedded FS; disables caching and reloads templates per request")
	version := flag.Bool("version", false, "Print version and exit")
	killExisting := flag.Bool("kill-existing", false, "If another instance holds the lock, kill it instead of prompting")
	window := flag.Bool("window", false, "Open a native window instead of printing the server URL")
	project := flag.String("project", "", "Project folder to open (defaults to cwd in terminal, none in window/app mode)")
	port := flag.Int("port", 0, "Override config port (0 = use config value)")
	testMode := flag.Bool("test", false, "Enable test API routes and print JUGGLER_ADDR to stdout")
	testIframes := flag.Int("test-iframes", 0, "Test-mode only: open the viewer window at /test-pool?n=N (tiled iframes acting as parallel test lanes) instead of the production UI")
	public := flag.Bool("public", false, "Force LAN access on/off at startup (default: on for a direct terminal server, off otherwise; press 'p' to toggle at runtime)")
	// WAN startup flags come from the tunnel-mode registry: each registered
	// mode with a FlagName contributes one bool flag. A build with no
	// registered modes has no WAN flags at all.
	type wanFlag struct {
		mode server.TunnelMode
		val  *bool
	}
	var wanFlags []wanFlag
	for _, spec := range server.TunnelModes() {
		if spec.FlagName == "" {
			continue
		}
		wanFlags = append(wanFlags, wanFlag{mode: spec.Mode, val: flag.Bool(spec.FlagName, false, spec.FlagUsage)})
	}
	exitWithParent := flag.Bool("exit-with-parent", false, "Self-terminate if the parent process dies (set by juggler-app for servers it owns, so they never outlive the app)")
	logFile := flag.String("log-file", "", "Explicit log file path, overriding the centrally-derived per-platform log path (set by juggler-app per spawned server)")
	flag.Parse()

	projectSet := false
	portSet := false
	publicSet := false
	logFileSet := false
	flag.Visit(func(f *flag.Flag) {
		if f.Name == "project" {
			projectSet = true
		}
		if f.Name == "port" {
			portSet = true
		}
		if f.Name == "public" {
			publicSet = true
		}
		if f.Name == "log-file" {
			logFileSet = true
		}
	})
	// WAN modes explicitly requested at startup, in registration order.
	var startupWAN []server.TunnelMode
	for _, f := range wanFlags {
		if *f.val {
			startupWAN = append(startupWAN, f.mode)
		}
	}
	// The server never opens a window on its own. The visible UI is the separate
	// juggler-app desktop process; this binary is the headless engine + server.
	// A bare launch (terminal or icon) runs as a server — the user opens the app
	// (or presses 'w' in a terminal session, or passes --window) to get a GUI.
	// This is what stops the server impersonating the app on a Windows
	// double-click. hasTerminal still distinguishes a shell launch from an icon
	// launch for the project default (cwd vs none); see resolveStartupProject.

	return appFlags{
		verbose:        *verbose,
		assetsFromDisk: *assetsFromDisk,
		killExisting:   *killExisting,
		window:         *window,
		project:        *project,
		projectSet:     projectSet,
		hasTerminal:    hasTerminal,
		port:           *port,
		portSet:        portSet,
		testMode:       *testMode,
		testIframes:    *testIframes,
		public:         *public,
		publicSet:      publicSet,
		startupWAN:     startupWAN,
		exitWithParent: *exitWithParent,
		logFile:        *logFile,
		logFileSet:     logFileSet,
	}, *version
}

func printBanner() {
	fmt.Printf(`
    ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
    ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄
  ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██

  AI Code Agent • %s

`, core.Version)
}
