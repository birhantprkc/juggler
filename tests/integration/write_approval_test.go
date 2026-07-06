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

// These tests pin the contract that file-modifying ops (writeFile / editFile)
// trust the JS-side approval gate and don't enforce working-directory
// containment themselves. Reads/search/tree continue to enforce containment —
// that's covered by path_traversal_test.go and must stay green alongside this.

// TestWriteFile_AbsolutePathOutsideProject is the regression for the original
// bug: the LLM's `write` tool was hard-failing with "path is outside working
// directory" before the approval modal could fire, even when the user had
// approved (or pre-approved via standing permission). Approval is the gate;
// the backend just executes.
func TestWriteFile_AbsolutePathOutsideProject(t *testing.T) {
	projectDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(projectDir)

	// Pick an out-of-tree target by going one level above the project dir.
	parentDir := filepath.Dir(projectDir)
	outsideFile := filepath.Join(parentDir, "approved-write.txt")
	defer os.Remove(outsideFile)

	readOps := ops.NewFileOperations(ops.NewPathScope(projectDir, nil))

	result, err := readOps.Execute(context.Background(), "writeFile", map[string]any{
		"path":    outsideFile,
		"content": "approved by the user via the JS approval flow",
	})
	if err != nil {
		t.Fatalf("writeFile to absolute out-of-tree path failed: %v", err)
	}
	if result == nil {
		t.Fatalf("writeFile returned nil result")
	}

	got, readErr := os.ReadFile(outsideFile)
	if readErr != nil {
		t.Fatalf("file was not written: %v", readErr)
	}
	if string(got) != "approved by the user via the JS approval flow" {
		t.Errorf("unexpected file content: %q", string(got))
	}
}

// TestWriteFile_DryRunDoesNotWrite is the contract the plugin's validate()
// step depends on: a dryRun call must report feasibility without touching the
// filesystem, so the approval modal isn't opened for impossible writes (and
// so feasibility checks don't accidentally create the file).
func TestWriteFile_DryRunDoesNotWrite(t *testing.T) {
	projectDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(projectDir)

	target := filepath.Join(projectDir, "would-be-new.txt")
	readOps := ops.NewFileOperations(ops.NewPathScope(projectDir, nil))

	result, err := readOps.Execute(context.Background(), "writeFile", map[string]any{
		"path":    target,
		"content": "should not land on disk",
		"dryRun":  true,
	})
	if err != nil {
		t.Fatalf("dryRun writeFile failed: %v", err)
	}
	resMap, ok := result.(map[string]any)
	if !ok {
		t.Fatalf("expected map result, got %T", result)
	}
	if resMap["dryRun"] != true {
		t.Errorf("expected dryRun=true in result, got %v", resMap["dryRun"])
	}
	if resMap["created"] != true {
		t.Errorf("expected created=true for would-be-new file, got %v", resMap["created"])
	}
	if _, statErr := os.Stat(target); !os.IsNotExist(statErr) {
		t.Errorf("dryRun must not create the file; stat err = %v", statErr)
	}
}

// TestWriteFile_DryRunRejectsImpossibleWrites covers the failure modes the
// plugin wants to surface as validation errors *before* prompting the user:
// target is a directory; parent path is a file (so MkdirAll fails).
func TestWriteFile_DryRunRejectsImpossibleWrites(t *testing.T) {
	projectDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(projectDir)

	readOps := ops.NewFileOperations(ops.NewPathScope(projectDir, nil))

	t.Run("TargetIsADirectory", func(t *testing.T) {
		dirTarget := filepath.Join(projectDir, "im-a-dir")
		if err := os.Mkdir(dirTarget, 0755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		_, err := readOps.Execute(context.Background(), "writeFile", map[string]any{
			"path":    dirTarget,
			"content": "doesn't matter",
			"dryRun":  true,
		})
		if err == nil {
			t.Errorf("expected error writing over a directory, got nil")
		}
	})

	t.Run("ParentIsAFile", func(t *testing.T) {
		parentFile := filepath.Join(projectDir, "not-a-dir.txt")
		if err := os.WriteFile(parentFile, []byte("hello"), 0644); err != nil {
			t.Fatalf("seed: %v", err)
		}
		_, err := readOps.Execute(context.Background(), "writeFile", map[string]any{
			"path":    filepath.Join(parentFile, "child.txt"),
			"content": "can't nest under a file",
			"dryRun":  true,
		})
		if err == nil {
			t.Errorf("expected error when parent path is a file, got nil")
		}
	})
}

// TestWriteFile_DryRunSucceedsForLegalTarget exercises the happy path for
// dryRun — feasibility check passes, no file written, plugin can proceed
// to open the approval modal.
func TestWriteFile_DryRunSucceedsForLegalTarget(t *testing.T) {
	projectDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(projectDir)

	existing := filepath.Join(projectDir, "existing.txt")
	if err := os.WriteFile(existing, []byte("before"), 0644); err != nil {
		t.Fatalf("seed: %v", err)
	}

	readOps := ops.NewFileOperations(ops.NewPathScope(projectDir, nil))
	result, err := readOps.Execute(context.Background(), "writeFile", map[string]any{
		"path":    existing,
		"content": "after",
		"dryRun":  true,
	})
	if err != nil {
		t.Fatalf("dryRun on legal target failed: %v", err)
	}
	resMap, _ := result.(map[string]any)
	if resMap["created"] != false {
		t.Errorf("expected created=false for existing file, got %v", resMap["created"])
	}

	// File content must be unchanged after dryRun.
	got, _ := os.ReadFile(existing)
	if string(got) != "before" {
		t.Errorf("dryRun mutated existing file: %q", string(got))
	}
}

// TestEditFile_AbsolutePathOutsideProject mirrors the writeFile behaviour for
// editFile: once approved upstream, the backend executes against any path the
// caller can write to.
func TestEditFile_AbsolutePathOutsideProject(t *testing.T) {
	projectDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(projectDir)

	// Seed an out-of-tree file we'll edit.
	parentDir := filepath.Dir(projectDir)
	outsideFile := filepath.Join(parentDir, "approved-edit.txt")
	if err := os.WriteFile(outsideFile, []byte("hello world\n"), 0644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	defer os.Remove(outsideFile)

	readOps := ops.NewFileOperations(ops.NewPathScope(projectDir, nil))
	_, err := readOps.Execute(context.Background(), "editFile", map[string]any{
		"path":    outsideFile,
		"old_str": "world",
		"new_str": "approval",
	})
	if err != nil {
		t.Fatalf("editFile on absolute out-of-tree path failed: %v", err)
	}
	got, _ := os.ReadFile(outsideFile)
	if string(got) != "hello approval\n" {
		t.Errorf("unexpected file content after edit: %q", string(got))
	}
}
