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

func TestClassifyRunningInstance(t *testing.T) {
	project := t.TempDir()
	cases := []struct {
		name string
		body string
		pid  int
		want RunningInstanceStatus
	}{
		{
			name: "durable server is reusable",
			body: `{"status":"ok","projectPath":%q,"pid":42,"parentPid":1234,"exitWithParent":true}`,
			pid:  42,
			want: InstanceReusable,
		},
		{
			name: "orphaned exit-with-parent server is exiting",
			body: `{"status":"ok","projectPath":%q,"pid":42,"parentPid":1,"exitWithParent":true}`,
			pid:  42,
			want: InstanceExiting,
		},
		{
			name: "reparented server without exit-with-parent stays reusable",
			body: `{"status":"ok","projectPath":%q,"pid":42,"parentPid":1,"exitWithParent":false}`,
			pid:  42,
			want: InstanceReusable,
		},
		{
			name: "pid mismatch is unreachable",
			body: `{"status":"ok","projectPath":%q,"pid":42,"parentPid":1,"exitWithParent":true}`,
			pid:  99,
			want: InstanceUnreachable,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				_, _ = fmt.Fprintf(w, tc.body, project)
			}))
			defer server.Close()

			info := instanceInfoForURL(t, server.URL, tc.pid)
			if got := ClassifyRunningInstance(info, project); got != tc.want {
				t.Fatalf("ClassifyRunningInstance = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestClassifyRunningInstanceUnreachableWhenDown(t *testing.T) {
	// A lock holder that no longer answers must classify as Unreachable, not
	// Exiting/Reusable — the port is dead.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}))
	info := instanceInfoForURL(t, server.URL, 42)
	server.Close()
	if got := ClassifyRunningInstance(info, t.TempDir()); got != InstanceUnreachable {
		t.Fatalf("ClassifyRunningInstance = %v, want %v", got, InstanceUnreachable)
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
