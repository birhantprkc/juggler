//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package skipdirs holds the single authoritative list of directory base names
// that are never traversed for file watching, path indexing, or "@" completion.
// It lives in internal/ so both the file watcher (core) and the completion ops
// can reference one list without an import cycle.
package skipdirs

// names is the set of directory base names to skip. These are the usual large
// generated / vendored subtrees; traversing them is rarely useful and is the
// most common source of fd exhaustion on darwin. Dot-directories are skipped
// separately by callers, so they are not listed here.
var names = map[string]struct{}{
	"node_modules":        {},
	"vendor":              {},
	"bin":                 {},
	"dist":                {},
	"build":               {},
	"out":                 {},
	"Pods":                {},
	"__pycache__":         {},
	"cmake-build-debug":   {},
	"cmake-build-release": {},
}

// Skip reports whether a directory with the given base name should be skipped.
func Skip(name string) bool {
	_, ok := names[name]
	return ok
}
