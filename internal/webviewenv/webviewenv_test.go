//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package webviewenv

import (
	"strings"
	"testing"
)

func TestPreflight(t *testing.T) {
	tests := []struct {
		name             string
		goos             string
		display, wayland string
		wantProblem      bool
	}{
		{"linux no display at all", "linux", "", "", true},
		{"linux with X11 display", "linux", ":0", "", false},
		{"linux under wayland", "linux", "", "wayland-0", false},
		{"linux under xvfb", "linux", ":99", "", false},
		{"darwin never preflight-fails", "darwin", "", "", false},
		{"windows never preflight-fails", "windows", "", "", false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := preflight(tc.goos, tc.display, tc.wayland)
			if tc.wantProblem && got == "" {
				t.Fatalf("preflight(%q, %q, %q) = \"\", want a problem", tc.goos, tc.display, tc.wayland)
			}
			if !tc.wantProblem && got != "" {
				t.Fatalf("preflight(%q, %q, %q) = %q, want \"\"", tc.goos, tc.display, tc.wayland, got)
			}
		})
	}
}

func TestMessagePerOS(t *testing.T) {
	const reason = "the engine webview did not initialise in time"
	// Each OS's message must lead with the reason and carry the fix specific to
	// that platform, so a user on any host gets actionable guidance.
	cases := []struct {
		goos     string
		contains []string
	}{
		{"linux", []string{reason, "xvfb-run", "WEBKIT_DISABLE", "libwebkit2gtk"}},
		{"darwin", []string{reason, "Aqua", "LaunchAgent"}},
		{"windows", []string{reason, "WebView2", "interactive user session"}},
		{"plan9", []string{reason, "webview runtime"}},
	}
	for _, tc := range cases {
		t.Run(tc.goos, func(t *testing.T) {
			msg := message(tc.goos, reason)
			for _, want := range tc.contains {
				if !strings.Contains(msg, want) {
					t.Errorf("message(%q) missing %q; got:\n%s", tc.goos, want, msg)
				}
			}
		})
	}
}
