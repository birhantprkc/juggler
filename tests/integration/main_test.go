//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration_test

import (
	"bufio"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"juggler/cmd/juggler/server"
)

// testServerEntry is one isolated Wails subprocess+fixture pair in the pool.
type testServerEntry struct {
	addr    string
	fixture string
	cmd     *exec.Cmd
}

// testServerPool is a buffered channel acting as both a pool and a semaphore.
// Each browser test acquires an entry, runs with full isolation, then returns it.
var testServerPool chan testServerEntry

// testLogDir is a throwaway directory the pool points every subprocess's logs
// at (via JUGGLER_LOG_DIR), so a test run never writes browser-test-*.log into
// the user's real application-log directory. Created in TestMain, removed on
// pool shutdown. Empty when unset (e.g. the -short path).
var testLogDir string

// poolConfig controls the test-pool topology.
//
//   - JUGGLER_TEST_WINDOWS=N: number of Wails-window subprocesses (default 1).
//     Each subprocess is fully isolated — its own SessionManager, engine,
//     WebSocket server. Cranking this up gives perfect isolation but burns
//     more memory and WebKit helper startup time.
//
//   - JUGGLER_TEST_IFRAMES=N: number of test-runner iframes per subprocess
//     (default 9 → 3×3 grid). Each iframe is its own JS realm with its own
//     WebSocket connection, but they share the subprocess's SessionManager,
//     engine, and server actors. Iframes stress-test the server-side
//     concurrency that windows-only topologies hide.
//
// Total parallel-test slots = WINDOWS × IFRAMES. The defaults give 9 slots
// (1 window × 9 iframes) which mirrors the production "many tabs, one
// server" topology and surfaces races that a windows-only setup misses.
// Around 8–9 lanes was chosen after benchmarking the full suite at 4/8/16
// lanes (8 runs each): ~57s avg at 4, ~39s at 8, ~39s at 16 — that many lanes
// saturate the single engine for a ~30% speedup, and 16 buys nothing more.
type poolConfig struct {
	windows int
	iframes int
}

func loadPoolConfig() poolConfig {
	cfg := poolConfig{windows: 1, iframes: 9}
	if v := os.Getenv("JUGGLER_TEST_WINDOWS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			cfg.windows = n
		}
	}
	if v := os.Getenv("JUGGLER_TEST_IFRAMES"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			cfg.iframes = n
		}
	}
	return cfg
}

func (c poolConfig) totalSlots() int { return c.windows * c.iframes }

// serverBinary is the built server binary under <root>/bin, using the platform
// executable name — "juggler" on Unix, "juggler.exe" on Windows. Both halves of
// the contract need this: `go build -o` writes the output name verbatim (it does
// NOT append .exe on a Windows target), and Windows exec.LookPath refuses to run
// an extension-less file. So the three spawn sites here and the CI build step
// must all agree on this name, or the suite fails at spawn with "executable file
// not found" on Windows (which -short used to hide).
func serverBinary(root string) string {
	name := "juggler"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	return filepath.Join(root, "bin", name)
}

// TestMain spins up the test-pool topology controlled by poolConfig and
// tears everything down after m.Run() returns.
func TestMain(m *testing.M) {
	flag.Parse()

	if testing.Short() {
		os.Exit(m.Run())
	}

	jugglerRoot, err := server.FindProjectRoot(".")
	if err != nil {
		fmt.Fprintf(os.Stderr, "cannot find project root: %v\n", err)
		os.Exit(1)
	}

	binary := serverBinary(jugglerRoot)
	srcFixture := filepath.Join(jugglerRoot, "tests", "benchmarks", "fixtures", "unit-test-fixture")

	log.SetOutput(io.Discard)

	cfg := loadPoolConfig()

	// Redirect every subprocess's logs into a throwaway dir so the run never
	// litters the user's real ~/Library/Logs/Juggler with browser-test-*.log.
	// Removed in poolHandle.shutdown alongside the fixtures.
	if dir, err := os.MkdirTemp("", "juggler-test-logs-*"); err == nil {
		testLogDir = dir
	} else {
		fmt.Fprintf(os.Stderr, "cannot create test log dir: %v\n", err)
		os.Exit(1)
	}

	testServerPool = make(chan testServerEntry, cfg.totalSlots())
	startedPool := &poolHandle{}

	// Trap SIGINT/SIGTERM so a Ctrl-C or test-killing signal still reaps the
	// pool. The other escape hatch — Go's `panic: test timed out` from the
	// testing alarm — runs in a goroutine and crashes the process without
	// running deferreds; the subprocess-side parent-watchdog catches that.
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigCh
		startedPool.shutdown()
		os.Exit(130)
	}()

	// Start cfg.windows subprocesses; each hosts cfg.iframes iframe lanes.
	// All iframes inside a subprocess share its SessionManager+engine+WS,
	// so each slot token in testServerPool needs both the subprocess addr
	// and a *per-test* scratch fixture dir (allocated freshly inside
	// runOneBrowserTest, not here — these tokens carry only the addr).
	for w := 0; w < cfg.windows; w++ {
		fixtureDir, err := os.MkdirTemp("", "browser-test-*")
		if err != nil {
			fmt.Fprintf(os.Stderr, "cannot create fixture dir: %v\n", err)
			startedPool.shutdown()
			os.Exit(1)
		}

		if err := copyDir(srcFixture, fixtureDir); err != nil {
			fmt.Fprintf(os.Stderr, "cannot copy fixture: %v\n", err)
			os.RemoveAll(fixtureDir)
			startedPool.shutdown()
			os.Exit(1)
		}

		entry, err := startJugglerSubprocess(binary, fixtureDir, cfg.iframes)
		if err != nil {
			fmt.Fprintf(os.Stderr, "cannot start juggler subprocess: %v\n", err)
			os.RemoveAll(fixtureDir)
			startedPool.shutdown()
			os.Exit(1)
		}

		startedPool.add(entry)
		// One slot token per iframe lane: tests acquire a token to enter
		// the semaphore (capped at totalSlots concurrent in-flight tests).
		for i := 0; i < cfg.iframes; i++ {
			testServerPool <- entry
		}
	}

	code := m.Run()

	startedPool.shutdown()
	os.Exit(code)
}

// poolHandle owns the started subprocesses so they can be reaped exactly
// once, whether the run exits cleanly, via signal, or via Go's testing
// alarm panic. add() is called from a single goroutine before m.Run()
// starts; shutdown() is idempotent via sync.Once.
type poolHandle struct {
	entries []testServerEntry
	once    sync.Once
}

func (p *poolHandle) add(e testServerEntry) {
	p.entries = append(p.entries, e)
}

func (p *poolHandle) shutdown() {
	p.once.Do(func() {
		cleanupPool(p.entries)
		for _, e := range p.entries {
			os.RemoveAll(e.fixture)
		}
		if testLogDir != "" {
			os.RemoveAll(testLogDir)
		}
	})
}

// startJugglerSubprocess starts a slot subprocess and returns the entry once
// JUGGLER_ADDR= is printed to stdout. If iframes>1, the subprocess opens its
// viewer window at /test-pool?n=iframes (one Wails window hosting N test
// lanes); otherwise it opens the production app which self-redirects to
// /headless-test. Set JUGGLER_TEST_SHOW_WINDOW=1 to make the window visible.
func startJugglerSubprocess(binary, fixture string, iframes int) (testServerEntry, error) {
	args := []string{"--test", "--assets-from-disk", "--port", "0", "--project", fixture}
	if iframes > 1 {
		args = append(args, "--test-iframes", strconv.Itoa(iframes))
	}
	if os.Getenv("JUGGLER_TEST_SHOW_WINDOW") == "1" {
		args = append(args, "--window")
	}
	cmd := exec.Command(binary, args...)
	// Opt-in coalescing stress: set JUGGLER_TEST_SYNC_THROTTLE_MS to a larger
	// value to widen the outbound-sync window so a fast turn's busy→idle
	// transition always merges into one broadcast — useful for hunting waits
	// that depend on observing a transient state edge instead of a durable
	// fence (Conversation.completedTurns). NOT forced on by default: a global
	// throttle bump also slows every cross-conversation sync, which makes
	// load-sensitive multi-conv tests exceed their budget. The env is inherited
	// by the child (resolveSyncThrottle reads it in cmd/juggler/worker); the
	// default (10ms) is the production value. Run e.g.
	// `JUGGLER_TEST_SYNC_THROTTLE_MS=40 make test` for a targeted stress pass.
	cmd.Env = os.Environ()
	// Always enable the per-worker event tape in the pool. It's a fixed-size
	// ring buffer per conversation worker, so the cost is negligible, and it
	// is the only way a browser-test failure block can include the WORKER
	// TAPE section (the /api/test/dump-tape endpoint returns nothing when
	// tracing is off).
	cmd.Env = append(cmd.Env, "JUGGLER_TRACE=1")
	// Redirect this server's logs into the pool's throwaway dir (see testLogDir)
	// so the run never writes into the user's real application-log directory.
	if testLogDir != "" {
		cmd.Env = append(cmd.Env, "JUGGLER_LOG_DIR="+testLogDir)
	}
	// Put the child in its own process group so we can kill the whole group
	// (parent + any grandchildren) on cleanup. Without this, signals to the
	// test process don't reach Wails-spawned WebKit helpers, and they survive
	// as orphans when the test panics on Go's 15-minute alarm.
	setProcGroupAttr(cmd)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return testServerEntry{}, fmt.Errorf("stdout pipe: %w", err)
	}
	// Pipe stderr to a per-subprocess log in /tmp/juggler-test-logs/ so we can
	// post-mortem batch hangs after the fact. Set JUGGLER_TEST_DISCARD_STDERR=1
	// to skip.
	if os.Getenv("JUGGLER_TEST_DISCARD_STDERR") == "1" {
		cmd.Stderr = io.Discard
	} else {
		logDir := filepath.Join(os.TempDir(), "juggler-test-logs")
		if err := os.MkdirAll(logDir, 0o755); err != nil {
			return testServerEntry{}, fmt.Errorf("create log dir: %w", err)
		}
		stderrPath := filepath.Join(logDir, "juggler-stderr-"+filepath.Base(fixture)+".log")
		stderrFile, err := os.Create(stderrPath)
		if err != nil {
			return testServerEntry{}, fmt.Errorf("stderr file: %w", err)
		}
		cmd.Stderr = stderrFile
	}

	if err := cmd.Start(); err != nil {
		return testServerEntry{}, fmt.Errorf("start: %w", err)
	}

	addrCh := make(chan string, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			line := scanner.Text()
			if after, ok := strings.CutPrefix(line, "JUGGLER_ADDR="); ok {
				addrCh <- after
			}
		}
	}()

	select {
	case addr := <-addrCh:
		return testServerEntry{addr: addr, fixture: fixture, cmd: cmd}, nil
	case <-time.After(60 * time.Second):
		signalGroup(cmd, syscall.SIGKILL)
		cmd.Wait() //nolint:errcheck
		return testServerEntry{}, fmt.Errorf("timeout waiting for JUGGLER_ADDR from %s", binary)
	}
}

// cleanupPool gracefully terminates all subprocess entries in the slice.
// Signals the entire process group (children too — Wails spawns WebKit
// helpers) so nothing survives as an orphan.
func cleanupPool(entries []testServerEntry) {
	for _, e := range entries {
		signalGroup(e.cmd, syscall.SIGTERM)
	}
	done := make(chan struct{})
	go func() {
		for _, e := range entries {
			if e.cmd != nil {
				e.cmd.Wait() //nolint:errcheck
			}
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		for _, e := range entries {
			signalGroup(e.cmd, syscall.SIGKILL)
		}
	}
}
