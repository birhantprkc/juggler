//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"context"
	"os"
	"path/filepath"
	"strings"

	"juggler/internal/skipdirs"
)

// PathSearcher is the subset of the file index that completion needs. It is an
// interface so this package does not import core (which would be an import
// cycle — core imports ops for FileMatch); core's *PathIndex satisfies it.
type PathSearcher interface {
	Search(query string, limit int) []FileMatch
}

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

// CompleteFiles returns file and directory paths whose names start with the
// name component of query, within the directory component of query.
// Directories are returned first (with trailing "/"), then files, both
// case-insensitively sorted. Results are capped at limit.
//
// For an unqualified query of at least four characters, the whole-tree lookup
// is delegated to searcher (the file-path index), which finds files anywhere in
// the project whose basename contains the query as a contiguous substring,
// instantly and without re-walking the tree. When searcher is nil (no project /
// no watcher) only the current-directory prefix scan applies.
// The call returns early (with nil, nil) if ctx is cancelled.
func CompleteFiles(ctx context.Context, workingDir, query string, limit int, searcher PathSearcher) ([]FileMatch, error) {
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
		if entry.IsDir() && skipdirs.Skip(name) {
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

	// Unqualified query (no slash), at least 4 chars: hand the whole-tree
	// lookup to the path index. It finds files/dirs anywhere in the project
	// whose basename contains (or subsequence-matches) the query, ranked by
	// relevance — instantly, with no per-keystroke tree walk. Shorter or
	// qualified queries stay on the prefix scan above. If there is no index
	// (no project / no watcher) the prefix-scan results are all we have.
	if searcher != nil && !filepath.IsAbs(dirPart) && !strings.Contains(query, "/") && len(namePrefix) >= 4 {
		if indexed := searcher.Search(namePrefix, limit); indexed != nil {
			return indexed, nil
		}
	}

	return results, nil
}
