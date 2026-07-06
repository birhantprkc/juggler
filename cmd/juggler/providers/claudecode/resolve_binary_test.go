//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"os"
	"path/filepath"
	"testing"

	"juggler/internal/userpaths/userpathstest"
)

// writeExecutable creates a runnable file at dir/name and returns its path.
func writeExecutable(t *testing.T, dir, name string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatalf("write %s: %v", p, err)
	}
	return p
}

func TestClaudeBinary_EnvOverrideWins(t *testing.T) {
	// A valid JUGGLER_CLAUDE_PATH short-circuits auto-detection.
	userpathstest.Isolate(t) // empty credentials store
	t.Setenv("SHELL", "")    // keep the login-shell probe out of this test
	bin := writeExecutable(t, t.TempDir(), "claude")
	t.Setenv(claudePathEnvVar, bin)

	if got := claudeBinary(); got != bin {
		t.Fatalf("claudeBinary() = %q, want override %q", got, bin)
	}
}

func TestClaudeBinary_MissingOverrideIgnored(t *testing.T) {
	userpathstest.Isolate(t)
	t.Setenv("SHELL", "")
	t.Setenv(claudePathEnvVar, filepath.Join(t.TempDir(), "does-not-exist"))

	if got := claudeBinary(); got != "" && !filepath.IsAbs(got) {
		t.Fatalf("claudeBinary() = %q, want \"\" or an absolute fallback path", got)
	}
}

func TestLastNonEmptyLine(t *testing.T) {
	cases := []struct{ in, want string }{
		{"", ""},
		{"\n\n", ""},
		{"/usr/bin/claude", "/usr/bin/claude"},
		{"/usr/bin/claude\n", "/usr/bin/claude"},
		{"banner\nmore noise\n  /home/u/.nvm/bin/claude  \n", "/home/u/.nvm/bin/claude"},
		{"/a\n/b\n\n", "/b"},
	}
	for _, c := range cases {
		if got := lastNonEmptyLine(c.in); got != c.want {
			t.Errorf("lastNonEmptyLine(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestAugmentPathEnv(t *testing.T) {
	sep := string(os.PathListSeparator)

	t.Run("prepends dir", func(t *testing.T) {
		in := []string{"FOO=bar", "PATH=/usr/bin" + sep + "/bin"}
		out := augmentPathEnv(in, "/opt/x/bin")
		want := "PATH=/opt/x/bin" + sep + "/usr/bin" + sep + "/bin"
		if !containsLine(out, want) {
			t.Fatalf("augmentPathEnv = %v, want a line %q", out, want)
		}
		if !containsLine(out, "FOO=bar") {
			t.Fatalf("augmentPathEnv dropped unrelated var: %v", out)
		}
	})

	t.Run("no-op when already first", func(t *testing.T) {
		in := []string{"PATH=/opt/x/bin" + sep + "/usr/bin"}
		out := augmentPathEnv(in, "/opt/x/bin")
		if !containsLine(out, "PATH=/opt/x/bin"+sep+"/usr/bin") {
			t.Fatalf("augmentPathEnv reordered an already-leading dir: %v", out)
		}
	})

	t.Run("adds PATH when absent", func(t *testing.T) {
		out := augmentPathEnv([]string{"FOO=bar"}, "/opt/x/bin")
		if !containsLine(out, "PATH=/opt/x/bin") {
			t.Fatalf("augmentPathEnv = %v, want a PATH entry", out)
		}
	})

	t.Run("empty dir is a no-op", func(t *testing.T) {
		in := []string{"PATH=/usr/bin"}
		out := augmentPathEnv(in, "")
		if len(out) != 1 || out[0] != "PATH=/usr/bin" {
			t.Fatalf("augmentPathEnv with empty dir = %v, want unchanged", out)
		}
	})
}

func containsLine(env []string, want string) bool {
	for _, e := range env {
		if e == want {
			return true
		}
	}
	return false
}
