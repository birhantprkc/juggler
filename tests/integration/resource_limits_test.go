//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration_test

import (
	"context"
	"os"
	"runtime"
	"strings"
	"testing"

	"juggler/cmd/juggler/ops"
	"juggler/tests/helpers"
)

// TestLargeFileHandling ensures operations handle large files safely (DoS prevention)
func TestLargeFileHandling(t *testing.T) {
	projectDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(projectDir)

	readOps := ops.NewFileOperations(ops.NewPathScope(projectDir, nil))

	tests := []struct {
		name        string
		sizeBytes   int64
		shouldError bool
		description string
	}{
		{
			name:        "Normal file (1KB)",
			sizeBytes:   1024,
			shouldError: false,
			description: "Small files should be readable",
		},
		{
			name:        "Medium file (1MB)",
			sizeBytes:   1024 * 1024,
			shouldError: false,
			description: "Medium files should be readable",
		},
		{
			name:        "Large file (10MB)",
			sizeBytes:   10 * 1024 * 1024,
			shouldError: false,
			description: "Large files should be readable with warnings/truncation",
		},
		{
			name:        "Huge file (100MB)",
			sizeBytes:   100 * 1024 * 1024,
			shouldError: true,
			description: "Extremely large files should be rejected to prevent DoS",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Create file of specified size
			filename := "large_file.txt"
			helpers.CreateFileWithSize(t, projectDir, filename, tt.sizeBytes)

			params := map[string]any{
				"path": filename,
			}

			result, err := readOps.Execute(context.Background(), "loadFile", params)

			if tt.shouldError {
				if err == nil {
					t.Errorf("%s: expected error but got none", tt.description)
				}
			} else {
				if err != nil {
					t.Errorf("%s: expected no error but got: %v", tt.description, err)
				} else {
					// For large files, verify result is truncated/summarized
					if tt.sizeBytes > 10*1024*1024 {
						if resultMap, ok := result.(map[string]any); ok {
							if content, ok := resultMap["content"].(string); ok {
								if int64(len(content)) > tt.sizeBytes {
									t.Errorf("Large file result should be truncated but has size %d > %d", len(content), tt.sizeBytes)
								}
							}
						}
					}
				}
			}
		})
	}
}

// TestRegexDoS ensures grep operations are protected against catastrophic backtracking
func TestRegexDoS(t *testing.T) {
	projectDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(projectDir)

	// Create test file
	content := strings.Repeat("a", 1000) + "b"
	helpers.WriteFile(t, projectDir+"/test.txt", []byte(content))

	searchOps := ops.NewSearchOperations(ops.NewPathScope(projectDir, nil))

	tests := []struct {
		name        string
		pattern     string
		shouldError bool
		description string
	}{
		{
			name:        "Catastrophic backtracking pattern",
			pattern:     "(a+)+b",
			shouldError: true,
			description: "Pattern with exponential backtracking should be rejected or timeout",
		},
		{
			name:        "Nested quantifiers",
			pattern:     "(a*)*b",
			shouldError: true,
			description: "Nested quantifiers causing exponential complexity should be rejected",
		},
		{
			name:        "Complex alternation",
			pattern:     "(a|a)*b",
			shouldError: true,
			description: "Ambiguous alternation should be rejected or timeout",
		},
		{
			name:        "Safe pattern",
			pattern:     "a+b",
			shouldError: false,
			description: "Normal regex should work fine",
		},
		{
			name:        "Literal search",
			pattern:     "aaa",
			shouldError: false,
			description: "Literal string search should work",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			params := map[string]any{
				"path":    ".",
				"pattern": tt.pattern,
				"timeout": 1000, // 1 second timeout
			}

			result, err := searchOps.Execute(context.Background(), "grep", params)

			if tt.shouldError {
				if err == nil {
					t.Errorf("%s: expected error/timeout but got none. Result: %v", tt.description, result)
				}
			} else {
				if err != nil {
					t.Errorf("%s: expected no error but got: %v", tt.description, err)
				}
			}
		})
	}
}

// TestTreeDepthLimit ensures tree operations cannot cause stack overflow
func TestTreeDepthLimit(t *testing.T) {
	projectDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(projectDir)

	// Create deeply nested directory structure
	deepPath := projectDir
	for range 100 {
		deepPath = helpers.CreateSubdir(t, deepPath, "subdir")
	}

	treeOps := ops.NewTreeOperations(ops.NewPathScope(projectDir, nil))

	tests := []struct {
		name        string
		depth       int
		shouldError bool
		description string
	}{
		{
			name:        "Reasonable depth",
			depth:       10,
			shouldError: false,
			description: "Normal depth should work",
		},
		{
			name:        "Large depth",
			depth:       50,
			shouldError: false,
			description: "Large but reasonable depth should work",
		},
		{
			name:        "Excessive depth",
			depth:       1000,
			shouldError: true,
			description: "Excessive depth should be rejected to prevent stack overflow",
		},
		{
			name:        "Negative depth",
			depth:       -1,
			shouldError: true,
			description: "Negative depth should be rejected",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			params := map[string]any{
				"path":  ".",
				"depth": tt.depth,
			}

			result, err := treeOps.Execute(context.Background(), "getTree", params)

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
}

// TestFilePermissions ensures operations respect file permissions
func TestFilePermissions(t *testing.T) {
	if runtime.GOOS == "windows" {
		// On Windows, test by trying to read a file that doesn't exist in a protected directory
		// Note: loadFile returns exists:false for non-existent files rather than an error
		// (this is intentional design to allow file existence checks without errors)
		// So we verify the "exists" field is false instead of checking for an error
		readOps := ops.NewFileOperations(ops.NewPathScope("C:\\Windows\\System32", nil))

		params := map[string]any{
			"path": "nonexistent_file_that_should_not_exist_12345.txt",
		}

		result, err := readOps.Execute(context.Background(), "loadFile", params)
		if err != nil {
			// If we got an actual error (e.g., permission denied), that's also acceptable
			return
		}
		// Check that result indicates file doesn't exist
		if resultMap, ok := result.(map[string]any); ok {
			if exists, ok := resultMap["exists"].(bool); ok && exists {
				t.Error("Non-existent file should have exists=false")
			}
		}
		return
	}

	if os.Getuid() == 0 {
		t.Skip("Cannot test file permissions as root user")
	}

	projectDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(projectDir)

	// Create file with no read permissions
	noReadFile := projectDir + "/no_read.txt"
	helpers.WriteFile(t, noReadFile, []byte("secret content"))
	_ = os.Chmod(noReadFile, 0000) // No permissions
	defer func() { _ = os.Chmod(noReadFile, 0644) }()

	readOps := ops.NewFileOperations(ops.NewPathScope(projectDir, nil))

	params := map[string]any{
		"path": "no_read.txt",
	}

	result, err := readOps.Execute(context.Background(), "loadFile", params)

	if err == nil {
		t.Errorf("Reading file without read permissions should fail. Result: %v", result)
	}
}

// TestBinaryFileDetection ensures binary files are handled safely
func TestBinaryFileDetection(t *testing.T) {
	projectDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(projectDir)

	readOps := ops.NewFileOperations(ops.NewPathScope(projectDir, nil))

	tests := []struct {
		name        string
		content     []byte
		shouldWarn  bool
		description string
	}{
		{
			name:        "Text file",
			content:     []byte("Hello world\nThis is text\n"),
			shouldWarn:  false,
			description: "Plain text should be readable",
		},
		{
			name:        "Binary file (ELF header)",
			content:     []byte{0x7F, 0x45, 0x4C, 0x46, 0x00, 0x00},
			shouldWarn:  true,
			description: "Binary files should be detected and warned/rejected",
		},
		{
			name:        "Binary file (null bytes)",
			content:     []byte("Text\x00with\x00nulls\x00"),
			shouldWarn:  true,
			description: "Text with null bytes should be treated as binary",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			filename := "test_" + tt.name + ".bin"
			helpers.WriteFile(t, projectDir+"/"+filename, tt.content)

			params := map[string]any{
				"path": filename,
			}

			result, err := readOps.Execute(context.Background(), "loadFile", params)

			if tt.shouldWarn {
				// Either error or warning in result
				if err == nil {
					if resultMap, ok := result.(map[string]any); ok {
						if warning, ok := resultMap["warning"]; !ok || warning == "" {
							t.Errorf("%s: expected warning about binary file but got none", tt.description)
						}
					} else {
						t.Errorf("%s: expected error or warning but got neither", tt.description)
					}
				}
			} else {
				if err != nil {
					t.Errorf("%s: expected no error but got: %v", tt.description, err)
				}
			}
		})
	}
}
