//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package web provides embedded static files for the web frontend.
package web

import (
	"embed"
	"io/fs"
)

// Licensing: sdk/ and extensions/ are Apache-2.0 (see their LICENSE files);
// everything else embedded here is AGPL-3.0-or-later (see the root LICENSE).
// Mixing them in one embed.FS is fine — see LICENSING.md at the repo root.
//
//go:embed css/* js/* extensions/* sdk/* resources/* index.html engine.html sandbox.html
var builtin embed.FS

// FS is the capability set consumers of the asset tree rely on. embed.FS
// satisfies it, and so does the overlay installed by SetOverlay.
type FS interface {
	fs.FS
	fs.ReadFileFS
	fs.ReadDirFS
}

// Files is the asset tree the server serves. By default it is exactly the
// embedded tree; SetOverlay layers additional assets over it. Read at server
// startup — do not reassign after the server has started.
var Files FS = builtin

// SetOverlay layers extra assets over the embedded tree: lookups check the
// overlay first and fall back to the embedded files, and directory listings
// merge both (overlay wins on a name collision). This is the seam a
// distribution with additional components (e.g. extra extensions under
// extensions/<name>/) uses to add assets without editing this repository.
// Call before the server starts; passing nil restores the embedded tree.
func SetOverlay(overlay fs.FS) {
	if overlay == nil {
		Files = builtin
		return
	}
	Files = &overlayFS{base: builtin, overlay: overlay}
}
