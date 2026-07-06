//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Production-build variant of embed_testassets.go. Release binaries
// (`make release-build`, -tags production) don't ship the test runner page or
// the js-tests/ tree, so the real //go:embed is excluded — but server code
// references web.TestFiles unconditionally, so this file supplies an empty FS
// to keep the package compiling. The /headless-test route is never registered
// in a production build, and the /js-tests/ static route resolves to 404s
// against the empty FS.

//go:build production

package web

import "embed"

// TestFiles is empty in production builds; the populated embed lives in
// embed_testassets.go (the !production variant).
var TestFiles embed.FS
