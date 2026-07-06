//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package web

import (
	"errors"
	"io/fs"
	"sort"
)

// overlayFS layers an overlay filesystem over a base one. File lookups check
// the overlay first and fall back to the base; directory listings merge both
// trees, with the overlay winning on a name collision. Installed by
// SetOverlay; the zero value is not useful.
//
// Limitation: Open on a directory present in both trees returns the overlay's
// directory handle, whose Readdir sees only overlay entries. Use the fs-level
// fs.ReadDir / fs.Glob / fs.WalkDir (which route through ReadDir below and see
// the merged view) rather than reading a directory via Open.
type overlayFS struct {
	base    fs.FS
	overlay fs.FS
}

// Open opens the named file from the overlay if present there, else the base.
func (o *overlayFS) Open(name string) (fs.File, error) {
	f, err := o.overlay.Open(name)
	if err == nil {
		return f, nil
	}
	if !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}
	return o.base.Open(name)
}

// ReadFile reads the named file from the overlay if present there, else the base.
func (o *overlayFS) ReadFile(name string) ([]byte, error) {
	data, err := fs.ReadFile(o.overlay, name)
	if err == nil {
		return data, nil
	}
	if !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}
	return fs.ReadFile(o.base, name)
}

// ReadDir lists the named directory as the union of both trees, sorted by
// name, with overlay entries shadowing same-named base entries. A directory
// present in only one tree lists from that tree alone.
func (o *overlayFS) ReadDir(name string) ([]fs.DirEntry, error) {
	baseEntries, baseErr := fs.ReadDir(o.base, name)
	overlayEntries, overlayErr := fs.ReadDir(o.overlay, name)

	if baseErr != nil && overlayErr != nil {
		return nil, baseErr
	}

	merged := map[string]fs.DirEntry{}
	for _, e := range baseEntries {
		merged[e.Name()] = e
	}
	for _, e := range overlayEntries {
		merged[e.Name()] = e // overlay wins on collision
	}

	out := make([]fs.DirEntry, 0, len(merged))
	for _, e := range merged {
		out = append(out, e)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name() < out[j].Name() })
	return out, nil
}
