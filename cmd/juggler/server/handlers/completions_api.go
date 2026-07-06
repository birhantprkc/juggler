//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"juggler/cmd/juggler/ops"
)

// CompletionsAPI handles file completion requests for the "@" mention UI.
// The working directory is read through a provider func so runtime project
// switches transparently retarget the search root.
type CompletionsAPI struct {
	pathProvider func() string
}

// NewCompletionsAPI creates a new CompletionsAPI handler. pathProvider must
// return the current project path on each call.
func NewCompletionsAPI(pathProvider func() string) *CompletionsAPI {
	return &CompletionsAPI{pathProvider: pathProvider}
}

// fileCompletionsResponse is the JSON response shape.
type fileCompletionsResponse struct {
	Results []ops.FileMatch `json:"results"`
}

// HandlePathCompletions handles GET /api/completions/path?q=<query>&limit=<n>
// Returns filesystem entries for an absolute path prefix. Unlike HandleFileCompletions,
// the results are NOT restricted to the current project directory.
func (a *CompletionsAPI) HandlePathCompletions(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query().Get("q")
	limit := 20
	if l := r.URL.Query().Get("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil && n > 0 && n <= 100 {
			limit = n
		}
	}

	results, err := ops.CompletePath(r.Context(), query, a.pathProvider(), limit)
	if err != nil {
		results = []ops.FileMatch{}
	}
	if results == nil {
		results = []ops.FileMatch{}
	}

	writeJSON(w, r, 0, fileCompletionsResponse{Results: results})
}

// pathExistsResponse is the JSON response shape for HandlePathExists.
type pathExistsResponse struct {
	Existing []string `json:"existing"`
}

// HandlePathExists handles GET /api/completions/exists?paths=p1&paths=p2 ...
// Returns the subset of supplied paths that resolve to an existing filesystem
// entry. Relative paths are resolved against the current project working dir;
// leading "~" is expanded to $HOME. Used by the @-mention parser to filter out
// stray "@word" tokens that look like identifiers, not file paths.
func (a *CompletionsAPI) HandlePathExists(w http.ResponseWriter, r *http.Request) {
	raw := r.URL.Query()["paths"]
	if len(raw) == 0 {
		writeJSON(w, r, 0, pathExistsResponse{Existing: []string{}})
		return
	}

	workingDir := a.pathProvider()
	existing := make([]string, 0, len(raw))
	for _, p := range raw {
		if p == "" {
			continue
		}
		abs := resolveForExists(p, workingDir)
		if abs == "" {
			continue
		}
		if _, err := os.Stat(abs); err == nil {
			existing = append(existing, p)
		}
	}
	writeJSON(w, r, 0, pathExistsResponse{Existing: existing})
}

// resolveForExists turns a user-supplied path into an absolute path for an
// os.Stat call. Empty string means "do not stat" (path was unresolvable).
func resolveForExists(p, workingDir string) string {
	if p == "~" || strings.HasPrefix(p, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return ""
		}
		if p == "~" {
			return home
		}
		return filepath.Join(home, p[2:])
	}
	if filepath.IsAbs(p) {
		return filepath.Clean(p)
	}
	if workingDir == "" {
		return ""
	}
	return filepath.Join(workingDir, p)
}

// HandleFileCompletions handles GET /api/completions/files?q=<query>&limit=<n>
func (a *CompletionsAPI) HandleFileCompletions(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query().Get("q")
	limit := 20
	if l := r.URL.Query().Get("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil && n > 0 && n <= 100 {
			limit = n
		}
	}

	workingDir := a.pathProvider()
	if workingDir == "" {
		writeJSON(w, r, 0, fileCompletionsResponse{Results: []ops.FileMatch{}})
		return
	}
	results, err := ops.CompleteFiles(r.Context(), workingDir, query, limit)
	if err != nil {
		// Return empty results on error — completions are best-effort
		results = []ops.FileMatch{}
	}
	if results == nil {
		results = []ops.FileMatch{}
	}

	writeJSON(w, r, 0, fileCompletionsResponse{Results: results})
}
