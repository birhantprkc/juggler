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

// workspaceFile is the JSON document: an ordered list of open windows.
type workspaceFile struct {
	Windows []workspaceEntry `json:"windows"`
}

// workspaceStore persists the open-window set. One goroutine owns the file;
// callers send ordered saves (fire-and-forget) or flush (wait for the write).
type workspaceStore struct {
	saves chan wsSaveReq
	path  string
}

type wsSaveReq struct {
	entries []workspaceEntry
	done    chan struct{} // non-nil for a synchronous flush
}

func newWorkspaceStore() *workspaceStore {
	w := &workspaceStore{saves: make(chan wsSaveReq, 16), path: workspaceFilePath()}
	go func() {
		for req := range w.saves {
			writeWorkspaceFile(w.path, req.entries)
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

// load reads the persisted set as specs (nil when missing/corrupt → caller
// falls back to a single default window).
func (w *workspaceStore) load() []windowSpec {
	data, err := os.ReadFile(w.path)
	if err != nil {
		return nil
	}
	var f workspaceFile
	if json.Unmarshal(data, &f) != nil {
		return nil
	}
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

func workspaceFilePath() string {
	return filepath.Join(userpaths.ConfigDir(), "workspace.json")
}

func writeWorkspaceFile(path string, entries []workspaceEntry) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		logf("workspace: mkdir failed: %v", err)
		return
	}
	data, err := json.MarshalIndent(workspaceFile{Windows: entries}, "", "  ")
	if err != nil {
		return
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		logf("workspace: write failed: %v", err)
	}
}
