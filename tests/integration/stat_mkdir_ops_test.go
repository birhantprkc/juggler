//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"juggler/cmd/juggler/ops"
	"juggler/tests/helpers"
)

func TestStat_File(t *testing.T) {
	projectDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(projectDir)

	helpers.WriteFile(t, filepath.Join(projectDir, "hello.txt"), []byte("Hello, World!"))

	readOps := ops.NewFileOperations(ops.NewPathScope(projectDir, nil))
	result, err := readOps.Execute(context.Background(), "stat", map[string]any{"path": "hello.txt"})
	if err != nil {
		t.Fatalf("Expected no error, got: %v", err)
	}

	m := result.(map[string]any)
	if m["exists"] != true {
		t.Error("Expected exists to be true")
	}
	if m["isFile"] != true {
		t.Error("Expected isFile to be true")
	}
	if m["isDirectory"] != false {
		t.Error("Expected isDirectory to be false")
	}
	if size, ok := m["size"].(int64); !ok || size != 13 {
		t.Errorf("Expected size 13, got %v", m["size"])
	}
	if m["modified"] == nil {
		t.Error("Expected modified timestamp")
	}
}

func TestStat_Directory(t *testing.T) {
	projectDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(projectDir)

	if err := os.MkdirAll(filepath.Join(projectDir, "subdir"), 0755); err != nil {
		t.Fatalf("Failed to create test dir: %v", err)
	}

	readOps := ops.NewFileOperations(ops.NewPathScope(projectDir, nil))
	result, err := readOps.Execute(context.Background(), "stat", map[string]any{"path": "subdir"})
	if err != nil {
		t.Fatalf("Expected no error, got: %v", err)
	}

	m := result.(map[string]any)
	if m["isDirectory"] != true {
		t.Error("Expected isDirectory to be true")
	}
	if m["isFile"] != false {
		t.Error("Expected isFile to be false")
	}
}

func TestStat_Nonexistent(t *testing.T) {
	projectDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(projectDir)

	readOps := ops.NewFileOperations(ops.NewPathScope(projectDir, nil))
	result, err := readOps.Execute(context.Background(), "stat", map[string]any{"path": "nope.txt"})
	if err != nil {
		t.Fatalf("Expected no error, got: %v", err)
	}

	m := result.(map[string]any)
	if m["exists"] != false {
		t.Error("Expected exists to be false")
	}
}

func TestMkdir_Basic(t *testing.T) {
	projectDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(projectDir)

	readOps := ops.NewFileOperations(ops.NewPathScope(projectDir, nil))
	_, err := readOps.Execute(context.Background(), "mkdir", map[string]any{"path": "newdir"})
	if err != nil {
		t.Fatalf("Expected no error, got: %v", err)
	}

	info, err := os.Stat(filepath.Join(projectDir, "newdir"))
	if err != nil {
		t.Fatalf("Directory should exist: %v", err)
	}
	if !info.IsDir() {
		t.Error("Expected a directory")
	}
}

func TestMkdir_Recursive(t *testing.T) {
	projectDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(projectDir)

	readOps := ops.NewFileOperations(ops.NewPathScope(projectDir, nil))
	_, err := readOps.Execute(context.Background(), "mkdir", map[string]any{
		"path":      "a/b/c",
		"recursive": true,
	})
	if err != nil {
		t.Fatalf("Expected no error, got: %v", err)
	}

	info, err := os.Stat(filepath.Join(projectDir, "a", "b", "c"))
	if err != nil {
		t.Fatalf("Nested directory should exist: %v", err)
	}
	if !info.IsDir() {
		t.Error("Expected a directory")
	}
}

func TestMkdir_NonRecursiveFails(t *testing.T) {
	projectDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(projectDir)

	readOps := ops.NewFileOperations(ops.NewPathScope(projectDir, nil))
	_, err := readOps.Execute(context.Background(), "mkdir", map[string]any{"path": "a/b/c"})
	if err == nil {
		t.Fatal("Expected error for non-recursive mkdir with missing parents")
	}
}
