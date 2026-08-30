//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"net/url"
	"strings"
	"testing"
)

const testCtl = "http://127.0.0.1:5000/win/w1"

// query returns the page URL's parameters, so a case asserts what the page will
// read rather than how the string was spelled.
func query(t *testing.T, opts windowOpts) url.Values {
	t.Helper()
	u, err := url.Parse(windowPageURL("http://127.0.0.1:8080/", testCtl, opts))
	if err != nil {
		t.Fatalf("window page URL does not parse: %v", err)
	}
	return u.Query()
}

// An ordinary window carries nothing about a board, so the app's URL is exactly
// what it was before detaching existed.
func TestWindowPageURLLeavesAnOrdinaryWindowAlone(t *testing.T) {
	got := windowPageURL("http://127.0.0.1:8080/", testCtl, windowOpts{theme: "dark", mode: "system", zoom: 110})
	want := "http://127.0.0.1:8080/?window=1&nativeCtl=" + url.QueryEscape(testCtl) +
		"&theme=dark&mode=system&zoom=110"
	if got != want {
		t.Fatalf("ordinary window URL changed:\n got %s\nwant %s", got, want)
	}
	if strings.Contains(got, "view=") {
		t.Fatal("a window that is not a board must not claim to be one")
	}
}

// A hint nobody supplied is not sent at all: the page has its own precedence,
// and a first-ever launch with nothing to inherit must be allowed to use it.
func TestWindowPageURLOmitsWhatItWasNotGiven(t *testing.T) {
	q := query(t, windowOpts{})
	for _, key := range []string{"theme", "mode", "zoom", "view", "owner", "pin", "conversation"} {
		if q.Has(key) {
			t.Errorf("%s was sent with no value to send", key)
		}
	}
	if q.Get("window") != "1" {
		t.Error("every window is a window")
	}
}

// The board's four parameters are what the detached shell reads (see
// web/js/utils/view-mode.js), so they have to arrive under those names. The
// conversation is the one that decides what the window shows: without it the
// board comes up as a view of nothing.
func TestWindowPageURLCarriesTheBoard(t *testing.T) {
	q := query(t, windowOpts{view: viewPinboard, owner: "v_abc", pin: "pin_42", conversation: "conv_9", theme: "light"})
	if q.Get("view") != "pinboard" {
		t.Errorf("view = %q", q.Get("view"))
	}
	if q.Get("owner") != "v_abc" {
		t.Errorf("owner = %q", q.Get("owner"))
	}
	if q.Get("pin") != "pin_42" {
		t.Errorf("pin = %q", q.Get("pin"))
	}
	if q.Get("conversation") != "conv_9" {
		t.Errorf("conversation = %q", q.Get("conversation"))
	}
	if q.Get("theme") != "light" {
		t.Error("a board inherits its opener's first-frame colour like any other window")
	}
}

// A board opened on no particular pin is a board on whichever tab comes first,
// which is a different thing from a board on a pin named "".
func TestWindowPageURLOmitsAnUnnamedPin(t *testing.T) {
	q := query(t, windowOpts{view: viewPinboard, owner: "v_abc"})
	if q.Has("pin") {
		t.Error("an unnamed pin must not be sent as an empty one")
	}
}

// The control endpoint is loopback, which any process on this machine can reach.
// Everything it is told is therefore validated before it is baked into a child
// window's URL.
func TestWindowOptsFromQueryRefusesWhatIsNotAnID(t *testing.T) {
	cases := []struct {
		name  string
		owner string
		pin   string
		conv  string
		wantO string
		wantP string
		wantC string
	}{
		{"the ids Juggler mints", "v_0123456789abcdef", "pin_a-b_c", "conv_5rugm67jf", "v_0123456789abcdef", "pin_a-b_c", "conv_5rugm67jf"},
		{"a space is not an id", "v abc", "pin 1", "conv 1", "", "", ""},
		{"nor is a path", "../etc", "..%2Fetc", "../etc", "", "", ""},
		{"nor a query of its own", "v_a&b=c", "p?x", "c?x", "", "", ""},
		{"nor an empty one", "", "", "", "", "", ""},
		{"nor one past the server's limit", strings.Repeat("v", 65), strings.Repeat("p", 65), strings.Repeat("c", 65), "", "", ""},
		{"and one at the limit is fine", strings.Repeat("v", 64), strings.Repeat("p", 64), strings.Repeat("c", 64), strings.Repeat("v", 64), strings.Repeat("p", 64), strings.Repeat("c", 64)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			opts := windowOptsFromQuery(url.Values{
				"view":         {"pinboard"},
				"owner":        {tc.owner},
				"pin":          {tc.pin},
				"conversation": {tc.conv},
			})
			if opts.owner != tc.wantO {
				t.Errorf("owner = %q, want %q", opts.owner, tc.wantO)
			}
			if opts.pin != tc.wantP {
				t.Errorf("pin = %q, want %q", opts.pin, tc.wantP)
			}
			if opts.conversation != tc.wantC {
				t.Errorf("conversation = %q, want %q", opts.conversation, tc.wantC)
			}
		})
	}
}

// A view this build does not have is the ordinary app, not a window showing
// nothing.
func TestWindowOptsFromQueryIgnoresAnUnknownView(t *testing.T) {
	opts := windowOptsFromQuery(url.Values{"view": {"something-else"}, "owner": {"v_abc"}})
	if opts.isPinboard() {
		t.Error("only the view this build knows makes a board")
	}
	if opts.owner != "" {
		t.Error("a window that is not a board follows nobody")
	}
	if opts.role() != roleMain {
		t.Errorf("role = %q, want %q", opts.role(), roleMain)
	}
}

// The role is what keeps two kinds of window out of each other's saved frame,
// and what keeps a board out of the restored workspace file.
func TestWindowOptsRole(t *testing.T) {
	if (windowOpts{}).role() != roleMain {
		t.Error("a window with no view is the app")
	}
	if (windowOpts{view: viewPinboard}).role() != rolePinboard {
		t.Error("a detached board has a slot of its own")
	}
}

// Two boards are two windows the user placed somewhere on purpose. One shared
// slot had the second one opened land on top of the first, and the last one
// closed decide where every board opened next time.
func TestWindowOptsRoleIsPerBoard(t *testing.T) {
	one := (windowOpts{view: viewPinboard, board: "board_one"}).role()
	two := (windowOpts{view: viewPinboard, board: "board_two"}).role()
	if one == two {
		t.Fatalf("each board needs its own frame, both got %q", one)
	}
	if one != rolePinboardFor("board_one") {
		t.Errorf("role = %q, want %q", one, rolePinboardFor("board_one"))
	}
	// Everything that asks about a board asks about boards in general.
	for _, role := range []string{one, two, rolePinboard} {
		if !isBoardRole(role) {
			t.Errorf("%q must read as a board", role)
		}
	}
	if isBoardRole(roleMain) {
		t.Error("the app is not a board")
	}
}

// The board rides in the URL like every other part of a window's address, and
// is held to the same alphabet: it comes back as a query parameter on every
// request that window makes about its own composition.
func TestWindowOptsCarriesTheBoard(t *testing.T) {
	opts := windowOptsFromQuery(url.Values{
		"view":  {"pinboard"},
		"board": {"board_one"},
	})
	if opts.board != "board_one" {
		t.Fatalf("board = %q, want %q", opts.board, "board_one")
	}
	if bad := windowOptsFromQuery(url.Values{"view": {"pinboard"}, "board": {"../etc"}}); bad.board != "" {
		t.Errorf("a board id that is not one yields nothing, got %q", bad.board)
	}

	u := windowPageURL("http://127.0.0.1:1234", "http://127.0.0.1:9999", opts)
	if !strings.Contains(u, "board=board_one") {
		t.Errorf("the page has to be told which board it is, got %q", u)
	}
	// A page cannot name a window other than its own, so the opener is filled in
	// by the endpoint that knows which window asked — never read from the query.
	if from := windowOptsFromQuery(url.Values{"view": {"pinboard"}, "openedBy": {"win_9"}}); from.openedBy != "" {
		t.Errorf("openedBy must not come off the wire, got %q", from.openedBy)
	}
}

// The theme/mode/zoom hand-off is read exactly as it was before the struct
// existed, so an opener that has always sent them keeps working.
func TestWindowOptsFromQueryReadsTheInheritedTrio(t *testing.T) {
	opts := windowOptsFromQuery(url.Values{"theme": {"dark"}, "mode": {"system"}, "zoom": {"125"}})
	if opts.theme != "dark" || opts.mode != "system" || opts.zoom != 125 {
		t.Fatalf("inherited trio = %q/%q/%d", opts.theme, opts.mode, opts.zoom)
	}
	if bad := windowOptsFromQuery(url.Values{"zoom": {"not a number"}}); bad.zoom != 0 {
		t.Errorf("an unreadable zoom is no zoom, got %d", bad.zoom)
	}
}
