//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"os"
	"path/filepath"
	"testing"
)

// The native chooser is a sheet on the window, so what it will and will not
// accept is decided before it opens. The project picker's behaviour is the one
// that must not drift: it existed first, and a folder is the only thing it can
// be answered with.
func TestPickerOptions(t *testing.T) {
	cases := []struct {
		name      string
		action    string
		rawTitle  string
		wantFiles bool
		wantTitle string
	}{
		{"the project picker takes folders only", "pick-directory", "", false, "Open project folder"},
		{"a file chooser takes files", "pick-file", "Add a file to view", true, "Add a file to view"},
		{"and says what was asked", "pick-file", "  Add a file  ", true, "Add a file"},
		{"an untitled request keeps the old wording", "pick-file", "   ", true, "Open project folder"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			files, title, _ := pickerOptions(c.action, c.rawTitle, "")
			if files != c.wantFiles || title != c.wantTitle {
				t.Fatalf("pickerOptions(%q, %q) = %v/%q, want %v/%q",
					c.action, c.rawTitle, files, title, c.wantFiles, c.wantTitle)
			}
		})
	}
}

// Where the chooser opens. Left to the platform it opens wherever this app last
// was, which for a file in the open project is rarely the project — so a caller
// that knows says, and anything it cannot have meant is dropped rather than
// handed on to a dialog that would refuse to open.
func TestPickerOptionsStartingDirectory(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "note.txt")
	if err := os.WriteFile(file, []byte("hi"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	cases := []struct {
		name   string
		action string
		rawDir string
		want   string
	}{
		{"a project directory is where a file chooser starts", "pick-file", dir, dir},
		{"a path that is not there is dropped", "pick-file", filepath.Join(dir, "gone"), ""},
		{"a file is not a directory to start in", "pick-file", file, ""},
		{"a relative path is not one either", "pick-file", "src", ""},
		{"no directory named", "pick-file", "  ", ""},
		// The project picker is asking where a NEW project is, so the last place
		// the app looked is the better guess than the project being left.
		{"the project picker starts where the platform left it", "pick-directory", dir, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if _, _, got := pickerOptions(c.action, "", c.rawDir); got != c.want {
				t.Fatalf("pickerOptions(%q, dir=%q) directory = %q, want %q", c.action, c.rawDir, got, c.want)
			}
		})
	}
}
