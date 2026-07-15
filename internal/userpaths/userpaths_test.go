//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package userpaths

import (
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"

	"juggler/internal/userpaths/userpathstest"
)

// withHome isolates HOME and clears any ambient JUGGLER_CONFIG_DIR / XDG_* via
// the shared helper so the resolved paths are deterministic per test.
func withHome(t *testing.T) string {
	t.Helper()
	return userpathstest.Isolate(t)
}

// noenv is an env lookup that reports every variable as unset.
func noenv(string) string { return "" }

// env builds an env lookup from a map.
func env(pairs map[string]string) func(string) string {
	return func(k string) string { return pairs[k] }
}

func TestResolveConfigDirPerPlatform(t *testing.T) {
	const home = "/home/u"
	cases := []struct {
		name   string
		goos   string
		home   string
		getenv func(string) string
		want   string
	}{
		{"macOS", "darwin", home, noenv, filepath.Join(home, ".juggler")},
		{"windows", "windows", home, noenv, filepath.Join(home, ".juggler")},
		{"linux default (XDG config)", "linux", home, noenv,
			filepath.Join(home, ".config", "juggler")},
		{"linux honours XDG_CONFIG_HOME", "linux", home,
			env(map[string]string{"XDG_CONFIG_HOME": "/xdg/config"}),
			filepath.Join("/xdg/config", "juggler")},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := resolveConfigDir(c.goos, c.home, c.getenv); got != c.want {
				t.Errorf("resolveConfigDir(%q) = %q, want %q", c.goos, got, c.want)
			}
		})
	}
}

func TestResolveCacheDirPerPlatform(t *testing.T) {
	const home = "/home/u"
	cases := []struct {
		name   string
		goos   string
		home   string
		getenv func(string) string
		want   string
	}{
		{"macOS", "darwin", home, noenv, filepath.Join(home, ".juggler", "cache")},
		{"windows", "windows", home, noenv, filepath.Join(home, ".juggler", "cache")},
		{"linux default (XDG cache)", "linux", home, noenv,
			filepath.Join(home, ".cache", "juggler")},
		{"linux honours XDG_CACHE_HOME", "linux", home,
			env(map[string]string{"XDG_CACHE_HOME": "/xdg/cache"}),
			filepath.Join("/xdg/cache", "juggler")},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := resolveCacheDir(c.goos, c.home, c.getenv); got != c.want {
				t.Errorf("resolveCacheDir(%q) = %q, want %q", c.goos, got, c.want)
			}
		})
	}
}

// On Linux the default cache dir is a SIBLING of the config dir (separate XDG
// roots), not nested inside it as on macOS/Windows.
func TestLinuxCacheIsSiblingOfConfig(t *testing.T) {
	const home = "/home/u"
	cfg := resolveConfigDir("linux", home, noenv)
	cache := resolveCacheDir("linux", home, noenv)
	if strings.HasPrefix(cache, cfg+string(os.PathSeparator)) {
		t.Errorf("linux CacheDir %q must not be nested under ConfigDir %q", cache, cfg)
	}
}

// With no home and no env, both still yield a path (the temp-dir fallback) so
// callers always have somewhere to write, and cache stays under config.
func TestResolveFallsBackWhenHomeless(t *testing.T) {
	for _, goos := range []string{"darwin", "linux", "windows"} {
		cfg := resolveConfigDir(goos, "", noenv)
		cache := resolveCacheDir(goos, "", noenv)
		if cfg == "" || cache == "" {
			t.Fatalf("%s: homeless resolve returned empty (cfg=%q cache=%q)", goos, cfg, cache)
		}
		if !strings.HasPrefix(cache, cfg) {
			t.Errorf("%s: homeless CacheDir %q not under ConfigDir %q", goos, cache, cfg)
		}
	}
}

func TestConfigDirStable(t *testing.T) {
	withHome(t)
	if a, b := ConfigDir(), ConfigDir(); a != b {
		t.Errorf("ConfigDir() not stable: %q != %q", a, b)
	}
}

// JUGGLER_CONFIG_DIR overrides the home-derived path outright on every platform,
// and CacheDir stays nested beneath it so one override isolates cache too. This
// is how CI and tests isolate per-user state on a shared/persistent machine.
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

// An empty JUGGLER_CONFIG_DIR is ignored, falling back to the platform-derived
// path (so `export JUGGLER_CONFIG_DIR=` doesn't redirect state to a bare path).
func TestConfigDirEnvOverrideEmptyIgnored(t *testing.T) {
	home := withHome(t)
	t.Setenv("JUGGLER_CONFIG_DIR", "")
	want := resolveConfigDir(runtime.GOOS, home, os.Getenv)
	if got := ConfigDir(); got != want {
		t.Fatalf("empty override not ignored: ConfigDir() = %q, want %q", got, want)
	}
}

// ConfigDir/CacheDir resolve under the isolated HOME on the host platform.
func TestConfigAndCacheUnderHome(t *testing.T) {
	home := withHome(t)
	if cfg := ConfigDir(); !strings.HasPrefix(cfg, home) {
		t.Errorf("ConfigDir() %q not under isolated HOME %q", cfg, home)
	}
	if cache := CacheDir(); !strings.HasPrefix(cache, home) {
		t.Errorf("CacheDir() %q not under isolated HOME %q", cache, home)
	}
}

// --- Migration -----------------------------------------------------------

// seedLegacy creates a legacy ~/.juggler tree under home with a config file and
// a cache subdir file, returning the two sentinel file paths.
func seedLegacy(t *testing.T, home string) (cfgFile, cacheFile string) {
	t.Helper()
	legacy := filepath.Join(home, ".juggler")
	if err := os.MkdirAll(filepath.Join(legacy, "cache"), 0o755); err != nil {
		t.Fatal(err)
	}
	cfgFile = filepath.Join(legacy, "credentials.json")
	if err := os.WriteFile(cfgFile, []byte(`{"k":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	cacheFile = filepath.Join(legacy, "cache", "recents.json")
	if err := os.WriteFile(cacheFile, []byte(`[]`), 0o600); err != nil {
		t.Fatal(err)
	}
	return cfgFile, cacheFile
}

func TestMigrateLinuxMovesLegacyTree(t *testing.T) {
	home := t.TempDir()
	seedLegacy(t, home)

	migrate("linux", home, noenv, nil)

	// Config content landed at ~/.config/juggler; cache lifted to ~/.cache/juggler.
	wantCfg := filepath.Join(home, ".config", "juggler", "credentials.json")
	if !isFile(wantCfg) {
		t.Errorf("config not migrated: %q missing", wantCfg)
	}
	wantCache := filepath.Join(home, ".cache", "juggler", "recents.json")
	if !isFile(wantCache) {
		t.Errorf("cache not migrated: %q missing", wantCache)
	}
	// Legacy tree is gone, and no cache/ was left behind inside the new config dir.
	if isDir(filepath.Join(home, ".juggler")) {
		t.Errorf("legacy ~/.juggler still present after migration")
	}
	if isDir(filepath.Join(home, ".config", "juggler", "cache")) {
		t.Errorf("cache/ left behind inside the new config dir")
	}
}

func TestMigrateLinuxHonoursXDGEnv(t *testing.T) {
	home := t.TempDir()
	seedLegacy(t, home)
	xdgConfig := filepath.Join(t.TempDir(), "xc")
	xdgCache := filepath.Join(t.TempDir(), "xh")
	getenv := env(map[string]string{"XDG_CONFIG_HOME": xdgConfig, "XDG_CACHE_HOME": xdgCache})

	migrate("linux", home, getenv, nil)

	if !isFile(filepath.Join(xdgConfig, "juggler", "credentials.json")) {
		t.Errorf("config not migrated into XDG_CONFIG_HOME")
	}
	if !isFile(filepath.Join(xdgCache, "juggler", "recents.json")) {
		t.Errorf("cache not migrated into XDG_CACHE_HOME")
	}
}

// On macOS/Windows the default path is unchanged, so migration is a no-op — the
// legacy tree stays exactly where it is.
func TestMigrateNoopOnDarwinWindows(t *testing.T) {
	for _, goos := range []string{"darwin", "windows"} {
		home := t.TempDir()
		seedLegacy(t, home)
		migrate(goos, home, noenv, nil)
		if !isFile(filepath.Join(home, ".juggler", "credentials.json")) {
			t.Errorf("%s: legacy tree should be untouched", goos)
		}
	}
}

// When the destination config dir already exists, migration must not clobber or
// merge into it — the legacy tree is left alone.
func TestMigrateDoesNotClobberExistingDest(t *testing.T) {
	home := t.TempDir()
	seedLegacy(t, home)
	dest := filepath.Join(home, ".config", "juggler")
	if err := os.MkdirAll(dest, 0o755); err != nil {
		t.Fatal(err)
	}
	existing := filepath.Join(dest, "credentials.json")
	if err := os.WriteFile(existing, []byte(`{"existing":true}`), 0o600); err != nil {
		t.Fatal(err)
	}

	migrate("linux", home, noenv, nil)

	// Existing dest untouched, legacy left in place (not merged).
	data, _ := os.ReadFile(existing)
	if !strings.Contains(string(data), "existing") {
		t.Errorf("existing dest config was overwritten")
	}
	if !isFile(filepath.Join(home, ".juggler", "credentials.json")) {
		t.Errorf("legacy tree should be left in place when dest exists")
	}
}

// With nothing legacy present, migration is a silent no-op (fresh install).
func TestMigrateNoopWhenNoLegacy(t *testing.T) {
	home := t.TempDir()
	migrate("linux", home, noenv, nil)
	if isDir(filepath.Join(home, ".config", "juggler")) {
		t.Errorf("migration created a config dir with no legacy tree to move")
	}
}

// Migrate() (the exported wrapper) refuses to touch anything when
// JUGGLER_CONFIG_DIR is set — the override owns state placement.
func TestMigrateSkippedWithOverride(t *testing.T) {
	home := withHome(t)
	seedLegacy(t, home)
	t.Setenv("JUGGLER_CONFIG_DIR", filepath.Join(t.TempDir(), "override"))

	Migrate(nil)

	if !isFile(filepath.Join(home, ".juggler", "credentials.json")) {
		t.Errorf("Migrate must not move the legacy tree when JUGGLER_CONFIG_DIR is set")
	}
}

// isFile reports whether path exists and is a regular file.
func isFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

// --- Tombstone -----------------------------------------------------------

// migrationRemoveAt is the version at which the one-time ~/.juggler → XDG
// migration should be deleted — by then virtually every user has launched a
// migrating build, so the code is dead weight. Bump only if you deliberately
// extend the migration window.
const migrationRemoveAt = "0.6.0"

// TestMigrationTombstone is a forcing function so the migration can't ossify in
// the tree forever: it fails once the shipped VERSION reaches migrationRemoveAt.
// When it goes red, delete userpaths.Migrate + migrate, the migration tests
// above, and the two startup call sites — grep MIGRATION(xdg) to find them all.
func TestMigrationTombstone(t *testing.T) {
	v := repoVersion(t)
	if semverGTE(v, migrationRemoveAt) {
		t.Fatalf("VERSION %s ≥ %s: remove the one-time ~/.juggler → XDG migration "+
			"(grep MIGRATION(xdg): userpaths.Migrate/migrate + its two startup call sites)",
			v, migrationRemoveAt)
	}
}

// repoVersion reads and normalises the repo's VERSION file (e.g. "v0.3.8" →
// "0.3.8"), walking up from the test's working directory to find it. It reads
// the file rather than core.Version because the latter is ldflags-injected and
// is only the "dev" default under `go test`.
func repoVersion(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		if data, err := os.ReadFile(filepath.Join(dir, "VERSION")); err == nil {
			return strings.TrimPrefix(strings.TrimSpace(string(data)), "v")
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("VERSION file not found walking up from the test working directory")
		}
		dir = parent
	}
}

// semverGTE reports whether version a >= b for simple MAJOR.MINOR.PATCH strings;
// any pre-release/build suffix is ignored and a malformed component counts as 0.
func semverGTE(a, b string) bool {
	pa, pb := parseSemver(a), parseSemver(b)
	for i := range pa {
		if pa[i] != pb[i] {
			return pa[i] > pb[i]
		}
	}
	return true
}

// parseSemver splits "MAJOR.MINOR.PATCH" into its three numeric components,
// dropping any "-prerelease"/"+build" suffix first.
func parseSemver(s string) [3]int {
	if i := strings.IndexAny(s, "-+"); i >= 0 {
		s = s[:i]
	}
	var out [3]int
	for i, part := range strings.SplitN(s, ".", 3) {
		out[i], _ = strconv.Atoi(strings.TrimSpace(part))
	}
	return out
}
