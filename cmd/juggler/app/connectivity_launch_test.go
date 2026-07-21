//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package app

import (
	"testing"

	"juggler/cmd/juggler/server"
)

// TestLANOnLaunch pins the LAN-at-launch decision: an explicit --public always
// wins, only a GUI launch consults the saved preference, and a terminal launch
// stays localhost-only regardless of the saved value.
func TestLANOnLaunch(t *testing.T) {
	cases := []struct {
		name      string
		publicSet bool
		public    bool
		gui       bool
		saved     bool
		want      bool
	}{
		{"flag-on wins over saved-off", true, true, true, false, true},
		{"flag-off wins over saved-on", true, false, true, true, false},
		{"gui launch honours saved-on", false, false, true, true, true},
		{"gui launch honours saved-off", false, false, true, false, false},
		{"terminal launch ignores saved-on", false, false, false, true, false},
	}
	for _, c := range cases {
		if got := lanOnLaunch(c.publicSet, c.public, c.gui, c.saved); got != c.want {
			t.Errorf("%s: lanOnLaunch(%v,%v,%v,%v) = %v, want %v",
				c.name, c.publicSet, c.public, c.gui, c.saved, got, c.want)
		}
	}
}

// TestSavedWANModeToStart pins the saved-WAN-mode decision: it fires only on a
// GUI launch, only for a non-empty preference, and only when the mode is both
// registered and currently available; every other case is skipped.
func TestSavedWANModeToStart(t *testing.T) {
	specs := []server.TunnelModeSpec{
		{Mode: "p2p"},
		{Mode: "cloudflared", Available: func() bool { return false }},
	}

	if spec, ok := savedWANModeToStart(true, "p2p", specs); !ok || spec.Mode != "p2p" {
		t.Fatalf("available saved mode: got %q ok=%v, want p2p true", spec.Mode, ok)
	}
	if _, ok := savedWANModeToStart(false, "p2p", specs); ok {
		t.Fatal("terminal launch must not start a saved WAN mode")
	}
	if _, ok := savedWANModeToStart(true, "", specs); ok {
		t.Fatal("empty saved mode must not start anything")
	}
	if _, ok := savedWANModeToStart(true, "cloudflared", specs); ok {
		t.Fatal("registered-but-unavailable saved mode must be skipped")
	}
	if _, ok := savedWANModeToStart(true, "ghost", specs); ok {
		t.Fatal("unregistered saved mode must be skipped")
	}
}

// TestIsGUILaunch pins that only a no-terminal, non-test launch counts as a GUI
// launch — the only launch that applies the saved connectivity preferences.
func TestIsGUILaunch(t *testing.T) {
	cases := []struct {
		hasTerminal, testMode, want bool
	}{
		{false, false, true}, // icon/desktop-app launch
		{true, false, false}, // terminal launch
		{false, true, false}, // test harness
		{true, true, false},
	}
	for _, c := range cases {
		a := &App{flags: appFlags{hasTerminal: c.hasTerminal, testMode: c.testMode}}
		if got := a.isGUILaunch(); got != c.want {
			t.Errorf("isGUILaunch(hasTerminal=%v,testMode=%v) = %v, want %v",
				c.hasTerminal, c.testMode, got, c.want)
		}
	}
}
