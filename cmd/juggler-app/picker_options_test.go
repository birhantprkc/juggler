//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import "testing"

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
		{"a file chooser takes files", "pick-file", "Pin a File", true, "Pin a File"},
		{"and says what was asked", "pick-file", "  Add a file  ", true, "Add a file"},
		{"an untitled request keeps the old wording", "pick-file", "   ", true, "Open project folder"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			files, title := pickerOptions(c.action, c.rawTitle)
			if files != c.wantFiles || title != c.wantTitle {
				t.Fatalf("pickerOptions(%q, %q) = %v/%q, want %v/%q",
					c.action, c.rawTitle, files, title, c.wantFiles, c.wantTitle)
			}
		})
	}
}
