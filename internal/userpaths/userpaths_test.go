//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package userpaths

import (
	"path/filepath"
	"strings"
	"testing"

	"juggler/internal/userpaths/userpathstest"
)

// withHome isolates HOME and clears any ambient JUGGLER_CONFIG_DIR via the
// shared helper so the resolved paths are deterministic per test.
func withHome(t *testing.T) string {
	t.Helper()
	return userpathstest.Isolate(t)
}

func TestConfigDirIsDotJuggler(t *testing.T) {
	home := withHome(t)
	want := filepath.Join(home, ".juggler")
	if got := ConfigDir(); got != want {
		t.Fatalf("ConfigDir() = %q, want %q", got, want)
	}
}

func TestConfigDirStable(t *testing.T) {
	withHome(t)
	if a, b := ConfigDir(), ConfigDir(); a != b {
		t.Errorf("ConfigDir() not stable: %q != %q", a, b)
	}
}

// JUGGLER_CONFIG_DIR overrides the home-derived path outright, and CacheDir
// continues to hang off whatever ConfigDir resolves to. This is how CI and
// tests isolate per-user state on a shared/persistent machine.
func TestConfigDirEnvOverride(t *testing.T) {
	withHome(t)
	override := filepath.Join(t.TempDir(), "isolated-config")
	t.Setenv("JUGGLER_CONFIG_DIR", override)
	if got := ConfigDir(); got != override {
		t.Fatalf("ConfigDir() = %q, want override %q", got, override)
	}
	if got, want := CacheDir(), filepath.Join(override, "cache"); got != want {
		t.Errorf("CacheDir() = %q, want %q", got, want)
	}
}

// An empty JUGGLER_CONFIG_DIR is ignored, falling back to the home-derived path
// (so `export JUGGLER_CONFIG_DIR=` doesn't redirect state to a bare path).
func TestConfigDirEnvOverrideEmptyIgnored(t *testing.T) {
	home := withHome(t)
	t.Setenv("JUGGLER_CONFIG_DIR", "")
	if got, want := ConfigDir(), filepath.Join(home, ".juggler"); got != want {
		t.Fatalf("empty override not ignored: ConfigDir() = %q, want %q", got, want)
	}
}

func TestCacheDirUnderConfigDir(t *testing.T) {
	withHome(t)
	cache := CacheDir()
	if filepath.Dir(cache) != ConfigDir() {
		t.Errorf("CacheDir() %q not directly under ConfigDir() %q", cache, ConfigDir())
	}
	if filepath.Base(cache) != "cache" {
		t.Errorf("CacheDir() base = %q, want cache", filepath.Base(cache))
	}
	if cache == ConfigDir() {
		t.Errorf("CacheDir() must not equal ConfigDir()")
	}
}

// With no home resolvable, both still yield a path under the temp dir so callers
// always have somewhere to write.
func TestFallBackWhenHomeless(t *testing.T) {
	// Clearing HOME/USERPROFILE forces os.UserHomeDir to error on supported OSes.
	t.Setenv("HOME", "")
	t.Setenv("USERPROFILE", "")
	cfg := ConfigDir()
	if cfg == "" {
		t.Fatal("ConfigDir() returned empty with no home")
	}
	if !strings.HasPrefix(CacheDir(), cfg) {
		t.Errorf("CacheDir() %q not under ConfigDir() %q in fallback", CacheDir(), cfg)
	}
}
