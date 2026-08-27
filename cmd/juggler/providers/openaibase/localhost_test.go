//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaibase

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAutoDetectAcceptsSuccessfulErrorBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"error":"Unexpected endpoint or method."}`))
	}))
	defer server.Close()

	host := LocalHost{DefaultHost: server.URL, HealthPath: "/health"}
	if !host.AutoDetect()() {
		t.Fatal("AutoDetect rejected a 200 response with an error-shaped body")
	}
}

func TestNormaliseHost(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"empty", "", ""},
		{"whitespace only", "   ", ""},
		{"bare host:port", "192.168.1.70:11434", "http://192.168.1.70:11434"},
		{"full http url", "http://192.168.1.70:11434", "http://192.168.1.70:11434"},
		{"full https url", "https://ollama.lan:11434", "https://ollama.lan:11434"},
		{"trailing slash trimmed", "http://localhost:11434/", "http://localhost:11434"},
		{"surrounding whitespace", "  http://localhost:11434  ", "http://localhost:11434"},
		// Missing-`//` typo repair.
		{"http missing slashes", "http:192.168.1.70:11434", "http://192.168.1.70:11434"},
		{"https missing slashes", "https:ollama.lan:11434", "https://ollama.lan:11434"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := NormaliseHost(tc.in); got != tc.want {
				t.Errorf("NormaliseHost(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}
