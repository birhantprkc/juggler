//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build windows

package ops

import (
	"path/filepath"
	"strings"
	"testing"
)

// TestWithinScope_WindowsCaseInsensitive verifies the write-scope containment
// check folds case on Windows (NTFS is case-insensitive), so a differently-cased
// spelling of an in-project path is in scope while an unrelated path is not.
func TestWithinScope_WindowsCaseInsensitive(t *testing.T) {
	root := t.TempDir() // e.g. C:\Users\...\TestXXXX
	scope := NewPathScope(root, nil)

	// Re-case the drive letter and a segment; still the same location on NTFS.
	recased := strings.ToUpper(root[:1]) + strings.ToLower(root[1:])
	target := filepath.Join(recased, "Sub", "File.txt")
	if !scope.withinScope(target) {
		t.Errorf("case-insensitive in-project path should be in scope: root=%q target=%q", root, target)
	}

	// A sibling directory is out of scope regardless of case.
	sibling := root + "-other"
	if scope.withinScope(filepath.Join(sibling, "file.txt")) {
		t.Errorf("unrelated path must be out of scope: %q", sibling)
	}
}
