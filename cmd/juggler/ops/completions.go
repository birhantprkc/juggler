//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
)

// CompletePath returns filesystem entries whose names match the typed prefix.
// Unlike CompleteFiles, it is NOT restricted to the project directory and
// accepts absolute paths directly (tilde is expanded here).
// query may be an absolute path (starting with "/" or "~"), or a relative path
// (starting with "." or ".."), which is resolved against basePath.
// If basePath is empty the user's home directory is used as the base.
func CompletePath(ctx context.Context, query, basePath string, limit int) ([]FileMatch, error) {
	if limit <= 0 {
		limit = 20
	}

	// Expand leading ~ to home directory.
	if query == "~" || strings.HasPrefix(query, "~/") || strings.HasPrefix(query, `~\`) {
		if home, err := os.UserHomeDir(); err == nil {
			query = home + query[1:]
		}
	}

	// Resolve relative paths (starting with "." or "..") against basePath.
	if strings.HasPrefix(query, ".") {
		base := basePath
		if base == "" {
			base, _ = os.UserHomeDir()
		}
		// Separate the typed name fragment after the last slash so we can
		// reconstruct the query as an absolute path.
		var relDir, frag string
		if strings.HasSuffix(query, "/") {
			relDir = query
		} else if idx := strings.LastIndex(query, "/"); idx >= 0 {
			relDir = query[:idx+1]
			frag = query[idx+1:]
		} else {
			relDir = query + "/"
		}
		absDir := filepath.Clean(filepath.Join(base, relDir))
		query = absDir + "/" + frag
	}

	// Split into the directory to read and the name prefix to filter by.
	var dirPart, namePrefix string
	if strings.HasSuffix(query, "/") {
		dirPart = strings.TrimSuffix(query, "/")
		if dirPart == "" {
			dirPart = "/"
		}
	} else if idx := strings.LastIndex(query, "/"); idx >= 0 {
		dirPart = query[:idx]
		if dirPart == "" {
			dirPart = "/"
		}
		namePrefix = query[idx+1:]
	} else {
		// No slash and not a relative path — nothing useful to complete yet.
		return nil, nil
	}

	entries, err := os.ReadDir(dirPart)
	if err != nil {
		return nil, err
	}

	var dirs, files []FileMatch
	lowerPrefix := strings.ToLower(namePrefix)

	for _, entry := range entries {
		name := entry.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}
		if lowerPrefix != "" && !strings.HasPrefix(strings.ToLower(name), lowerPrefix) {
			continue
		}

		var fullPath string
		if dirPart == "/" {
			fullPath = "/" + name
		} else {
			fullPath = filepath.Join(dirPart, name)
		}

		if entry.IsDir() {
			dirs = append(dirs, FileMatch{Path: fullPath + "/", IsDir: true})
		} else {
			files = append(files, FileMatch{Path: fullPath, IsDir: false})
		}

		select {
		case <-ctx.Done():
			return append(dirs, files...), nil
		default:
		}
	}

	results := make([]FileMatch, 0, len(dirs)+len(files))
	results = append(results, dirs...)
	results = append(results, files...)
	if len(results) > limit {
		results = results[:limit]
	}
	return results, nil
}

// FileMatch is a single file completion result.
// Directories have a trailing "/" in Path.
type FileMatch struct {
	Path  string `json:"path"`
	IsDir bool   `json:"isDir"`
}

// excludedDirs are directories skipped during completion traversal.
var excludedDirs = []string{
	"node_modules", "vendor", "dist", "build", ".git",
}

// CompleteFiles returns file and directory paths whose names start with the
// name component of query, within the directory component of query.
// Directories are returned first (with trailing "/"), then files, both
// case-insensitively sorted. Results are capped at limit.
// The call returns early (with nil, nil) if ctx is cancelled.
func CompleteFiles(ctx context.Context, workingDir, query string, limit int) ([]FileMatch, error) {
	if limit <= 0 {
		limit = 20
	}

	// Split query into directory part and name prefix.
	// "src/ma"  → dirPart="src",  namePrefix="ma"
	// "src/"    → dirPart="src",  namePrefix=""
	// "ma"      → dirPart=".",    namePrefix="ma"
	// ""        → dirPart=".",    namePrefix=""
	var dirPart, namePrefix string
	if strings.HasSuffix(query, "/") {
		dirPart = strings.TrimSuffix(query, "/")
		if dirPart == "" {
			dirPart = "/"
		}
		namePrefix = ""
	} else if idx := strings.LastIndex(query, "/"); idx >= 0 {
		dirPart = query[:idx]
		if dirPart == "" {
			dirPart = "/"
		}
		namePrefix = query[idx+1:]
	} else {
		dirPart = "."
		namePrefix = query
	}

	// Resolve dirPart to an absolute directory to read.
	// Absolute paths are used as-is; relative paths (including "..") are
	// resolved from workingDir so the user can navigate freely.
	var absDir string
	if filepath.IsAbs(dirPart) {
		absDir = filepath.Clean(dirPart)
	} else {
		absDir = filepath.Clean(filepath.Join(workingDir, dirPart))
	}

	entries, err := os.ReadDir(absDir)
	if err != nil {
		return nil, err
	}

	var dirs, files []FileMatch
	lowerPrefix := strings.ToLower(namePrefix)

	for _, entry := range entries {
		name := entry.Name()

		// Skip hidden entries and excluded dirs
		if strings.HasPrefix(name, ".") {
			continue
		}
		if entry.IsDir() && slices.Contains(excludedDirs, name) {
			continue
		}

		// Case-insensitive prefix match
		if lowerPrefix != "" && !strings.HasPrefix(strings.ToLower(name), lowerPrefix) {
			continue
		}

		// Build result path using the same dirPart the user typed, so the
		// completion preserves the form they entered (relative or absolute).
		// Always join with "/" — completion queries are forward-slash UI
		// strings, so filepath.Join's OS separator would corrupt them on
		// Windows (src\deep/ instead of src/deep/).
		var relPath string
		switch dirPart {
		case ".":
			relPath = name
		case "/":
			relPath = "/" + name
		default:
			relPath = dirPart + "/" + name
		}

		if entry.IsDir() {
			dirs = append(dirs, FileMatch{Path: relPath + "/", IsDir: true})
		} else {
			files = append(files, FileMatch{Path: relPath, IsDir: false})
		}
	}

	// Dirs first, then files
	results := make([]FileMatch, 0, len(dirs)+len(files))
	results = append(results, dirs...)
	results = append(results, files...)

	if len(results) > limit {
		results = results[:limit]
	}

	// Recursive fuzzy search: unqualified query (no slash), at least 4 chars.
	// Finds files/dirs anywhere in the tree whose basename CONTAINS the prefix
	// (not just starts with it), appended after the prefix-scan results (which
	// take priority). This is what makes "@foobar" surface nested files like
	// src/deep/foobar.go, not just root entries starting with "foobar". Shorter
	// queries are skipped — tree-wide they match too much to be useful.
	if !filepath.IsAbs(dirPart) && !strings.Contains(query, "/") && len(namePrefix) >= 4 {
		existing := make(map[string]bool, len(results))
		for _, m := range results {
			existing[m.Path] = true
		}
		fuzzy := fuzzySearchFiles(ctx, workingDir, namePrefix, limit, 5000)
		for _, m := range fuzzy {
			if len(results) >= limit {
				break
			}
			if !existing[m.Path] {
				results = append(results, m)
			}
		}
	}

	return results, nil
}

// fuzzySearchFiles does a depth-limited recursive walk from workingDir looking
// for files and directories whose basename contains namePrefix
// (case-insensitive). Results are ordered: shallower paths first, directories
// before files at the same depth, then alphabetically.
// budget caps the total number of directory entries scanned to stay fast.
// The walk stops immediately if ctx is cancelled.
func fuzzySearchFiles(ctx context.Context, workingDir, namePrefix string, limit, budget int) []FileMatch {
	lower := strings.ToLower(namePrefix)

	type scoredMatch struct {
		FileMatch
		depth int
	}

	var matches []scoredMatch
	scanned := 0

	var walk func(dir, relDir string, depth int)
	walk = func(dir, relDir string, depth int) {
		if scanned >= budget || len(matches) >= limit*4 || depth > 8 {
			return
		}
		// Stop if the HTTP request was cancelled (client moved on to a newer query).
		select {
		case <-ctx.Done():
			return
		default:
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			return
		}
		scanned += len(entries)

		for _, entry := range entries {
			name := entry.Name()
			if strings.HasPrefix(name, ".") {
				continue
			}
			if entry.IsDir() && slices.Contains(excludedDirs, name) {
				continue
			}

			var relPath string
			if relDir == "." {
				relPath = name
			} else {
				relPath = relDir + "/" + name
			}

			if strings.Contains(strings.ToLower(name), lower) {
				path := relPath
				if entry.IsDir() {
					path += "/"
				}
				matches = append(matches, scoredMatch{FileMatch{Path: path, IsDir: entry.IsDir()}, depth})
			}

			if entry.IsDir() {
				walk(dir+"/"+name, relPath, depth+1)
			}
		}
	}

	walk(workingDir, ".", 0)

	sort.Slice(matches, func(i, j int) bool {
		ri, rj := matches[i], matches[j]
		if ri.depth != rj.depth {
			return ri.depth < rj.depth
		}
		if ri.IsDir != rj.IsDir {
			return ri.IsDir
		}
		return ri.Path < rj.Path
	})

	out := make([]FileMatch, len(matches))
	for i, m := range matches {
		out[i] = m.FileMatch
	}
	return out
}
