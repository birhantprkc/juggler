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

func TestPrepareLinuxWebKit(t *testing.T) {
	cases := []struct {
		name       string
		goos       string
		alreadySet bool
		restricted bool
		wantSet    bool
		wantNote   bool
	}{
		{"linux restricted and unset disables the sandbox", "linux", false, true, true, true},
		{"linux restricted but user already set is left untouched", "linux", true, true, false, false},
		{"linux unrestricted is a no-op", "linux", false, false, false, false},
		{"darwin is always a no-op", "darwin", false, true, false, false},
		{"windows is always a no-op", "windows", false, true, false, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			set := map[string]bool{disableSandboxEnv: tc.alreadySet}
			lookup := func(k string) (string, bool) {
				if set[k] {
					return "0", true // a prior value exists, of some value
				}
				return "", false
			}
			var gotKey, gotVal string
			setter := func(k, v string) error {
				gotKey, gotVal = k, v
				set[k] = true
				return nil
			}
			note := prepareLinuxWebKit(tc.goos, lookup, setter, func() bool { return tc.restricted })

			didSet := gotKey == disableSandboxEnv && gotVal == "1"
			if didSet != tc.wantSet {
				t.Errorf("env set = %v (key=%q val=%q), want %v", didSet, gotKey, gotVal, tc.wantSet)
			}
			if (note != "") != tc.wantNote {
				t.Errorf("note = %q, want note present = %v", note, tc.wantNote)
			}
		})
	}
}

func TestSandboxRestrictedFrom(t *testing.T) {
	cases := []struct {
		name  string
		files map[string]string
		want  bool
	}{
		{"apparmor restricted", map[string]string{"/proc/sys/kernel/apparmor_restrict_unprivileged_userns": "1\n"}, true},
		{"apparmor allowed", map[string]string{"/proc/sys/kernel/apparmor_restrict_unprivileged_userns": "0\n"}, false},
		{"userns clone disabled", map[string]string{"/proc/sys/kernel/unprivileged_userns_clone": "0"}, true},
		{"max user namespaces zero", map[string]string{"/proc/sys/user/max_user_namespaces": "0"}, true},
		{"max user namespaces plentiful", map[string]string{"/proc/sys/user/max_user_namespaces": "15000"}, false},
		{"nothing present", map[string]string{}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			read := func(p string) (string, bool) { v, ok := tc.files[p]; return v, ok }
			if got := sandboxRestrictedFrom(read); got != tc.want {
				t.Errorf("sandboxRestrictedFrom = %v, want %v", got, tc.want)
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
		{"linux", []string{reason, "xvfb-run", "WEBKIT_DISABLE", "libwebkit2gtk", "apparmor_restrict_unprivileged_userns", "WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS"}},
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
