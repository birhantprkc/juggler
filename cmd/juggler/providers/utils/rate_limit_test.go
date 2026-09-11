//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package utils

import (
	"net/http"
	"testing"
	"time"
)

func TestParseRateLimitHint(t *testing.T) {
	now := time.Date(2026, 9, 10, 19, 58, 0, 0, time.UTC)

	tests := []struct {
		name   string
		header http.Header
		body   string
		want   time.Duration
	}{
		{
			name: "a subscription usage cap states its reset in the body",
			body: `{"type":"usage_limit_reached","message":"The usage limit has been reached","plan_type":"plus","resets_at":1789081159,"resets_in_seconds":14476}`,
			want: 14476 * time.Second,
		},
		{
			// The SDK builds its error text around the body it received, so the
			// fields survive inside a larger string and must still be found.
			name: "the body embedded in an SDK error's text",
			body: `POST "https://chatgpt.com/backend-api/codex/responses": 429 Too Many Requests {"resets_in_seconds":90}`,
			want: 90 * time.Second,
		},
		{
			name:   "Retry-After in seconds",
			header: http.Header{"Retry-After": []string{"37"}},
			want:   37 * time.Second,
		},
		{
			name:   "Retry-After as an HTTP date",
			header: http.Header{"Retry-After": []string{"Thu, 10 Sep 2026 20:58:00 GMT"}},
			want:   time.Hour,
		},
		{
			// Relative beats absolute: it is measured from the response in hand,
			// so it holds even when the two clocks disagree.
			name: "a body field outranks the header",
			header: http.Header{
				"Retry-After": []string{"1"},
			},
			body: `{"resets_in_seconds":600}`,
			want: 600 * time.Second,
		},
		{
			name: "an absolute reset is measured against now",
			body: `{"resets_at":1789084680}`,
			want: 4 * time.Hour,
		},
		{
			name: "a number the gateway stringified",
			body: `{"retry_after":"45"}`,
			want: 45 * time.Second,
		},
		{
			// The distinction the incident turned on: said nothing is not "wait a
			// couple of seconds", and only the caller may decide what to do about it.
			name: "a 429 that states nothing",
			body: `{"error":{"message":"Rate limit reached","type":"requests"}}`,
			want: 0,
		},
		{
			name: "a reset that has already passed states nothing",
			body: `{"resets_in_seconds":-30}`,
			want: 0,
		},
		{
			name: "an absurd wait is clamped rather than believed or discarded",
			body: `{"resets_in_seconds":99999999}`,
			want: MaxRateLimitHint,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := parseRateLimitHint(tt.header, tt.body, now); got != tt.want {
				t.Fatalf("ParseRateLimitHint = %v, want %v", got, tt.want)
			}
		})
	}
}
