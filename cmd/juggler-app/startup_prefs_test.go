//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"strings"
	"testing"

	"juggler/cmd/juggler/core"
)

// A window opens wearing what it was last left in. These pin the order the three
// sources are consulted in, because getting it wrong is invisible until a
// relaunch: the window comes up in someone else's theme and only corrects itself
// a frame later, if at all.

func TestStartupPrefsPreferTheWindowsOwn(t *testing.T) {
	saved := core.WindowState{Theme: "light", Zoom: 130}
	opts := windowOpts{theme: "dark", mode: "dark", zoom: 110}

	theme, mode, zoom := startupPrefs(opts, saved, true, "dark", 100)
	if theme != "light" || mode != "light" {
		t.Fatalf("the opener's theme overrode the window's own: got %q/%q, want \"light\"/\"light\"", theme, mode)
	}
	if zoom != 130 {
		t.Fatalf("zoom: got %d, want 130", zoom)
	}
}

func TestStartupPrefsInheritWhenTheWindowHasNothing(t *testing.T) {
	// Never opened before: the opener's hand-off is what it starts with.
	theme, mode, zoom := startupPrefs(windowOpts{theme: "light", mode: "system", zoom: 120}, core.WindowState{}, false, "dark", 100)
	if theme != "light" || mode != "system" || zoom != 120 {
		t.Fatalf("inherited hand-off = %q/%q/%d, want \"light\"/\"system\"/120", theme, mode, zoom)
	}

	// A slot with only geometry in it says nothing about appearance either.
	theme, _, zoom = startupPrefs(windowOpts{}, core.WindowState{X: 10, Y: 10, Width: 800, Height: 600, HasPos: true}, true, "dark", 100)
	if theme != "dark" || zoom != 100 {
		t.Fatalf("a frame-only slot should leave the inheritance alone: got %q/%d", theme, zoom)
	}
}

// 'system' is a mode, not a colour. It has to reach the page as the selection it
// is, while the bare frame keeps painting the inherited colour until the page
// resolves the OS preference on its first frame.
func TestStartupPrefsSavedSystemNamesNoColour(t *testing.T) {
	theme, mode, _ := startupPrefs(windowOpts{}, core.WindowState{Theme: "system"}, true, "dark", 0)
	if mode != "system" {
		t.Fatalf("mode = %q, want \"system\"", mode)
	}
	if theme != "dark" {
		t.Fatalf("the pre-paint fill should stay the inherited colour: got %q, want \"dark\"", theme)
	}
}

// A first-ever launch says nothing, so the page is free to follow the OS and
// open at the default size.
func TestStartupPrefsSayNothingWhenNothingIsKnown(t *testing.T) {
	theme, mode, zoom := startupPrefs(windowOpts{}, core.WindowState{}, false, "", 0)
	if theme != "" || mode != "" || zoom != 0 {
		t.Fatalf("a launch with nothing to go on = %q/%q/%d, want empty", theme, mode, zoom)
	}
}

// Two boards are two windows, so their saved appearances travel in two different
// URLs — this is the whole point of storing them per role.
func TestTwoBoardsOpenWearingTheirOwnThemes(t *testing.T) {
	one, _, _ := startupPrefs(windowOpts{view: viewPinboard, board: "board_one"},
		core.WindowState{Theme: "light"}, true, "dark", 0)
	two, twoMode, _ := startupPrefs(windowOpts{view: viewPinboard, board: "board_two"},
		core.WindowState{Theme: "dark"}, true, "dark", 0)
	if one == two {
		t.Fatalf("both boards resolved to %q", one)
	}

	optsTwo := windowOpts{view: viewPinboard, board: "board_two", theme: two, mode: twoMode}
	u := windowPageURL("http://127.0.0.1:8080/", testCtl, optsTwo)
	if !strings.Contains(u, "theme=dark") || !strings.Contains(u, "board=board_two") {
		t.Fatalf("the board's own theme has to reach its page: %s", u)
	}
}

// The app names a window's role from the options it opened it with; the server
// names the same window from the URL it is serving (core.WindowRoleForView, used
// by serveIndex to inject that window's theme). Disagree and a board writes its
// theme into one slot and reads it back from another.
func TestRolesAgreeWithTheServers(t *testing.T) {
	cases := []windowOpts{
		{},
		{view: viewPinboard, board: "board_one"},
		{view: viewPinboard, board: core.MainBoardID},
		{view: viewPinboard},
		{view: "something-else", board: "board_one"},
	}
	for _, opts := range cases {
		// windowOptsFromQuery is what a real window's options come through, so the
		// board id is already normalised by the time role() sees it.
		got := opts.role()
		want := core.WindowRoleForView(opts.view, opts.board)
		if got != want {
			t.Errorf("view=%q board=%q: app says %q, server says %q", opts.view, opts.board, got, want)
		}
	}
}
