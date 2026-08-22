//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"

	"github.com/gorilla/mux"

	"juggler/cmd/juggler/server/handlers"
)

// TestExtraRoutesHook proves the Config.ExtraRoutes seam: a route registered
// through the hook is reachable on the server's router after setupRoutes, and
// a nil hook leaves routing untouched (built-ins still resolve).
func TestExtraRoutesHook(t *testing.T) {
	build := func(extra func(r *mux.Router)) *Server {
		return &Server{
			router:        mux.NewRouter(),
			staticVersion: "test",
			serverAPIs:    serverAPIs{extensionsAPI: handlers.NewExtensionsAPI(fstest.MapFS{}, "", "")},
			extraRoutes:   extra,
		}
	}

	s := build(func(r *mux.Router) {
		r.HandleFunc("/pro/ping", func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusTeapot)
		}).Methods("GET")
	})
	s.setupRoutes()

	rec := httptest.NewRecorder()
	s.router.ServeHTTP(rec, httptest.NewRequest("GET", "/pro/ping", nil))
	if rec.Code != http.StatusTeapot {
		t.Fatalf("extra route not served: got %d", rec.Code)
	}

	// nil hook: setupRoutes must not panic, and unknown paths still 404.
	s = build(nil)
	s.setupRoutes()
	rec = httptest.NewRecorder()
	s.router.ServeHTTP(rec, httptest.NewRequest("GET", "/pro/ping", nil))
	if rec.Code == http.StatusTeapot {
		t.Fatalf("route leaked into nil-hook server")
	}
}
