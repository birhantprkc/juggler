//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestIsUnsuitableProjectRoot(t *testing.T) {
	// A fake home under a temp dir so the home-relative checks are exercised
	// without depending on the test machine's real home layout.
	home := filepath.Join(t.TempDir(), "alice")
	mustMkdir(t, home)

	// A real, sensible project dir nested under home.
	project := filepath.Join(home, "code", "myproject")
	mustMkdir(t, project)

	// A generic subdir for the current OS (Documents exists on every platform's
	// list) plus an OS-specific one.
	docs := filepath.Join(home, "Documents")
	mustMkdir(t, docs)

	cases := []struct {
		name string
		dir  string
		want bool
	}{
		{"empty", "", false},
		{"home itself", home, true},
		{"parent of home", filepath.Dir(home), true},
		{"generic Documents", docs, true},
		{"real nested project", project, false},
		{"home with trailing slash", home + string(os.PathSeparator), true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsUnsuitableProjectRoot(tc.dir, home); got != tc.want {
				t.Errorf("IsUnsuitableProjectRoot(%q, home) = %v, want %v", tc.dir, got, tc.want)
			}
		})
	}
}

func TestIsUnsuitableProjectRootFilesystemRoot(t *testing.T) {
	var root string
	if runtime.GOOS == "windows" {
		root = filepath.VolumeName(os.Getenv("SystemDrive")) + `\`
		if root == `\` {
			root = `C:\`
		}
	} else {
		root = "/"
	}
	if !IsUnsuitableProjectRoot(root, "") {
		t.Errorf("filesystem root %q should be unsuitable", root)
	}
}

func TestIsUnsuitableProjectRootSystemDir(t *testing.T) {
	// Pick a system root that actually exists on this machine and assert it is
	// rejected even when home is unknown.
	for _, r := range systemRoots() {
		if _, err := os.Stat(r); err == nil {
			if !IsUnsuitableProjectRoot(r, "") {
				t.Errorf("system root %q should be unsuitable", r)
			}
			return
		}
	}
	t.Skip("no system root present to test on this machine")
}

func mustMkdir(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", dir, err)
	}
}
