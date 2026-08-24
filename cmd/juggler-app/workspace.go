//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"

	"juggler/internal/userpaths"
)

// A standalone (no --url/--project) launch restores the set of windows that was
// open last time, each at its remembered geometry. The set lives in
// ~/.juggler/workspace.json; per-window size/position is session state, held
// server-side in each project's session.json (via /api/session/window-state,
// see window_state_client.go). Together they reopen "the most recently opened
// set of sessions" where the user left them.
//
// The store is owned by a single goroutine (no mutex, per the concurrency
// rule); saves are ordered, and flush waits for durability at quit.

// windowSpec identifies what a window views: a local project (possibly "" for a
// no-project window, whose server we spawn) or an explicit external server URL.
// It is the single source of a window's geometry key and its workspace entry.
type windowSpec struct {
	project string
	url     string
}

func (s windowSpec) isURL() bool { return s.url != "" }

// entry is the persisted form of a spec.
func (s windowSpec) entry() workspaceEntry {
	if s.isURL() {
		return workspaceEntry{URL: s.url}
	}
	return workspaceEntry{Project: s.project}
}

// resolve turns a spec into a connectable server URL. A project spec
// discovers/spawns a local server (caller owns the returned proc); a URL spec
// just normalises the URL (proc nil — we don't own remote servers).
func (s windowSpec) resolve() (string, *exec.Cmd, error) {
	if s.isURL() {
		return normalizeURL(s.url), nil, nil
	}
	addr, proc, err := discoverOrSpawnServer(s.project)
	if err != nil {
		return "", nil, err
	}
	return "http://" + addr, proc, nil
}

// workspaceEntry is the on-disk form of one open window.
type workspaceEntry struct {
	Project string `json:"project,omitempty"`
	URL     string `json:"url,omitempty"`
}

func (e workspaceEntry) spec() windowSpec {
	if e.URL != "" {
		return windowSpec{url: e.URL}
	}
	return windowSpec{project: e.Project}
}

// workspaceFile is the JSON document: an ordered list of open windows plus a
// small "last theme used" hint. lastTheme is the most recent theme any page
// reported; it's read back at startup to paint a restored window's bare native
// frame to match instead of flashing the dark default before the page's first
// paint (see buildWindow's bgTheme). It's global, not per-project — the
// per-project value only lives in the page's localStorage, which the Go side
// can't read at window-build time.
type workspaceFile struct {
	Windows   []workspaceEntry `json:"windows"`
	LastTheme string           `json:"lastTheme,omitempty"`
	// LastZoom is the most recent page-reported UI zoom (root font-size %) across
	// all windows. Read back at startup to seed the ?zoom= hint the next window
	// (a restored, Finder-launched, or Session ▸ New Window one with no inherited
	// value) opens with, so it inherits the last-active size rather than resetting
	// to the default. Global, not per-project — the per-project value lives in the
	// session (server-side); this is only the cross-window inheritance seed.
	LastZoom int `json:"lastZoom,omitempty"`
}

// workspaceStore persists the open-window set. One goroutine owns the file;
// callers send ordered saves (fire-and-forget) or flush (wait for the write).
type workspaceStore struct {
	saves chan wsSaveReq
	path  string
}

type wsSaveReq struct {
	entries []workspaceEntry // nil leaves the persisted window set unchanged
	theme   *string          // nil leaves the persisted theme unchanged
	zoom    *int             // nil leaves the persisted zoom unchanged
	done    chan struct{}    // non-nil for a synchronous flush
}

func newWorkspaceStore() *workspaceStore {
	w := &workspaceStore{saves: make(chan wsSaveReq, 16), path: workspaceFilePath()}
	go func() {
		// Hold the whole document in memory so a windows-only or theme-only save
		// preserves the other field. Seed from disk once; this goroutine is the
		// file's sole writer thereafter (no mutex, per the concurrency rule).
		cur := readWorkspaceFile(w.path)
		for req := range w.saves {
			if req.entries != nil {
				cur.Windows = req.entries
			}
			if req.theme != nil {
				cur.LastTheme = *req.theme
			}
			if req.zoom != nil {
				cur.LastZoom = *req.zoom
			}
			writeWorkspaceFile(w.path, cur)
			if req.done != nil {
				close(req.done)
			}
		}
	}()
	return w
}

// save records the set asynchronously, preserving call order.
func (w *workspaceStore) save(entries []workspaceEntry) {
	w.saves <- wsSaveReq{entries: entries}
}

// flush records the set and waits for the write — used at quit so the final set
// is durable before the process exits.
func (w *workspaceStore) flush(entries []workspaceEntry) {
	done := make(chan struct{})
	w.saves <- wsSaveReq{entries: entries, done: done}
	<-done
}

// saveTheme records the last-used theme, preserving the open-window set.
// Best-effort and fire-and-forget, like save; a failure just means the next
// launch falls back to its default frame colour.
func (w *workspaceStore) saveTheme(theme string) {
	if normaliseTheme(theme) == "" {
		return
	}
	w.saves <- wsSaveReq{theme: &theme}
}

// saveZoom records the last-used UI zoom, preserving the open-window set and
// theme. Best-effort and fire-and-forget, like saveTheme; a failure just means
// the next launch's first window falls back to the default size.
func (w *workspaceStore) saveZoom(zoom int) {
	if zoom <= 0 {
		return
	}
	w.saves <- wsSaveReq{zoom: &zoom}
}

// loadLastZoom returns the persisted last-used UI zoom (0 when absent/corrupt).
// Read at startup to seed the ?zoom= inheritance hint before any page reports.
func (w *workspaceStore) loadLastZoom() int {
	return readWorkspaceFile(w.path).LastZoom
}

// load reads the persisted set as specs (empty when missing/corrupt → caller
// falls back to a single default window).
func (w *workspaceStore) load() []windowSpec {
	f := readWorkspaceFile(w.path)
	specs := make([]windowSpec, 0, len(f.Windows))
	for _, e := range f.Windows {
		s := e.spec()
		// Never restore a URL window: a --url launch is a one-shot connection to
		// an externally-supplied address that won't be valid next launch, so
		// restoring it just opens a window onto a dead server. Only project windows
		// are restorable — they re-spawn or re-discover a server. Skipping URL
		// entries here also clears any stale ones from workspace.json.
		if s.isURL() {
			continue
		}
		specs = append(specs, s)
	}
	return specs
}

// loadLastTheme returns the persisted last-used theme, normalised to a theme we
// know (or "" when absent/corrupt/unknown). Read at startup to seed the native
// frame colour before any page has reported its theme.
func (w *workspaceStore) loadLastTheme() string {
	return normaliseTheme(readWorkspaceFile(w.path).LastTheme)
}

func workspaceFilePath() string {
	return filepath.Join(userpaths.ConfigDir(), "workspace.json")
}

// readWorkspaceFile parses the document, returning a zero value when the file is
// missing or corrupt (callers then fall back to their defaults).
func readWorkspaceFile(path string) workspaceFile {
	data, err := os.ReadFile(path)
	if err != nil {
		return workspaceFile{}
	}
	var f workspaceFile
	if json.Unmarshal(data, &f) != nil {
		return workspaceFile{}
	}
	return f
}

func writeWorkspaceFile(path string, doc workspaceFile) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		logf("workspace: mkdir failed: %v", err)
		return
	}
	data, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		logf("workspace: write failed: %v", err)
	}
}
