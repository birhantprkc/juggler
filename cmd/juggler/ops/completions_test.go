//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// buildCompletionTree lays out a small project under a temp dir for the
// completion tests and returns its root. The names are chosen so a query can
// match as a root prefix, a root substring, a nested prefix, and a nested
// substring simultaneously.
func buildCompletionTree(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	for _, p := range []string{
		"database.txt",          // root: name starts with "data"
		"my_database.go",        // root: name CONTAINS "data" (no prefix)
		"src/deep/datafile.js",  // nested: name starts with "data"
		"src/other/has_data.md", // nested: name CONTAINS "data"
		"unrelated.txt",
	} {
		full := filepath.Join(root, p)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func completionPaths(t *testing.T, workingDir, query string) []string {
	t.Helper()
	res, err := CompleteFiles(context.Background(), workingDir, query, 20)
	if err != nil {
		t.Fatalf("CompleteFiles(%q) error: %v", query, err)
	}
	paths := make([]string, len(res))
	for i, m := range res {
		paths[i] = m.Path
	}
	return paths
}

func hasPath(paths []string, want string) bool {
	for _, p := range paths {
		if p == want {
			return true
		}
	}
	return false
}

// TestCompleteFiles_UnqualifiedQueryFindsNestedSubstrings is the regression
// guard for the "@data" picker: an unqualified query (no slash) of at least
// four characters must surface files anywhere in the tree whose basename
// CONTAINS the query, not merely root-level entries that start with it.
func TestCompleteFiles_UnqualifiedQueryFindsNestedSubstrings(t *testing.T) {
	root := buildCompletionTree(t)

	paths := completionPaths(t, root, "data")
	for _, want := range []string{
		"database.txt",          // root prefix match
		"my_database.go",        // root substring match
		"src/deep/datafile.js",  // nested prefix match
		"src/other/has_data.md", // nested substring match
	} {
		if !hasPath(paths, want) {
			t.Errorf("query %q: expected %q in results, got %v", "data", want, paths)
		}
	}
}

// TestCompleteFiles_PureSubstringQuery checks a query that matches only as an
// interior substring (never a prefix of any basename) still finds files.
func TestCompleteFiles_PureSubstringQuery(t *testing.T) {
	root := buildCompletionTree(t)

	paths := completionPaths(t, root, "taba") // "daTABAse"
	if !hasPath(paths, "database.txt") {
		t.Errorf("query %q: expected database.txt via substring match, got %v", "taba", paths)
	}
}

// TestCompleteFiles_FourCharQueryTriggersRecursiveSearch pins the lower bound
// of the recursive search at four characters.
func TestCompleteFiles_FourCharQueryTriggersRecursiveSearch(t *testing.T) {
	root := buildCompletionTree(t)

	paths := completionPaths(t, root, "data")
	if !hasPath(paths, "src/deep/datafile.js") {
		t.Errorf("query %q: expected nested datafile.js, got %v", "data", paths)
	}
}

// TestCompleteFiles_ShortQueryStaysPrefixOnly keeps a sub-four-character query
// from triggering a noisy tree-wide walk: only the current-directory prefix
// scan applies, so nested matches are absent.
func TestCompleteFiles_ShortQueryStaysPrefixOnly(t *testing.T) {
	root := buildCompletionTree(t)

	paths := completionPaths(t, root, "dat") // 3 chars — below the threshold
	if hasPath(paths, "src/deep/datafile.js") {
		t.Errorf("query %q: short query should not trigger recursive walk, got %v", "dat", paths)
	}
	if !hasPath(paths, "database.txt") {
		t.Errorf("query %q: expected root prefix match database.txt, got %v", "dat", paths)
	}
}

// TestCompleteFiles_QualifiedQuerySkipsRecursiveSearch confirms a query with a
// slash is treated as a directory navigation, not a tree-wide name search.
func TestCompleteFiles_QualifiedQuerySkipsRecursiveSearch(t *testing.T) {
	root := buildCompletionTree(t)

	paths := completionPaths(t, root, "src/")
	if hasPath(paths, "src/other/has_data.md") {
		t.Errorf("qualified query should list only direct children, got %v", paths)
	}
	if !hasPath(paths, "src/deep/") {
		t.Errorf("qualified query should list direct child dir src/deep/, got %v", paths)
	}
}
