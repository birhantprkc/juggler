//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gorilla/mux"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/server/handlers"
)

// UI zoom and theme are the desktop window's own settings, stored per project in
// the session. A phone or laptop browsing in over the LAN or a tunnel is handed
// those values as its starting point but keeps its own in localStorage, so the
// write routes are gated to viewers on this machine. Without the gate the last
// device to zoom resizes every other one, and the desktop comes back changed
// from a session someone spent on a phone. These tests pin that gate, the read
// path staying open, and the project key the viewer namespaces its own storage
// with.

const localViewerAddr = "127.0.0.1:54321"

// newUIPrefsTestServer wires the real session routes over a real (temp-dir)
// session manager, so these tests exercise the registered route — including its
// localViewerOnly wrapper — rather than a stand-in.
func newUIPrefsTestServer(t *testing.T) (*Server, *core.SessionManager) {
	t.Helper()
	mgr, err := core.NewSessionManagerForPath(t.TempDir())
	if err != nil {
		t.Fatalf("NewSessionManagerForPath: %v", err)
	}
	t.Cleanup(mgr.Shutdown)
	s := &Server{router: mux.NewRouter()}
	s.setupSessionRoutes(handlers.NewSessionAPI(
		func() *core.SessionManager { return mgr }, nil, nil, nil, nil))
	return s, mgr
}

// uiPrefRequest issues one request at addr, optionally tagged as having arrived
// over a granted remote transport (a DataChannel dispatch or tunnel hop, both of
// which reach the server over loopback).
func uiPrefRequest(t *testing.T, s *Server, method, path, body, addr string, remote bool) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = addr
	if remote {
		req = withRemoteIngress(req)
	}
	rec := httptest.NewRecorder()
	s.router.ServeHTTP(rec, req)
	return rec
}

func TestUIPrefWritesAcceptLocalViewer(t *testing.T) {
	s, mgr := newUIPrefsTestServer(t)

	rec := uiPrefRequest(t, s, http.MethodPut, "/api/session/ui-zoom",
		`{"uiZoom":130}`, localViewerAddr, false)
	if rec.Code != http.StatusOK {
		t.Fatalf("local ui-zoom write: got %d, want 200", rec.Code)
	}
	if zoom, ok := mgr.GetUIZoom(); !ok || zoom != 130 {
		t.Fatalf("local ui-zoom write not stored: got %d ok=%v want 130 true", zoom, ok)
	}

	rec = uiPrefRequest(t, s, http.MethodPut, "/api/session/ui-theme",
		`{"uiTheme":"dark"}`, localViewerAddr, false)
	if rec.Code != http.StatusOK {
		t.Fatalf("local ui-theme write: got %d, want 200", rec.Code)
	}
	if mode, ok := mgr.GetUITheme(); !ok || mode != "dark" {
		t.Fatalf("local ui-theme write not stored: got %q ok=%v want \"dark\" true", mode, ok)
	}
}

// TestUIPrefWritesRejectLANViewer covers a phone on the same wifi: a plain
// non-loopback connection, no remote-ingress tag.
func TestUIPrefWritesRejectLANViewer(t *testing.T) {
	s, mgr := newUIPrefsTestServer(t)
	if err := mgr.SetUIZoom(110); err != nil {
		t.Fatalf("seed zoom: %v", err)
	}

	rec := uiPrefRequest(t, s, http.MethodPut, "/api/session/ui-zoom",
		`{"uiZoom":60}`, remoteEdgeAddr, false)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("LAN ui-zoom write: got %d, want 403", rec.Code)
	}
	if zoom, _ := mgr.GetUIZoom(); zoom != 110 {
		t.Fatalf("LAN viewer changed the desktop's zoom: got %d, want 110", zoom)
	}
}

// TestUIPrefWritesRejectTunnelViewer is the one the address check alone would
// miss: a DataChannel dispatch or tunnel forwarder hop reaches the server over
// loopback, so only the remote-ingress tag distinguishes it from the desktop.
func TestUIPrefWritesRejectTunnelViewer(t *testing.T) {
	s, mgr := newUIPrefsTestServer(t)
	if err := mgr.SetUITheme("dark"); err != nil {
		t.Fatalf("seed theme: %v", err)
	}

	rec := uiPrefRequest(t, s, http.MethodPut, "/api/session/ui-theme",
		`{"uiTheme":"light"}`, localViewerAddr, true)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("tunnelled ui-theme write: got %d, want 403", rec.Code)
	}
	if mode, _ := mgr.GetUITheme(); mode != "dark" {
		t.Fatalf("tunnelled viewer changed the desktop's theme: got %q, want \"dark\"", mode)
	}
}

// TestUIPrefReadsStayOpen: only the writes are gated. A remote viewer is meant
// to start from the desktop's settings, so it must still be able to read them.
func TestUIPrefReadsStayOpen(t *testing.T) {
	s, mgr := newUIPrefsTestServer(t)
	if err := mgr.SetUIZoom(90); err != nil {
		t.Fatalf("seed zoom: %v", err)
	}

	rec := uiPrefRequest(t, s, http.MethodGet, "/api/session/ui-zoom", "", remoteEdgeAddr, true)
	if rec.Code != http.StatusOK {
		t.Fatalf("remote ui-zoom read: got %d, want 200", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "90") {
		t.Fatalf("remote ui-zoom read should return the saved value, got %s", rec.Body.String())
	}
}

// TestProjectStorageKeyIsStable pins the property the viewer's namespacing rests
// on: one project always yields one key, however its path is spelled.
func TestProjectStorageKeyIsStable(t *testing.T) {
	dir := t.TempDir()
	uncleaned := filepath.Join(dir, "sub", "..") + string(filepath.Separator)

	if got, want := projectStorageKey(uncleaned), projectStorageKey(dir); got != want {
		t.Fatalf("uncleaned spelling of the same project differs: got %q, want %q", got, want)
	}
	if key := projectStorageKey(dir); len(key) != projectStorageKeyLen {
		t.Fatalf("key length: got %d (%q), want %d", len(key), key, projectStorageKeyLen)
	}
}

func TestProjectStorageKeyIsPerProject(t *testing.T) {
	a, b := t.TempDir(), t.TempDir()
	if projectStorageKey(a) == projectStorageKey(b) {
		t.Fatalf("two projects share a storage key (%q) — their stored zoom/theme would collide",
			projectStorageKey(a))
	}
}

// TestProjectStorageKeyHidesThePath: the key lands in a localStorage the studio
// relay origin shares with other pages, so it must not carry where the project
// lives. A no-project window has no key at all and falls back to the bare one.
func TestProjectStorageKeyHidesThePath(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "unmistakable-project-name")
	key := projectStorageKey(dir)
	if strings.Contains(key, "unmistakable-project-name") {
		t.Fatalf("storage key leaks the project path: %q", key)
	}
	if projectStorageKey("") != "" {
		t.Fatalf("no-project window should have no key, got %q", projectStorageKey(""))
	}
}
