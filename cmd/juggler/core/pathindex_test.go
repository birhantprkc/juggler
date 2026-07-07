//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"testing"
)

// newTestIndex builds an index from paths and ensures it is torn down.
func newTestIndex(t *testing.T, paths []string) *PathIndex {
	t.Helper()
	ix := newPathIndex(paths, false)
	t.Cleanup(ix.close)
	return ix
}

func searchPaths(ix *PathIndex, query string, limit int) []string {
	res := ix.Search(query, limit)
	out := make([]string, len(res))
	for i, m := range res {
		out[i] = m.Path
	}
	return out
}

func contains(paths []string, want string) bool {
	for _, p := range paths {
		if p == want {
			return true
		}
	}
	return false
}

func indexOf(paths []string, want string) int {
	for i, p := range paths {
		if p == want {
			return i
		}
	}
	return -1
}

// TestPathIndex_BasenameSubstringOnly is the precision guard: only files whose
// BASENAME contains the query (contiguously) are returned. Files that match
// merely in a directory segment, or only as a scattered subsequence, must be
// excluded — otherwise a long query pads the menu with noise.
func TestPathIndex_BasenameSubstringOnly(t *testing.T) {
	ix := newTestIndex(t, []string{
		"status.go",               // basename contains "status" → included
		"lib/has_status_here.txt", // basename contains "status" → included
		"status/notes.md",         // "status" only in the dir part → EXCLUDED
		"s/t/a/tus_x/thing.go",    // "status" only as a path subsequence → EXCLUDED
	})

	got := searchPaths(ix, "status", 20)
	if !contains(got, "status.go") || !contains(got, "lib/has_status_here.txt") {
		t.Fatalf("expected both basename matches, got %v", got)
	}
	if contains(got, "status/notes.md") {
		t.Errorf("dir-only match must be excluded (basename lacks the query): %v", got)
	}
	if contains(got, "s/t/a/tus_x/thing.go") {
		t.Errorf("subsequence-only match must be excluded: %v", got)
	}
	if len(got) != 2 {
		t.Errorf("expected exactly the 2 basename matches, got %v", got)
	}
}

// TestPathIndex_BasenameOffset checks that an earlier match offset in the
// basename ranks higher.
func TestPathIndex_BasenameOffset(t *testing.T) {
	ix := newTestIndex(t, []string{
		"web/js/components/git-status-card.js", // "card" at offset 11
		"cardboard.md",                         // "card" at offset 0
	})

	got := searchPaths(ix, "card", 20)
	if indexOf(got, "cardboard.md") == -1 || indexOf(got, "web/js/components/git-status-card.js") == -1 {
		t.Fatalf("expected both card matches, got %v", got)
	}
	if indexOf(got, "cardboard.md") > indexOf(got, "web/js/components/git-status-card.js") {
		t.Errorf("earlier basename offset should rank first: %v", got)
	}
}

// TestPathIndex_DeepFileRegression is the original bug: a deeply nested file
// whose basename contains a near-unique substring must be found and ranked
// first, regardless of tree shape or depth.
func TestPathIndex_DeepFileRegression(t *testing.T) {
	paths := []string{"a.js", "b.js", "src/status.go", "cardboard.md"}
	// Bury the target deep and after many siblings — a DFS budget would miss it.
	for i := 0; i < 5000; i++ {
		paths = append(paths, "vendor/pkg/x/deep.go")
	}
	paths = append(paths, "web/js/components/git/git-status-card.js")

	ix := newTestIndex(t, paths)

	got := searchPaths(ix, "git-status", 20)
	if len(got) == 0 || got[0] != "web/js/components/git/git-status-card.js" {
		t.Fatalf("expected git-status-card.js ranked first, got %v", got)
	}
}

// TestPathIndex_NoSubsequenceNoise locks out fuzzy/subsequence matching: a
// query whose letters appear only as a scattered subsequence (never a
// contiguous run in the basename) must return nothing. This is the direct guard
// for the "@git-status- returned 20 unrelated files" regression.
func TestPathIndex_NoSubsequenceNoise(t *testing.T) {
	ix := newTestIndex(t, []string{
		"git-status-card.js",
		"gui/icons/thumbs.svg",     // g,u,i... scattered — must NOT match "gui-s..."
		"generic/utils/session.go", // contains g,e,n... letters of a fuzzy query
	})

	// "gsc" matches "git-status-card" only as a subsequence, never contiguously.
	if got := searchPaths(ix, "gsc", 20); len(got) != 0 {
		t.Errorf("subsequence query must return nothing, got %v", got)
	}
	// The exact contiguous substring still works and is the only result.
	got := searchPaths(ix, "git-status-", 20)
	if len(got) != 1 || got[0] != "git-status-card.js" {
		t.Errorf("expected only the contiguous basename match, got %v", got)
	}
}

// TestPathIndex_DirTrailingSlash checks directories are matched and reported
// with a trailing slash and IsDir set.
func TestPathIndex_DirTrailingSlash(t *testing.T) {
	ix := newTestIndex(t, []string{"srclib/", "srclib/file.go"})

	res := ix.Search("srclib", 20)
	var sawDir bool
	for _, m := range res {
		if m.Path == "srclib/" {
			sawDir = true
			if !m.IsDir {
				t.Errorf("srclib/ should have IsDir=true")
			}
		}
	}
	if !sawDir {
		t.Errorf("expected srclib/ directory match, got %v", res)
	}
}

// TestPathIndex_InsertRemove checks live event upkeep, including subtree removal
// when a directory is deleted.
func TestPathIndex_InsertRemove(t *testing.T) {
	ix := newTestIndex(t, []string{"keep.go"})

	ix.add("newpkg/")
	ix.add("newpkg/thing.go")
	got := searchPaths(ix, "thing", 20)
	if !contains(got, "newpkg/thing.go") {
		t.Fatalf("inserted path not found: %v", got)
	}

	// Removing the directory drops it and everything beneath it.
	ix.del("newpkg")
	got = searchPaths(ix, "thing", 20)
	if contains(got, "newpkg/thing.go") {
		t.Errorf("subtree not removed on dir delete: %v", got)
	}
	got = searchPaths(ix, "newpkg", 20)
	if len(got) != 0 {
		t.Errorf("expected dir and subtree gone, got %v", got)
	}
}

// TestPathIndex_CapRejectsInserts checks that once the index is at capacity,
// further inserts are rejected (bounded footprint).
func TestPathIndex_CapRejectsInserts(t *testing.T) {
	paths := make([]string, maxIndexedPaths)
	for i := range paths {
		paths[i] = "pad/filler.go" // none match the probe query below
	}
	ix := newTestIndex(t, paths)

	ix.add("zzq-unique-file.go")
	got := searchPaths(ix, "zzq-unique", 20)
	if len(got) != 0 {
		t.Errorf("insert past cap should be rejected, got %v", got)
	}
}

// TestPathIndex_SearchAfterCloseIsSafe checks a search on a stopped index
// returns nil rather than deadlocking.
func TestPathIndex_SearchAfterCloseIsSafe(t *testing.T) {
	ix := newPathIndex([]string{"a.go"}, false)
	ix.close()
	if got := ix.Search("a", 20); got != nil {
		t.Errorf("expected nil from stopped index, got %v", got)
	}
}
