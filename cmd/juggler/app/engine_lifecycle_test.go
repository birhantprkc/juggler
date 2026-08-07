//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package app

import (
	"testing"

	"juggler/internal/enginehost"
)

func TestEngineHostRequiresNativeApp(t *testing.T) {
	tests := []struct {
		name string
		mode enginehost.Mode
		want bool
	}{
		{name: "node is display-free", mode: enginehost.ModeNode, want: false},
		{name: "webview needs native application", mode: enginehost.ModeWebview, want: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := engineHostRequiresNativeApp(tc.mode); got != tc.want {
				t.Fatalf("engineHostRequiresNativeApp(%s) = %v, want %v", tc.mode, got, tc.want)
			}
		})
	}
}
