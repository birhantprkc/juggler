//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration_test

import (
	"path/filepath"
	"testing"

	"juggler/cmd/juggler/core"
)

// convDirByID resolves a conversation id to its on-disk folder under the
// project's `.juggler/`. Resolution order:
//
//  1. core.ScanConvDirs (production layout `<name>--<conv_<id>>/`)
//  2. helpers.TestPathProvider's `test--<convID>/` (test layout)
//  3. Fallback to the predicted test-layout path so callers can pre-create
//     the folder when seeding fixtures (no test failure here — tests that
//     subsequently os.ReadFile a missing doc.yjs will fail with a clearer
//     "state file not created" message).
func convDirByID(t *testing.T, projectDir, convID string) string {
	t.Helper()
	jugglerDir := filepath.Join(projectDir, ".juggler")
	if idx, err := core.ScanConvDirs(jugglerDir); err == nil {
		if dir, ok := idx.ByID[convID]; ok {
			return dir
		}
	}
	return filepath.Join(jugglerDir, "test--"+convID)
}

// convDocPath returns the absolute path to a conversation's doc.yjs file.
func convDocPath(t *testing.T, projectDir, convID string) string {
	t.Helper()
	return filepath.Join(convDirByID(t, projectDir, convID), "doc.yjs")
}
