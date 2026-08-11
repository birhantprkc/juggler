//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package utils

import (
	"testing"
	"time"
)

// TestTransientMessage pins both halves of the classifier: what every retry site
// must retry, and — just as important — what it must not, since a false positive
// hammers a provider that is telling us to stop.
func TestTransientMessage(t *testing.T) {
	tests := []struct {
		name string
		msg  string
		want bool
	}{
		// The exact Anthropic body that silently killed auto-naming: a 503
		// arriving after the stream had already opened.
		{
			name: "anthropic overloaded mid-stream",
			msg:  `received error while streaming: {"type":"service_unavailable_error","code":"server_is_overloaded","message":"Our servers are currently overloaded. Please try again later.","param":null}`,
			want: true,
		},
		{name: "anthropic overloaded_error type", msg: `{"type":"overloaded_error"}`, want: true},
		{name: "service unavailable prose", msg: "503 Service Unavailable", want: true},
		{name: "bad gateway", msg: "502 Bad Gateway", want: true},
		{name: "gateway timeout", msg: "504 Gateway Timeout", want: true},
		{name: "temporarily unavailable", msg: "The model is temporarily unavailable", want: true},
		{name: "stall", msg: StallError("anthropic", 90*time.Second).Error(), want: true},

		// Not transient: a fresh attempt cannot help, and retrying is harmful.
		{name: "auth", msg: "401 invalid x-api-key", want: false},
		{name: "bad request", msg: "400 invalid_request_error: max_tokens too large", want: false},
		{name: "quota", msg: "credit balance is too low", want: false},
		{name: "cli exit", msg: "claude exited unexpectedly", want: false},
		{name: "status digits alone", msg: "read 503 bytes from tool output", want: false},
		{name: "empty", msg: "", want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := TransientMessage(tt.msg); got != tt.want {
				t.Fatalf("TransientMessage(%q) = %v, want %v", tt.msg, got, tt.want)
			}
		})
	}
}
