//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	_ "embed"
	"net/http"
)

// wailsRuntimeJS is the @wailsio/runtime bundle shipped by the upstream Wails
// v3 asset server. We serve a single copy at `/wails/runtime.js` for every
// client — the in-process WKWebView (which needs it for --wails-draggable
// header dragging and the juggler:theme bridge) and remote LAN browsers
// (where the runtime is inert because the WKWebView IPC bridges it pokes
// don't exist). Serving it uniformly removes the need for any per-client
// "is this the Wails window?" template branching.
//
// The Makefile keeps this copy in sync with
// 3rdparty/wails/v3/internal/assetserver/bundledassets/runtime.js because
// the embed directive can't follow symlinks or `..` paths.
//
//go:embed wails_runtime.js
var wailsRuntimeJS []byte

// handleWailsRuntime serves the embedded @wailsio/runtime bundle.
func (s *Server) handleWailsRuntime(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	_, _ = w.Write(wailsRuntimeJS)
}
