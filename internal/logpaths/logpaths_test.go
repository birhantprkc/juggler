//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package logpaths

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// withHome points HOME (and USERPROFILE for Windows parity) at a temp dir so
// the resolved log paths are deterministic and isolated per test.
func withHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	return home
}

func TestResolveLogDirPerPlatform(t *testing.T) {
	const home = "/home/u"
	noenv := func(string) string { return "" }
	env := func(pairs map[string]string) func(string) string {
		return func(k string) string { return pairs[k] }
	}
	cases := []struct {
		name   string
		goos   string
		home   string
		getenv func(string) string
		want   string
	}{
		{"macOS", "darwin", home, noenv,
			filepath.Join(home, "Library", "Logs", "Juggler")},
		{"linux default (XDG state)", "linux", home, noenv,
			filepath.Join(home, ".local", "state", "juggler", "logs")},
		{"linux honours XDG_STATE_HOME", "linux", home,
			env(map[string]string{"XDG_STATE_HOME": "/xdg/state"}),
			filepath.Join("/xdg/state", "juggler", "logs")},
		{"windows LOCALAPPDATA", "windows", home,
			env(map[string]string{"LOCALAPPDATA": `C:\Users\u\AppData\Local`}),
			filepath.Join(`C:\Users\u\AppData\Local`, "Juggler", "Logs")},
		{"windows without LOCALAPPDATA", "windows", home, noenv,
			filepath.Join(home, "AppData", "Local", "Juggler", "Logs")},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := resolveLogDir(c.goos, c.home, c.getenv); got != c.want {
				t.Errorf("resolveLogDir(%q) = %q, want %q", c.goos, got, c.want)
			}
		})
	}
}

// JUGGLER_LOG_DIR overrides every platform default and home/env fallback. The
// integration harness relies on this to point test subprocesses at a throwaway
// dir so runs never litter the user's real application-log directory.
func TestResolveLogDirHonorsOverride(t *testing.T) {
	const override = "/tmp/juggler-test-logs"
	env := func(string) string { return override }
	for _, goos := range []string{"darwin", "linux", "windows"} {
		if got := resolveLogDir(goos, "/home/u", env); got != override {
			t.Errorf("resolveLogDir(%q) with JUGGLER_LOG_DIR = %q, want override %q", goos, got, override)
		}
	}
	// Empty override is ignored — the platform default still applies.
	noenv := func(string) string { return "" }
	if got := resolveLogDir("darwin", "/home/u", noenv); got == override {
		t.Errorf("empty JUGGLER_LOG_DIR should not override; got %q", got)
	}
}

// With no home and no env, every platform must still yield a path (the temp-dir
// fallback) so logging never has nowhere to go.
func TestResolveLogDirFallsBackWhenHomeless(t *testing.T) {
	noenv := func(string) string { return "" }
	want := filepath.Join(os.TempDir(), "juggler-logs")
	for _, goos := range []string{"darwin", "linux", "windows"} {
		if got := resolveLogDir(goos, "", noenv); got != want {
			t.Errorf("resolveLogDir(%q, homeless) = %q, want temp fallback %q", goos, got, want)
		}
	}
}

// Logs must NOT live under ~/.juggler — that folder should be copyable (config,
// credentials, sessions) without dragging logs along.
func TestLogDirIsNotUnderDotJuggler(t *testing.T) {
	withHome(t)
	dir := LogDir()
	if strings.Contains(filepath.ToSlash(dir), "/.juggler/") {
		t.Errorf("LogDir() = %q must not live under ~/.juggler", dir)
	}
	if !filepath.IsAbs(dir) {
		t.Errorf("LogDir() = %q should be absolute", dir)
	}
}

func TestAppLogPath(t *testing.T) {
	withHome(t)
	got := AppLogPath()
	if filepath.Dir(got) != LogDir() {
		t.Errorf("AppLogPath() %q not under LogDir() %q", got, LogDir())
	}
	if filepath.Base(got) != "app.log" {
		t.Errorf("AppLogPath() base = %q, want app.log", filepath.Base(got))
	}
}

func TestServerLogPathNoProjectIsHostFolder(t *testing.T) {
	withHome(t)
	got := ServerLogPath("")
	wantDir := filepath.Join(LogDir(), "host")
	if filepath.Dir(got) != wantDir {
		t.Errorf("ServerLogPath(\"\") %q not in host folder %q", got, wantDir)
	}
	if filepath.Base(got) != "server.log" {
		t.Errorf("ServerLogPath(\"\") base = %q, want server.log", filepath.Base(got))
	}
}

func TestProjectLogDirAndConversationLogPath(t *testing.T) {
	withHome(t)
	const proj = "/Users/jules/code/myproj"
	dir := ProjectLogDir(proj)
	if filepath.Dir(dir) != LogDir() {
		t.Errorf("ProjectLogDir %q not directly under LogDir() %q", dir, LogDir())
	}
	if !strings.Contains(filepath.Base(dir), "myproj") {
		t.Errorf("ProjectLogDir base %q should contain readable basename 'myproj'", filepath.Base(dir))
	}
	// Server log and conversation logs share the project folder; conversation
	// logs sit in a conversations/ sub-folder. With no name the file is the bare
	// conv id; with a name it is prefixed, with the conv id as the stable suffix.
	conv := ConversationLogPath(proj, "conv_abc123xyz", "")
	wantConvDir := filepath.Join(dir, "conversations")
	if filepath.Dir(conv) != wantConvDir {
		t.Errorf("ConversationLogPath %q not in %q", conv, wantConvDir)
	}
	if filepath.Base(conv) != "conv_abc123xyz.log" {
		t.Errorf("ConversationLogPath base = %q, want conv_abc123xyz.log", filepath.Base(conv))
	}
	named := ConversationLogPath(proj, "conv_abc123xyz", "My Tab Name")
	if filepath.Base(named) != "My Tab Name--conv_abc123xyz.log" {
		t.Errorf("named ConversationLogPath base = %q, want \"My Tab Name--conv_abc123xyz.log\"", filepath.Base(named))
	}
	if filepath.Dir(named) != wantConvDir {
		t.Errorf("named ConversationLogPath %q not in %q", named, wantConvDir)
	}
	// The conversation log lives under the same project folder as the server log.
	if filepath.Dir(filepath.Dir(conv)) != filepath.Dir(ServerLogPath(proj)) {
		t.Errorf("conversation log %q not under the project's server-log folder", conv)
	}
}

func TestServerLogPathStable(t *testing.T) {
	withHome(t)
	p := "/Users/jules/code/myproj"
	a, b := ServerLogPath(p), ServerLogPath(p)
	if a != b {
		t.Errorf("ServerLogPath not stable: %q != %q", a, b)
	}
	// Trailing slash / un-cleaned path must resolve to the same file.
	if c := ServerLogPath(p + "/"); c != a {
		t.Errorf("ServerLogPath(%q) = %q, want %q (clean-insensitive)", p+"/", c, a)
	}
}

func TestServerLogPathBasenameCollisionResistant(t *testing.T) {
	withHome(t)
	// Two different projects that share a basename must NOT collide — their
	// per-project folders differ even though the basename matches.
	a := ServerLogPath("/home/a/myproj")
	b := ServerLogPath("/home/b/myproj")
	if a == b {
		t.Fatalf("distinct projects with same basename collided: both %q", a)
	}
	// Each server.log lives in its own folder directly under LogDir, and the
	// folder name carries the readable basename so a human can find the right
	// project in a single directory listing.
	for _, p := range []string{a, b} {
		folder := filepath.Dir(p)
		if filepath.Dir(folder) != LogDir() {
			t.Errorf("project folder %q not directly under LogDir() %q", folder, LogDir())
		}
		if filepath.Base(p) != "server.log" {
			t.Errorf("project log base %q, want server.log", filepath.Base(p))
		}
		if !strings.Contains(filepath.Base(folder), "myproj") {
			t.Errorf("project folder %q should contain readable basename 'myproj'", folder)
		}
	}
}

func TestStderrLogPathIsSiblingOfServerLog(t *testing.T) {
	withHome(t)
	for _, p := range []string{"", "/home/a/myproj"} {
		srv := ServerLogPath(p)
		errp := StderrLogPath(p)
		if filepath.Dir(srv) != filepath.Dir(errp) {
			t.Errorf("project %q: stderr %q not a sibling of server log %q", p, errp, srv)
		}
		if srv == errp {
			t.Errorf("project %q: stderr path equals server log path %q", p, srv)
		}
		if !strings.HasSuffix(errp, ".stderr.log") {
			t.Errorf("project %q: stderr path %q should end with .stderr.log", p, errp)
		}
	}
}
