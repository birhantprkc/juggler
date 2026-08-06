//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"context"
	"os"
	"path/filepath"
	"strings"
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
		"scratch/notes.md",      // root dir intentionally omitted from fake index
		"web/components/file-mention-provider.js",
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

// fakeSearcher stands in for core.PathIndex (which this package cannot import
// without a cycle). It holds the whole tree and returns basename-substring
// matches, and records whether it was consulted.
type fakeSearcher struct {
	all   []FileMatch
	calls int
	lastQ string
}

func (f *fakeSearcher) Search(query string, limit int) []FileMatch {
	f.calls++
	f.lastQ = query
	q := strings.ToLower(query)
	out := make([]FileMatch, 0)
	for _, m := range f.all {
		base := strings.TrimSuffix(m.Path, "/")
		if i := strings.LastIndex(base, "/"); i >= 0 {
			base = base[i+1:]
		}
		if strings.Contains(strings.ToLower(base), q) {
			out = append(out, m)
			if len(out) >= limit {
				break
			}
		}
	}
	return out
}

// treeSearcher returns a fakeSearcher covering buildCompletionTree.
func treeSearcher() *fakeSearcher {
	return &fakeSearcher{all: []FileMatch{
		{Path: "database.txt"},
		{Path: "my_database.go"},
		{Path: "src/", IsDir: true},
		{Path: "src/deep/", IsDir: true},
		{Path: "src/deep/datafile.js"},
		{Path: "src/other/", IsDir: true},
		{Path: "src/other/has_data.md"},
		{Path: "web/", IsDir: true},
		{Path: "web/components/", IsDir: true},
		{Path: "web/components/file-mention-provider.js"},
		{Path: "unrelated.txt"},
	}}
}

func completionPaths(t *testing.T, workingDir, query string, searcher PathSearcher) []string {
	t.Helper()
	res, err := CompleteFiles(context.Background(), workingDir, query, 20, searcher)
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

// TestCompleteFiles_UnqualifiedQueryUsesIndex is the regression guard for the
// "@data" picker: an unqualified query (no slash) of at least four characters
// is answered by the index, surfacing files anywhere in the tree whose basename
// CONTAINS the query, not merely root-level entries that start with it.
func TestCompleteFiles_UnqualifiedQueryUsesIndex(t *testing.T) {
	root := buildCompletionTree(t)
	s := treeSearcher()

	paths := completionPaths(t, root, "data", s)
	if s.calls != 1 || s.lastQ != "data" {
		t.Fatalf("expected index consulted once with %q, got calls=%d lastQ=%q", "data", s.calls, s.lastQ)
	}
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

func TestCompleteFiles_RetainsRootPrefixMissingFromIndex(t *testing.T) {
	root := buildCompletionTree(t)
	s := treeSearcher()

	paths := completionPaths(t, root, "scratch", s)
	if s.calls != 1 || s.lastQ != "scratch" {
		t.Fatalf("expected index consulted once, got calls=%d lastQ=%q", s.calls, s.lastQ)
	}
	if !hasPath(paths, "scratch/") {
		t.Errorf("root prefix match omitted from index should be retained, got %v", paths)
	}
}

func TestCompleteFiles_FindsFilenameInsideIgnoredDirectory(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, ".gitignore"), []byte("scratch/\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "scratch", "disable-auto-refactoring.md")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	paths := completionPaths(t, root, "disable-auto", &fakeSearcher{})
	if !hasPath(paths, "scratch/disable-auto-refactoring.md") {
		t.Errorf("ignored nested filename should be found, got %v", paths)
	}
}

func TestSearchIgnoredCompletionPathsIsBounded(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, ".gitignore"), []byte("scratch/\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// All three match the query; the scan budget (2) is spent entering the
	// scratch dir (1) plus reading a single file (1), so at most one match is
	// collected regardless of the OS's directory iteration order.
	for _, rel := range []string{
		"scratch/disable-auto-01.md",
		"scratch/disable-auto-02.md",
		"scratch/disable-auto-03.md",
	} {
		path := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	matches := searchIgnoredCompletionPaths(context.Background(), root, "disable-auto", 20, 2)
	if len(matches) > 1 {
		t.Errorf("scan should stop at the entry bound (at most 1 of 3 matching files read), got %v", matches)
	}
}

func TestCompleteFiles_UnqualifiedDashedQueryUsesIndex(t *testing.T) {
	root := buildCompletionTree(t)
	s := treeSearcher()

	paths := completionPaths(t, root, "-pro", s)
	if s.calls != 1 || s.lastQ != "-pro" {
		t.Fatalf("expected index consulted once with dashed query, got calls=%d lastQ=%q", s.calls, s.lastQ)
	}
	if !hasPath(paths, "web/components/file-mention-provider.js") {
		t.Errorf("dashed query should find nested basename match, got %v", paths)
	}
}

// TestCompleteFiles_ShortQueryUsesIndex confirms short filename fragments search
// the whole tree just like longer unqualified queries.
func TestCompleteFiles_ShortQueryUsesIndex(t *testing.T) {
	root := buildCompletionTree(t)
	s := treeSearcher()

	paths := completionPaths(t, root, "dat", s)
	if s.calls != 1 || s.lastQ != "dat" {
		t.Fatalf("expected index consulted once with short query, got calls=%d lastQ=%q", s.calls, s.lastQ)
	}
	if !hasPath(paths, "src/deep/datafile.js") {
		t.Errorf("query %q: expected nested filename match, got %v", "dat", paths)
	}
}

// TestCompleteFiles_QualifiedQuerySkipsIndex confirms a query with a slash is
// treated as directory navigation (single-dir scan), not a tree-wide search.
func TestCompleteFiles_QualifiedQuerySkipsIndex(t *testing.T) {
	root := buildCompletionTree(t)
	s := treeSearcher()

	paths := completionPaths(t, root, "src/", s)
	if s.calls != 0 {
		t.Errorf("qualified query should not consult the index, got calls=%d", s.calls)
	}
	if hasPath(paths, "src/other/has_data.md") {
		t.Errorf("qualified query should list only direct children, got %v", paths)
	}
	if !hasPath(paths, "src/deep/") {
		t.Errorf("qualified query should list direct child dir src/deep/, got %v", paths)
	}
}

// TestCompleteFiles_NilSearcherFallsBackToPrefixScan checks that with no index
// available, an unqualified query still returns the current-directory prefix
// matches without error or panic.
func TestCompleteFiles_NilSearcherFallsBackToPrefixScan(t *testing.T) {
	root := buildCompletionTree(t)

	paths := completionPaths(t, root, "data", nil)
	if !hasPath(paths, "database.txt") {
		t.Errorf("nil searcher: expected root prefix match database.txt, got %v", paths)
	}
	if hasPath(paths, "src/deep/datafile.js") {
		t.Errorf("nil searcher: nested files require the index, got %v", paths)
	}
}
