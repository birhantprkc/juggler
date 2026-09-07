//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"context"
	"strings"
	"testing"
)

// privateHTTPTargets are literal addresses, so the guard resolves them without
// a DNS lookup and the test needs no network of any kind.
var privateHTTPTargets = []string{
	"https://127.0.0.1/",
	"https://[::1]/",
	"https://169.254.169.254/",
	"https://10.0.0.1/",
	"https://192.168.1.1/",
	"http://localhost/",
}

func TestWebFetchSSRFGuard(t *testing.T) {
	handler := NewWebFetchOperations(PathScope{})
	for _, target := range privateHTTPTargets {
		_, err := handler.Execute(context.Background(), "fetch", map[string]any{"url": target})
		if err == nil || !strings.Contains(err.Error(), "private, loopback, and link-local hosts") {
			t.Fatalf("target %q error = %v", target, err)
		}
	}
}

func TestWebSearchSSRFGuard(t *testing.T) {
	handler := NewWebSearchOperations(PathScope{})
	for _, target := range privateHTTPTargets {
		_, err := handler.Execute(context.Background(), "search", map[string]any{"url": target})
		if err == nil || !strings.Contains(err.Error(), "private, loopback, and link-local hosts") {
			t.Fatalf("target %q error = %v", target, err)
		}
	}
}

// TestWebSearchValidation pins the order as much as the rules: every check runs
// before anything is dialled, so a rejected search makes no request at all. The
// targets are loopback for that reason — reaching the network would report a
// dial failure here instead of the validation error.
func TestWebSearchValidation(t *testing.T) {
	handler := NewWebSearchOperations(PathScope{})
	cases := []struct {
		params map[string]any
		want   string
	}{
		{map[string]any{}, "missing url parameter"},
		{map[string]any{"url": "file:///etc/passwd"}, "absolute HTTP or HTTPS URL"},
		{map[string]any{"url": "not a url"}, "absolute HTTP or HTTPS URL"},
		{map[string]any{"url": "http://127.0.0.1/", "method": "DELETE"}, "unsupported HTTP method"},
		{map[string]any{"url": "http://127.0.0.1/", "method": 7}, "unsupported HTTP method"},
	}
	for _, testCase := range cases {
		_, err := handler.Execute(context.Background(), "search", testCase.params)
		if err == nil || !strings.Contains(err.Error(), testCase.want) {
			t.Fatalf("params %#v error = %v, want %q", testCase.params, err, testCase.want)
		}
	}
	if _, err := handler.Execute(context.Background(), "other", nil); err == nil {
		t.Fatal("expected unknown operation error")
	}
}

func TestReadCappedBody(t *testing.T) {
	body, truncated, err := readCappedBody(strings.NewReader("hello"), 8)
	if err != nil || truncated || string(body) != "hello" {
		t.Fatalf("short read: %q truncated=%v err=%v", body, truncated, err)
	}
	body, truncated, err = readCappedBody(strings.NewReader(strings.Repeat("x", 9)), 8)
	if err != nil || !truncated || len(body) != 8 {
		t.Fatalf("capped read: len=%d truncated=%v err=%v", len(body), truncated, err)
	}
	body, truncated, err = readCappedBody(strings.NewReader(strings.Repeat("x", 8)), 8)
	if err != nil || truncated || len(body) != 8 {
		t.Fatalf("exact read: len=%d truncated=%v err=%v", len(body), truncated, err)
	}
}
