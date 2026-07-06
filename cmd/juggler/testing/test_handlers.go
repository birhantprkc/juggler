//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package testing

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"juggler/cmd/juggler/server/handlers"
)

// SessionResetter is the minimum SessionManager surface the test API needs
// to wipe stale conversations between tests. *core.SessionManager satisfies
// it. The interface keeps the production stub free of any core import.
type SessionResetter interface {
	ConvNames() map[string]string
	DeleteConversation(convID string, permanent bool) error
}

// TestAPI handles benchmark test endpoints.
//
// tapeDumper is wired by the server with worker.Manager.DumpTape and used by
// HandleDumpTape to return per-conv worker event tapes. Stored as a literal
// func type (not a named typedef) so interface-method-signature matching in
// routes.go works — two function types with identical signatures only match
// if both refer to the same NAMED type or both are unnamed.
type TestAPI struct {
	testsDir      string
	fixturesDir   string
	session       SessionResetter
	tapeDumper    func(string) any
	convOwnership *ConvOwnership
}

// NewTestAPIWithSession creates a test API that can bulldoze conversations
// via the supplied SessionResetter. session may be nil if no manager is
// available yet.
func NewTestAPIWithSession(projectRoot string, session SessionResetter) *TestAPI {
	return &TestAPI{
		testsDir:      filepath.Join(projectRoot, "tests", "benchmarks", "tasks"),
		fixturesDir:   filepath.Join(projectRoot, "tests", "benchmarks", "fixtures"),
		session:       session,
		convOwnership: NewConvOwnership(),
	}
}

// SetTapeDumper wires the worker manager so the dump-tape endpoint can
// surface per-worker event tapes at test-failure time. Optional; if unset,
// HandleDumpTape returns an empty list.
func (api *TestAPI) SetTapeDumper(fn func(string) any) {
	api.tapeDumper = fn
}

// RecordConvOwner / CheckConvDelete / ReleaseConvOwner expose the ownership
// ledger to the session handlers (wired via SessionAPI.SetConvOwnershipHooks
// in RegisterTestRoutes). See ConvOwnership for the invariant they enforce.

// RecordConvOwner registers lane as the creator of convID.
func (api *TestAPI) RecordConvOwner(convID, lane string) {
	api.convOwnership.Record(convID, lane)
}

// CheckConvDelete reports whether lane may delete convID.
func (api *TestAPI) CheckConvDelete(convID, lane string) error {
	return api.convOwnership.CheckDelete(convID, lane)
}

// ReleaseConvOwner clears ownership after a successful delete.
func (api *TestAPI) ReleaseConvOwner(convID string) {
	api.convOwnership.Release(convID)
}

// HandleConversationOwners returns the current ownership map (convID → lane).
// GET /api/test/conversation-owners. A non-empty map at suite end means those
// conversations leaked — created by a test, never deleted — and the Go
// harness fails the run with this list so leaks can't silently accumulate
// toward the MAX_CONVERSATIONS cap.
func (api *TestAPI) HandleConversationOwners(w http.ResponseWriter, r *http.Request) {
	handlers.WriteJSON(w, r, 0, map[string]any{"owners": api.convOwnership.Dump()})
}

// HandleGetTask returns a specific task by ID
func (api *TestAPI) HandleGetTask(w http.ResponseWriter, r *http.Request) {
	taskID := r.URL.Query().Get("id")
	if taskID == "" {
		http.Error(w, "Task ID is required", http.StatusBadRequest)
		return
	}

	// Find task file
	var taskPath string
	err := filepath.Walk(api.testsDir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() || filepath.Ext(path) != ".json" {
			return nil
		}

		data, err := os.ReadFile(path)
		if err != nil {
			return nil
		}

		var task map[string]any
		if err := json.Unmarshal(data, &task); err != nil {
			return nil
		}

		if id, ok := task["id"].(string); ok && id == taskID {
			taskPath = path
			return filepath.SkipAll
		}

		return nil
	})

	if err != nil {
		http.Error(w, fmt.Sprintf("Error searching for task: %v", err), http.StatusInternalServerError)
		return
	}

	if taskPath == "" {
		http.Error(w, "Task not found", http.StatusNotFound)
		return
	}

	// Read and return task
	data, err := os.ReadFile(taskPath)
	if err != nil {
		http.Error(w, "Failed to read task", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(data)
}

// HandleResetFixture resets a fixture directory by deleting contents and re-copying from template
func (api *TestAPI) HandleResetFixture(w http.ResponseWriter, r *http.Request) {
	fixtureName := r.URL.Query().Get("fixture")
	fixtureDir := r.URL.Query().Get("dir")

	if fixtureName == "" || fixtureDir == "" {
		http.Error(w, "fixture and dir query params required", http.StatusBadRequest)
		return
	}

	sourcePath := filepath.Join(api.fixturesDir, fixtureName)
	if _, err := os.Stat(sourcePath); os.IsNotExist(err) {
		http.Error(w, "Fixture template not found: "+sourcePath, http.StatusNotFound)
		return
	}

	// Delete fixture contents EXCEPT .juggler (session runtime state)
	// The .juggler directory is actively used by the session manager and can't be deleted
	entries, err := os.ReadDir(fixtureDir)
	if err != nil && !os.IsNotExist(err) {
		http.Error(w, "ReadDir failed: "+err.Error(), http.StatusInternalServerError)
		return
	}
	for _, entry := range entries {
		if entry.Name() == ".juggler" {
			continue // Skip runtime state directory
		}
		entryPath := filepath.Join(fixtureDir, entry.Name())
		if err := os.RemoveAll(entryPath); err != nil {
			http.Error(w, "RemoveAll failed for "+entry.Name()+": "+err.Error(), http.StatusInternalServerError)
			return
		}
	}
	if err := os.MkdirAll(fixtureDir, 0o755); err != nil {
		http.Error(w, "MkdirAll failed: "+err.Error(), http.StatusInternalServerError)
		return
	}

	// Copy from template (same pattern as setupFixture in main.go)
	var copiedFiles []string
	err = filepath.Walk(sourcePath, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		relPath, _ := filepath.Rel(sourcePath, path)
		dstPath := filepath.Join(fixtureDir, relPath)
		if info.IsDir() {
			return os.MkdirAll(dstPath, info.Mode())
		}
		src, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		copiedFiles = append(copiedFiles, relPath)
		return os.WriteFile(dstPath, src, info.Mode())
	})
	if err != nil {
		http.Error(w, "Copy failed: "+err.Error(), http.StatusInternalServerError)
		return
	}

	// Return list of files for debugging
	handlers.WriteJSON(w, r, 0, map[string]any{
		"success": true,
		"files":   copiedFiles,
	})
}

// resolveFixturePath validates that relPath resolves inside fixtureDir and
// returns the absolute target. Shared by HandleDeleteFile / HandleMkdir so
// both use the same containment check.
func resolveFixturePath(fixtureDir, relPath string) (string, error) {
	if fixtureDir == "" || relPath == "" {
		return "", fmt.Errorf("dir and path query params required")
	}
	absDir, err := filepath.Abs(fixtureDir)
	if err != nil {
		return "", fmt.Errorf("invalid dir: %w", err)
	}
	absTarget, err := filepath.Abs(filepath.Join(absDir, relPath))
	if err != nil {
		return "", fmt.Errorf("invalid path: %w", err)
	}
	rel, err := filepath.Rel(absDir, absTarget)
	if err != nil || strings.HasPrefix(rel, "..") || rel == ".." {
		return "", fmt.Errorf("path is outside fixture dir")
	}
	return absTarget, nil
}

// HandleDeleteFile removes a path (file or directory) within a fixture dir.
// Used by the integration test runner to wipe the per-test subfolder on
// teardown — `rm -rf ${fixtureDir}/${testDir}`. Path-traversal guarded: the
// target must resolve under fixtureDir.
func (api *TestAPI) HandleDeleteFile(w http.ResponseWriter, r *http.Request) {
	absTarget, err := resolveFixturePath(r.URL.Query().Get("dir"), r.URL.Query().Get("path"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := os.RemoveAll(absTarget); err != nil {
		http.Error(w, "RemoveAll failed: "+err.Error(), http.StatusInternalServerError)
		return
	}
	handlers.WriteJSON(w, r, 0, map[string]any{"success": true})
}

// HandleDumpTape returns the per-worker event tape for the given
// conversation, serialised as JSON. Used by the integration test runner's
// failure-message builder to splice worker-side events into the failure
// block. Tracing is enabled via JUGGLER_TRACE on the server; when off, the
// dump is an empty list (no diagnostic spam in production builds).
func (api *TestAPI) HandleDumpTape(w http.ResponseWriter, r *http.Request) {
	convID := r.URL.Query().Get("convId")
	if convID == "" {
		http.Error(w, "convId query param required", http.StatusBadRequest)
		return
	}
	var entries any
	if api.tapeDumper != nil {
		entries = api.tapeDumper(convID)
	}
	if entries == nil {
		entries = []any{}
	}
	handlers.WriteJSON(w, r, 0, map[string]any{"entries": entries})
}

// HandleMkdir creates a directory (mkdir -p) within a fixture dir. Used by
// the integration test runner to prepare a per-test subfolder before the
// test body runs. Path-traversal guarded the same way as delete-file.
func (api *TestAPI) HandleMkdir(w http.ResponseWriter, r *http.Request) {
	absTarget, err := resolveFixturePath(r.URL.Query().Get("dir"), r.URL.Query().Get("path"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := os.MkdirAll(absTarget, 0o755); err != nil {
		http.Error(w, "MkdirAll failed: "+err.Error(), http.StatusInternalServerError)
		return
	}
	handlers.WriteJSON(w, r, 0, map[string]any{"success": true})
}
