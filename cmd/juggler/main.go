//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"os"

	"juggler/cmd/juggler/app"
)

// main is a thin shim over the importable entrypoint: the whole server lives
// in cmd/juggler/app so a wrapping distribution can build its own main that
// calls app.Run with a Config carrying its extension points.
func main() {
	os.Exit(app.Run(app.Config{}))
}
