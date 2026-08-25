//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package app

import (
	"os"
	"path/filepath"
	"testing"
)

// examplesDir is the published example-extension tree, relative to this package.
const examplesDir = "../../../examples/extensions"

// TestExampleExtensionsAreValid runs the real admission check over every
// published example. The examples are documentation that users copy, and the
// failure mode of documentation is drifting out of step with the code that
// serves it: a renamed provides key or a bumped engine API would otherwise leave
// a broken template in the tree with nothing to report it. Running the same
// validateExtensionDir the CLI and server use means an example that would not
// load is a test failure here rather than a bug report from an author.
func TestExampleExtensionsAreValid(t *testing.T) {
	entries, err := os.ReadDir(examplesDir)
	if err != nil {
		t.Fatalf("read examples dir: %v", err)
	}

	found := 0
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		found++
		t.Run(entry.Name(), func(t *testing.T) {
			dir := filepath.Join(examplesDir, entry.Name())
			manifest, warnings, err := validateExtensionDir(dir)
			if err != nil {
				t.Fatalf("example %s would not load: %v", entry.Name(), err)
			}
			// An example carrying a warning teaches the warned-about habit, so
			// hold them to the standard we ask authors to meet.
			if len(warnings) > 0 {
				t.Errorf("example %s validates with warnings: %v", entry.Name(), warnings)
			}
			if manifest.License == "" {
				t.Errorf("example %s declares no license", entry.Name())
			}
			if _, err := os.Stat(filepath.Join(dir, "README.md")); err != nil {
				t.Errorf("example %s has no README.md: %v", entry.Name(), err)
			}
		})
	}

	// Guard against the directory being moved or emptied without this test
	// noticing: with no subdirectories the loop above passes vacuously.
	if found == 0 {
		t.Fatalf("no example extensions found under %s", examplesDir)
	}
}
