//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄▄▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"testing"
)

func TestVerifyInstanceRequiresMatchingPID(t *testing.T) {
	project := t.TempDir()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = fmt.Fprintf(w, `{"status":"ok","projectPath":%q,"pid":42}`, project)
	}))
	defer server.Close()

	info := instanceInfoForURL(t, server.URL, 99)
	ok, err := VerifyInstance(info, project)
	if err != nil {
		t.Fatalf("VerifyInstance returned error: %v", err)
	}
	if ok {
		t.Fatal("VerifyInstance accepted a server with a different PID")
	}
}

func TestVerifyInstanceAcceptsMatchingProjectAndPID(t *testing.T) {
	project := t.TempDir()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = fmt.Fprintf(w, `{"status":"ok","projectPath":%q,"pid":42}`, project)
	}))
	defer server.Close()

	info := instanceInfoForURL(t, server.URL, 42)
	ok, err := VerifyInstance(info, project)
	if err != nil {
		t.Fatalf("VerifyInstance returned error: %v", err)
	}
	if !ok {
		t.Fatal("VerifyInstance rejected the matching server")
	}
}

func instanceInfoForURL(t *testing.T, rawURL string, pid int) *InstanceInfo {
	t.Helper()
	u, err := url.Parse(rawURL)
	if err != nil {
		t.Fatalf("parse test URL %q: %v", rawURL, err)
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil {
		t.Fatalf("parse test port %q: %v", u.Port(), err)
	}
	return &InstanceInfo{Host: u.Hostname(), Port: port, PID: pid}
}
