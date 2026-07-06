//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Test-harness assets, embedded separately from the production Files so the
// `production` build tag can exclude them from shipped binaries — mirroring the
// `//go:build !production` handler gating in cmd/juggler/testing and
// cmd/juggler/worker. These assets are served only when RegisterTestRoutes
// wires the headless test runner. The empty production-build variant lives in
// embed_testassets_production.go.

//go:build !production

package web

import "embed"

// TestFiles holds the js-tests/ tree: the headless test runner page
// (js-tests/headless-test.html) and the unit/integration suites it loads.
// Served at /headless-test and /v<ver>/js-tests/... in test-capable builds.
//
//go:embed js-tests/*
var TestFiles embed.FS
