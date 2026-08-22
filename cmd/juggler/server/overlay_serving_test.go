//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"io/fs"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/gorilla/mux"

	"juggler/cmd/juggler/server/handlers"
	"juggler/web"
)

// proOverlay is a minimal distribution overlay: one extra extension with a
// valid manifest and one capability file, layered over the embedded assets.
func proOverlay() fs.FS {
	manifest := `{
		"id": "@pro/test-extension",
		"name": "Pro Test Extension",
		"version": "0.0.1",
		"license": "LicenseRef-Proprietary",
		"engineApi": "*",
		"provides": {"contextItems": ["context-items/*-context-item.js"]}
	}`
	return fstest.MapFS{
		"extensions/pro-test/juggler.extension.json":            {Data: []byte(manifest)},
		"extensions/pro-test/context-items/pro-context-item.js": {Data: []byte("// pro capability")},
	}
}

// TestOverlayServedAndDiscovered exercises the distribution seam end to end at
// the server layer: with an overlay installed via web.SetOverlay, the static
// routes serve overlay files, and extension discovery lists the overlay
// extension alongside the embedded juggler-core — with zero changes to routing
// or discovery code.
func TestOverlayServedAndDiscovered(t *testing.T) {
	web.SetOverlay(proOverlay())
	t.Cleanup(func() { web.SetOverlay(nil) })

	// Build the extensions API exactly the way production does (from web.Files).
	builtinFS, err := fs.Sub(web.Files, ".")
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{
		router:        mux.NewRouter(),
		staticVersion: "test",
		serverAPIs:    serverAPIs{extensionsAPI: handlers.NewExtensionsAPI(builtinFS, "", "")},
	}
	s.setupRoutes()

	// 1. Overlay file served through the standard static route.
	rec := httptest.NewRecorder()
	s.router.ServeHTTP(rec, httptest.NewRequest("GET",
		"/vtest/extensions/pro-test/context-items/pro-context-item.js", nil))
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "pro capability") {
		t.Fatalf("overlay asset not served: %d %q", rec.Code, rec.Body.String())
	}

	// 2. Embedded file still served identically.
	rec = httptest.NewRecorder()
	s.router.ServeHTTP(rec, httptest.NewRequest("GET",
		"/vtest/extensions/juggler-core/juggler.extension.json", nil))
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "@juggler/core") {
		t.Fatalf("embedded asset broken under overlay: %d", rec.Code)
	}

	// 3. Discovery lists both the embedded and the overlay extension.
	rec = httptest.NewRecorder()
	s.router.ServeHTTP(rec, httptest.NewRequest("GET", "/api/extensions", nil))
	body := rec.Body.String()
	if rec.Code != 200 {
		t.Fatalf("extensions list: %d %s", rec.Code, body)
	}
	if !strings.Contains(body, "@juggler/core") {
		t.Fatalf("juggler-core missing from discovery: %s", body)
	}
	if !strings.Contains(body, "@pro/test-extension") {
		t.Fatalf("overlay extension missing from discovery: %s", body)
	}
}
