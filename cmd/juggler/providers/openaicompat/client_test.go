//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaicompat

import "testing"

func TestParseHeaderJSON(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want map[string]string
	}{
		{"empty", "", nil},
		{"whitespace", "   ", nil},
		{"empty object", "{}", nil},
		{"invalid json", "{not json", nil},
		{"array not object", `["a","b"]`, nil},
		{"valid single", `{"User-Agent":"app/1.0"}`, map[string]string{"User-Agent": "app/1.0"}},
		{"valid multi", `{"User-Agent":"app/1.0","X-Key":"v"}`, map[string]string{"User-Agent": "app/1.0", "X-Key": "v"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := parseHeaderJSON(tc.in)
			if len(got) != len(tc.want) {
				t.Fatalf("parseHeaderJSON(%q) = %v, want %v", tc.in, got, tc.want)
			}
			for k, v := range tc.want {
				if got[k] != v {
					t.Fatalf("parseHeaderJSON(%q)[%q] = %q, want %q", tc.in, k, got[k], v)
				}
			}
		})
	}
}
