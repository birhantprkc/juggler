//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"juggler/cmd/juggler/server/handlers"
	"juggler/internal/logpaths"
)

// maxInitialLogBytes caps the first read of a log file so opening a large,
// long-lived log tails the most recent window rather than dumping megabytes
// into the viewer. The incremental (offset-based) reads that follow are
// uncapped — they only ever return the bytes appended since the last poll.
const maxInitialLogBytes = 256 * 1024

// logFileInfo describes one log file surfaced in the Logs settings page.
type logFileInfo struct {
	Name     string `json:"name"`     // bare filename, e.g. "server.log"
	Path     string `json:"path"`     // absolute path (for the copy / reveal controls)
	Group    string `json:"group"`    // "server" | "conversations" | "app"
	Size     int64  `json:"size"`     // bytes
	Modified int64  `json:"modified"` // unix millis of last write
}

// logWindow is one contiguous slice of a log file returned by the content
// endpoint, plus the metadata the client needs to keep tailing.
type logWindow struct {
	Path     string `json:"path"`
	From     int64  `json:"from"`     // byte offset the returned content starts at
	Size     int64  `json:"size"`     // end offset of the content — the client's next offset
	Content  string `json:"content"`  // bytes [From, Size)
	Replaced bool   `json:"replaced"` // true when this window does not continue the requested offset (fresh tail / post-rotation reset), so the client must replace rather than append
}

// setupLogsRoutes registers the read-only /api/logs endpoints that back the
// Logs settings page.
func (s *Server) setupLogsRoutes() {
	api := s.router.PathPrefix("/api").Subrouter()
	api.HandleFunc("/logs", s.handleListLogs).Methods("GET")
	api.HandleFunc("/logs/content", s.handleLogContent).Methods("GET")
}

// handleListLogs returns the log files for the current session: this project
// server's own logs (server.log, server.stderr.log, and each per-conversation
// log) plus the shared desktop app.log. Files that don't exist yet are omitted.
func (s *Server) handleListLogs(w http.ResponseWriter, r *http.Request) {
	handlers.WriteJSON(w, r, 0, map[string]any{
		"logDir": logpaths.LogDir(),
		"files":  listSessionLogs(s.ProjectPath()),
	})
}

// handleLogContent streams a byte window of one log file. The client passes the
// offset it has already consumed; the handler returns everything appended since
// (or a capped tail on the first read), so the viewer can follow a growing log
// with cheap incremental polls. The path must resolve inside the log directory.
func (s *Server) handleLogContent(w http.ResponseWriter, r *http.Request) {
	abs, ok := resolveLogPath(r.URL.Query().Get("path"))
	if !ok {
		handlers.WriteError(w, r, http.StatusForbidden, "path is not a Juggler log file")
		return
	}
	offset, _ := strconv.ParseInt(r.URL.Query().Get("offset"), 10, 64)
	win, err := readLogWindow(abs, offset, maxInitialLogBytes)
	if err != nil {
		handlers.WriteError(w, r, http.StatusNotFound, "log file is unavailable")
		return
	}
	handlers.WriteJSON(w, r, 0, win)
}

// resolveLogPath cleans raw and confirms it names an existing regular file
// inside the platform log directory. It is the security gate for the content
// endpoint: any path that lexically escapes LogDir() (via "..") or is not a
// regular file is rejected, so the endpoint can never serve arbitrary files.
func resolveLogPath(raw string) (string, bool) {
	if raw == "" {
		return "", false
	}
	abs, err := filepath.Abs(filepath.Clean(raw))
	if err != nil {
		return "", false
	}
	dir, err := filepath.Abs(logpaths.LogDir())
	if err != nil {
		return "", false
	}
	rel, err := filepath.Rel(dir, abs)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return "", false
	}
	info, err := os.Stat(abs)
	if err != nil || !info.Mode().IsRegular() {
		return "", false
	}
	return abs, true
}

// listSessionLogs gathers the log files a user would want for the current
// session: the project server's own folder (server.log, server.stderr.log, and
// every per-conversation log) and the shared desktop app.log. Files that don't
// exist yet are skipped, so the list reflects what is actually on disk.
func listSessionLogs(projectPath string) []logFileInfo {
	files := make([]logFileInfo, 0, 4)

	projDir := logpaths.ProjectLogDir(projectPath)
	files = appendLogFile(files, filepath.Join(projDir, "server.log"), "server")
	files = appendLogFile(files, filepath.Join(projDir, "server.stderr.log"), "server")

	convDir := filepath.Join(projDir, "conversations")
	if entries, err := os.ReadDir(convDir); err == nil {
		names := make([]string, 0, len(entries))
		for _, e := range entries {
			if !e.IsDir() && strings.HasSuffix(e.Name(), ".log") {
				names = append(names, e.Name())
			}
		}
		sort.Strings(names)
		for _, n := range names {
			files = appendLogFile(files, filepath.Join(convDir, n), "conversations")
		}
	}

	files = appendLogFile(files, logpaths.AppLogPath(), "app")
	return files
}

// appendLogFile stats path and, when it is an existing regular file, appends a
// logFileInfo for it. Missing files are silently skipped so the caller only
// ever surfaces logs that are actually on disk.
func appendLogFile(files []logFileInfo, path, group string) []logFileInfo {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return files
	}
	return append(files, logFileInfo{
		Name:     filepath.Base(path),
		Path:     path,
		Group:    group,
		Size:     info.Size(),
		Modified: info.ModTime().UnixMilli(),
	})
}

// readLogWindow returns the slice of the file at path from the caller's offset
// to EOF. It powers incremental tailing:
//
//   - Normal poll (0 < offset <= size): returns bytes [offset, size); Replaced
//     is false, so the client appends them.
//   - First read (offset <= 0): returns the last maxInitial bytes (the whole
//     file when smaller); Replaced is true when the window was capped.
//   - Rotation/truncation (offset > size): the file shrank, so the caller's
//     offset is stale; resets to a fresh tail with Replaced true.
//
// Replaced is precisely "the returned window does not start where the caller
// asked", which is exactly when the client must replace rather than append. The
// returned bytes are sliced to what was actually read, so a file shrinking
// mid-read (rotation between the stat and the read) never yields trailing NULs.
func readLogWindow(path string, offset, maxInitial int64) (logWindow, error) {
	f, err := os.Open(path)
	if err != nil {
		return logWindow{}, err
	}
	defer func() { _ = f.Close() }()

	info, err := f.Stat()
	if err != nil {
		return logWindow{}, err
	}
	size := info.Size()

	start := offset
	if start < 0 || start > size {
		start = 0 // stale offset (first read or rotation) — re-window from a tail
	}
	if start == 0 && size > maxInitial {
		start = size - maxInitial
	}

	buf := make([]byte, size-start)
	n := 0
	if len(buf) > 0 {
		n, err = f.ReadAt(buf, start)
		if err != nil && err != io.EOF {
			return logWindow{}, err
		}
	}

	return logWindow{
		Path:     path,
		From:     start,
		Size:     start + int64(n),
		Content:  string(buf[:n]),
		Replaced: start != offset,
	}, nil
}
