//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestCancelReasonFromPayload pins the parser a cancel frame's annotation goes
// through. It is the only branchy part of cancel attribution: the reason is a
// log label, so a frame that names nothing, names nonsense, or tries to pad the
// log must still cancel and must still yield exactly one bounded line.
func TestCancelReasonFromPayload(t *testing.T) {
	long := strings.Repeat("a", 500)

	tests := []struct {
		name    string
		payload json.RawMessage
		want    cancelReason
	}{
		{
			name:    "absent payload",
			payload: nil,
			want:    cancelReasonUnspecified,
		},
		{
			name:    "no reason field",
			payload: json.RawMessage(`{}`),
			want:    cancelReasonUnspecified,
		},
		{
			name:    "empty reason",
			payload: json.RawMessage(`{"type":"cancel","reason":"  "}`),
			want:    cancelReasonUnspecified,
		},
		{
			name:    "malformed payload",
			payload: json.RawMessage(`{"reason":`),
			want:    cancelReasonUnspecified,
		},
		{
			name:    "reason carried through",
			payload: json.RawMessage(`{"type":"cancel","reason":"escape"}`),
			want:    "escape",
		},
		{
			name:    "over-long reason truncated",
			payload: json.RawMessage(`{"reason":"` + long + `"}`),
			want:    cancelReason(strings.Repeat("a", maxCancelReasonLen)),
		},
		{
			name:    "newlines flattened",
			payload: json.RawMessage(`{"reason":"escape\nERROR forged line"}`),
			want:    "escape ERROR forged line",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := cancelReasonFromPayload(tc.payload)
			if got != tc.want {
				t.Fatalf("cancelReasonFromPayload(%s) = %q, want %q", tc.payload, got, tc.want)
			}
			if strings.ContainsAny(string(got), "\r\n") {
				t.Fatalf("reason %q still carries a line break", got)
			}
			if len([]rune(got)) > maxCancelReasonLen {
				t.Fatalf("reason %q is %d runes, over the %d bound", got, len([]rune(got)), maxCancelReasonLen)
			}
		})
	}
}
