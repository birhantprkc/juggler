//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package streamidle

import (
	"testing"
	"time"
)

func TestParseIdleTimeout(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want time.Duration
	}{
		{"blank", "", 0},
		{"whitespace", "   ", 0},
		{"zero", "0", 0},
		{"negative", "-30", 0},
		{"non-numeric", "abc", 0},
		{"float rejected", "12.5", 0},
		{"trailing junk", "300s", 0},
		{"valid", "300", 300 * time.Second},
		{"valid with surrounding spaces", "  600 ", 600 * time.Second},
		{"one second", "1", 1 * time.Second},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := parseIdleTimeout(tc.raw); got != tc.want {
				t.Fatalf("parseIdleTimeout(%q) = %v, want %v", tc.raw, got, tc.want)
			}
		})
	}
}
