//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

// fakeCLIPath is the binary the provider spawns in place of the real claude
// CLI. Every fake-CLI mode lives in this package's test files behind TestMain's
// JUGGLER_FAKE_CLAUDE trampoline, so the fake is always a test binary for this
// package — by default this process's own, re-exec'd.
var fakeCLIPath = os.Args[0]

// prepareFakeCLI points fakeCLIPath at a binary the fake CLI can be spawned as
// cheaply, and returns a cleanup for anything it built.
//
// The race detector maps its shadow memory at process start, which costs the
// better part of a second per exec on darwin/arm64. The fake CLI is spawned
// once per session across hundreds of tests and does nothing but write scripted
// JSON to a pipe — it holds no shared state for the detector to find, so that
// startup is pure latency and dominates the package's runtime. Under -race we
// therefore compile an uninstrumented copy of this package's test binary once
// and spawn that instead. The parent process stays instrumented, so every
// assertion and every provider goroutine still runs under the detector.
//
// Falls back to re-exec'ing this process whenever the compile can't happen (no
// toolchain on PATH, unwritable temp dir): slower, but no less correct.
func prepareFakeCLI() (cleanup func()) {
	noop := func() {}
	if !raceEnabled {
		return noop
	}
	dir, err := os.MkdirTemp("", "juggler-fake-cli")
	if err != nil {
		return noop
	}
	out := filepath.Join(dir, "fake-claude.test")
	if runtime.GOOS == "windows" {
		out += ".exe"
	}
	// The package path is "." because a test binary runs with the package
	// source directory as its working directory. -race=false is explicit so an
	// inherited GOFLAGS=-race can't re-instrument the very binary we are
	// building to avoid instrumentation.
	build := exec.Command("go", "test", "-c", "-race=false", "-o", out, ".")
	build.Stderr = os.Stderr
	if err := build.Run(); err != nil {
		os.RemoveAll(dir)
		return noop
	}
	fakeCLIPath = out
	return func() { os.RemoveAll(dir) }
}
