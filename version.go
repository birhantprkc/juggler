//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package juggler sits at the module root for one reason: to carry the VERSION
// file into the binary. //go:embed cannot name a file in a parent directory, so
// the version can only be embedded by a package alongside it, and the file
// belongs at the root where the build and the release tooling read it.
package juggler

import _ "embed"

// VersionFile is the contents of the VERSION file, whitespace and all. It is
// the same string every stamped build is linked with, so a build the linker
// never stamped can still say which source it was built from.
//
//go:embed VERSION
var VersionFile string
