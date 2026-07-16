//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"path/filepath"
	"testing"
)

// TestPathScope_AuthorizeOutOfScopeWrite pins the write/edit defence-in-depth
// boundary: in-scope paths need no approval, out-of-scope paths are refused
// without an explicit approval flag and admitted with it, and an allowed root
// widens the in-scope set so a granted location needs no flag.
func TestPathScope_AuthorizeOutOfScopeWrite(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()

	san := func(p string) string {
		abs, err := SanitizeAbsolutePath(root, p)
		if err != nil {
			t.Fatalf("sanitize %q: %v", p, err)
		}
		return abs
	}

	scope := NewPathScope(root, nil)

	// In-scope new file (missing parents) — authorized without approval.
	inScope := filepath.Join(root, "a", "b", "new.txt")
	if err := scope.AuthorizeOutOfScopeWrite(san(inScope), inScope, "write", false); err != nil {
		t.Errorf("in-scope write should be authorized without approval: %v", err)
	}

	outFile := filepath.Join(outside, "x.txt")
	outAbs := san(outFile)

	// Out-of-scope without approval — rejected.
	if err := scope.AuthorizeOutOfScopeWrite(outAbs, outFile, "write", false); err == nil {
		t.Errorf("out-of-scope write without approval should be rejected")
	}
	// Out-of-scope WITH approval — authorized.
	if err := scope.AuthorizeOutOfScopeWrite(outAbs, outFile, "write", true); err != nil {
		t.Errorf("approved out-of-scope write should be authorized: %v", err)
	}

	// Widening the scope with an allowed root makes the same path in-scope, so
	// no approval flag is needed.
	widened := NewPathScope(root, []string{outside})
	if err := widened.AuthorizeOutOfScopeWrite(outAbs, outFile, "write", false); err != nil {
		t.Errorf("write inside an allowed root should be authorized without approval: %v", err)
	}
}
