//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestHTTPRequestRoundTrip(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read request body: %v", err)
		}
		w.Header().Set("X-Reply", "yes")
		w.WriteHeader(http.StatusCreated)
		_, _ = fmt.Fprintf(w, "%s|%s|%s", r.Method, r.Header.Get("X-Test"), body)
	}))
	defer server.Close()

	handler := NewHTTPOperations(PathScope{})
	for _, method := range []string{"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"} {
		t.Run(method, func(t *testing.T) {
			result, err := handler.Execute(context.Background(), "request", map[string]any{
				"method":            method,
				"url":               server.URL,
				"headers":           map[string]any{"X-Test": "value"},
				"body":              "payload",
				"allowPrivateHosts": true,
			})
			if err != nil {
				t.Fatalf("Execute: %v", err)
			}
			response := result.(map[string]any)
			if response["status"] != http.StatusCreated || response["statusText"] != "Created" {
				t.Fatalf("unexpected status: %#v", response)
			}
			if response["truncated"] != false {
				t.Fatalf("unexpected truncation: %#v", response["truncated"])
			}
			headers := response["headers"].(map[string]string)
			if headers["X-Reply"] != "yes" {
				t.Fatalf("response headers = %#v", headers)
			}
			wantBody := method + "|value|payload"
			if method == http.MethodHead {
				wantBody = ""
			}
			if response["body"] != wantBody {
				t.Fatalf("body = %q, want %q", response["body"], wantBody)
			}
		})
	}
}

func TestHTTPRequestRedirectPolicy(t *testing.T) {
	final := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("final"))
	}))
	defer final.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, final.URL, http.StatusFound)
	}))
	defer redirect.Close()

	handler := NewHTTPOperations(PathScope{})
	base := map[string]any{"url": redirect.URL, "allowPrivateHosts": true}
	result, err := handler.Execute(context.Background(), "request", base)
	if err != nil {
		t.Fatalf("follow redirect: %v", err)
	}
	if result.(map[string]any)["body"] != "final" {
		t.Fatalf("followed body = %#v", result)
	}

	base["followRedirects"] = false
	result, err = handler.Execute(context.Background(), "request", base)
	if err != nil {
		t.Fatalf("do not follow redirect: %v", err)
	}
	response := result.(map[string]any)
	if response["status"] != http.StatusFound {
		t.Fatalf("status = %v, want %d", response["status"], http.StatusFound)
	}
}

func TestHTTPRequestResponseCap(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("x", maxHTTPResponse+1)))
	}))
	defer server.Close()

	result, err := NewHTTPOperations(PathScope{}).Execute(context.Background(), "request", map[string]any{
		"url": server.URL, "allowPrivateHosts": true,
	})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	response := result.(map[string]any)
	if response["truncated"] != true || len(response["body"].(string)) != maxHTTPResponse {
		t.Fatalf("cap result: truncated=%v length=%d", response["truncated"], len(response["body"].(string)))
	}
}

func TestHTTPRequestTimeoutAndCancellation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))
	defer server.Close()
	handler := NewHTTPOperations(PathScope{})

	_, err := handler.Execute(context.Background(), "request", map[string]any{
		"url": server.URL, "allowPrivateHosts": true, "timeoutMs": float64(10),
	})
	if err == nil {
		t.Fatal("expected timeout error")
	}

	cancelStarted := make(chan struct{})
	cancelServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(cancelStarted)
		<-r.Context().Done()
	}))
	defer cancelServer.Close()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, executeErr := handler.Execute(ctx, "request", map[string]any{
			"url": cancelServer.URL, "allowPrivateHosts": true,
		})
		done <- executeErr
	}()
	<-cancelStarted
	cancel()
	select {
	case err = <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancellation error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("request did not stop after context cancellation")
	}
}

func TestHTTPRequestSSRFGuard(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("ok"))
	}))
	defer server.Close()
	handler := NewHTTPOperations(PathScope{})

	for _, target := range []string{server.URL, "http://127.0.0.1/", "http://[::1]/", "http://169.254.169.254/", "http://10.0.0.1/"} {
		_, err := handler.Execute(context.Background(), "request", map[string]any{"url": target})
		if err == nil || !strings.Contains(err.Error(), "allowPrivateHosts") {
			t.Fatalf("target %q error = %v", target, err)
		}
	}

	result, err := handler.Execute(context.Background(), "request", map[string]any{
		"url": server.URL, "allowPrivateHosts": true,
	})
	if err != nil {
		t.Fatalf("private-host opt-in: %v", err)
	}
	if result.(map[string]any)["body"] != "ok" {
		t.Fatalf("private-host opt-in result = %#v", result)
	}
}

func TestHTTPRequestValidation(t *testing.T) {
	handler := NewHTTPOperations(PathScope{})
	cases := []map[string]any{
		{},
		{"url": "file:///tmp/test"},
		{"url": "https://example.com", "method": "OPTIONS"},
		{"url": "https://example.com", "headers": map[string]any{"Authorization": 7}},
		{"url": "https://example.com", "timeoutMs": float64(120001)},
		{"url": "https://example.com", "followRedirects": "yes"},
	}
	for _, params := range cases {
		if _, err := handler.Execute(context.Background(), "request", params); err == nil {
			t.Fatalf("expected validation error for %#v", params)
		}
	}
	if _, err := handler.Execute(context.Background(), "other", nil); err == nil {
		t.Fatal("expected unknown operation error")
	}
}
