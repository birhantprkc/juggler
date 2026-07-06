//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package utils

import "testing"

func TestModelCapsLookup(t *testing.T) {
	caps := ModelCaps{Default: 100, Overrides: map[string]int{"a": 200}}
	if got := caps.Lookup("a"); got != 200 {
		t.Errorf("Lookup(a) = %d, want 200 (override)", got)
	}
	if got := caps.Lookup("b"); got != 100 {
		t.Errorf("Lookup(b) = %d, want 100 (default)", got)
	}
}

func TestModelCapsNilOverrides(t *testing.T) {
	caps := ModelCaps{Default: 42}
	if got := caps.Lookup("anything"); got != 42 {
		t.Errorf("Lookup with nil overrides = %d, want 42 (default)", got)
	}
}
