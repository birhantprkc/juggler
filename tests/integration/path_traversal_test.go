//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration_test

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"juggler/cmd/juggler/ops"
	"juggler/tests/helpers"
)

// absoluteOutsidePath returns a path that exists outside any project directory
// Uses platform-appropriate paths
func absoluteOutsidePath() string {
	if runtime.GOOS == "windows" {
		return "C:\\Windows"
	}
	return "/etc"
}

// TestPathTraversalReadFile ensures read operations cannot escape project directory
func TestPathTraversalReadFile(t *testing.T) {
	// Create temporary project directory
	projectDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(projectDir)

	// Create a file inside project
	testFile := filepath.Join(projectDir, "test.txt")
	helpers.WriteFile(t, testFile, []byte("secret content"))

	// Create a file outside project
	parentDir := filepath.Dir(projectDir)
	outsideFile := filepath.Join(parentDir, "outside.txt")
	helpers.WriteFile(t, outsideFile, []byte("should not access this"))
	defer os.Remove(outsideFile)

	readOps := ops.NewFileOperations(ops.NewPathScope(projectDir, nil))

	tests := []struct {
		name        string
		path        string
		shouldError bool
		description string
	}{
		{
			name:        "Absolute path outside project",
			path:        outsideFile,
			shouldError: true,
			description: "Absolute path to file outside project should be rejected",
		},
		{
			name:        "Relative path traversal with ..",
			path:        "../outside.txt",
			shouldError: true,
			description: "Relative path using .. to escape project should be rejected",
		},
		{
			name:        "Multiple .. traversal",
			path:        "../../etc/passwd",
			shouldError: true,
			description: "Multiple .. segments to escape should be rejected",
		},
		{
			name:        "Hidden traversal with extra segments",
			path:        "foo/../../../etc/passwd",
			shouldError: true,
			description: "Traversal hidden in path segments should be rejected",
		},
		{
			name:        "Absolute path WITHIN project",
			path:        testFile, // Full absolute path to file inside project
			shouldError: false,
			description: "Absolute path to file inside project should succeed",
		},
		{
			name:        "Valid file in project",
			path:        "test.txt",
			shouldError: false,
			description: "Normal file in project should succeed",
		},
		{
			name:        "Valid subdirectory file",
			path:        filepath.Join("subdir", "file.txt"),
			shouldError: false,
			description: "File in subdirectory should succeed",
		},
	}

	// Create valid subdirectory test case
	subdir := filepath.Join(projectDir, "subdir")
	_ = os.Mkdir(subdir, 0755)
	helpers.WriteFile(t, filepath.Join(subdir, "file.txt"), []byte("valid"))

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			params := map[string]any{
				"path": tt.path,
			}

			result, err := readOps.Execute(context.Background(), "loadFile", params)

			if tt.shouldError {
				if err == nil {
					t.Errorf("%s: expected error but got none. Result: %v", tt.description, result)
				}
			} else {
				if err != nil {
					t.Errorf("%s: expected no error but got: %v", tt.description, err)
				}
			}
		})
	}

	// Test symlink attack separately (requires symlink support)
	t.Run("Symlink to outside file", func(t *testing.T) {
		symlinkPath, ok := createSymlinkOutside(projectDir, outsideFile)
		if !ok {
			t.Skip("Symlinks not supported on this platform")
		}

		params := map[string]any{
			"path": symlinkPath,
		}

		result, err := readOps.Execute(context.Background(), "loadFile", params)
		if err == nil {
			t.Errorf("Symlink pointing outside project should be rejected. Result: %v", result)
		}
	})
}

// TestPathTraversalTreeOps ensures tree operations cannot escape project directory
func TestPathTraversalTreeOps(t *testing.T) {
	projectDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(projectDir)

	// Create file structure
	helpers.WriteFile(t, filepath.Join(projectDir, "file.txt"), []byte("content"))

	treeOps := ops.NewTreeOperations(ops.NewPathScope(projectDir, nil))

	tests := []struct {
		name        string
		path        string
		shouldError bool
	}{
		{
			name:        "Tree from outside project",
			path:        "../",
			shouldError: true,
		},
		{
			name:        "Tree from absolute outside path",
			path:        absoluteOutsidePath(),
			shouldError: true,
		},
		{
			name:        "Tree from project root",
			path:        ".",
			shouldError: false,
		},
		{
			name:        "Tree from subdirectory",
			path:        "subdir",
			shouldError: false,
		},
	}

	_ = os.Mkdir(filepath.Join(projectDir, "subdir"), 0755)

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			params := map[string]any{
				"path":  tt.path,
				"depth": 2,
			}

			result, err := treeOps.Execute(context.Background(), "getTree", params)

			if tt.shouldError {
				if err == nil {
					t.Errorf("Expected error for path %s but got none. Result: %v", tt.path, result)
				}
			} else {
				if err != nil {
					t.Errorf("Expected no error for path %s but got: %v", tt.path, err)
				}
			}
		})
	}
}

// TestPathTraversalSearchOps ensures search operations cannot escape project directory
func TestPathTraversalSearchOps(t *testing.T) {
	projectDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(projectDir)

	helpers.WriteFile(t, filepath.Join(projectDir, "test.txt"), []byte("searchable content"))

	searchOps := ops.NewSearchOperations(ops.NewPathScope(projectDir, nil))

	tests := []struct {
		name        string
		path        string
		shouldError bool
	}{
		{
			name:        "Search outside project",
			path:        "../",
			shouldError: true,
		},
		{
			name:        "Search absolute outside path",
			path:        absoluteOutsidePath(),
			shouldError: true,
		},
		{
			name:        "Search in project",
			path:        ".",
			shouldError: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			params := map[string]any{
				"path":    tt.path,
				"pattern": "content",
			}

			result, err := searchOps.Execute(context.Background(), "grep", params)

			if tt.shouldError {
				if err == nil {
					t.Errorf("Expected error for path %s but got none. Result: %v", tt.path, result)
				}
			} else {
				if err != nil {
					t.Errorf("Expected no error for path %s but got: %v", tt.path, err)
				}
			}
		})
	}
}

// Helper to create symlink pointing outside project
// Returns empty string if symlinks are not supported (e.g., Windows without admin)
func createSymlinkOutside(projectDir, target string) (string, bool) {
	symlinkPath := filepath.Join(projectDir, "evil_symlink.txt")
	err := os.Symlink(target, symlinkPath)
	if err != nil {
		return "", false
	}
	return "evil_symlink.txt", true
}
