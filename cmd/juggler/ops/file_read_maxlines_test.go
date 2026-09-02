//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeNumberedLines writes a file of n lines, each naming its own number.
func writeNumberedLines(t *testing.T, path string, n int) {
	t.Helper()
	lines := make([]string, n)
	for i := range lines {
		lines[i] = fmt.Sprintf("line %d", i+1)
	}
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")), 0o644); err != nil {
		t.Fatalf("write file: %v", err)
	}
}

// loadLines runs a whole-file loadFile with the given extra params and returns
// the reported line count and content.
func loadLines(t *testing.T, dir, path string, extra map[string]any) (int, string) {
	t.Helper()
	params := map[string]any{"path": path}
	for k, v := range extra {
		params[k] = v
	}
	ops := NewFileOperations(NewPathScope(dir, nil))
	res, err := ops.Execute(context.Background(), "loadFile", params)
	if err != nil {
		t.Fatalf("loadFile: %v", err)
	}
	m, ok := res.(map[string]any)
	if !ok {
		t.Fatalf("unexpected result type %T", res)
	}
	count, ok := m["lineCount"].(int)
	if !ok {
		t.Fatalf("lineCount missing or not an int: %#v", m["lineCount"])
	}
	content, _ := m["content"].(string)
	return count, content
}

// TestLoadFileMaxLines: the whole-file read's line ceiling is DefaultMaxLines
// unless the caller names one. maxLines=0 means no ceiling, which is what a
// viewer showing the file wants — the LLM-facing read leaves it unset and keeps
// the context-trimming default.
func TestLoadFileMaxLines(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "long.txt")
	total := DefaultMaxLines + 500
	writeNumberedLines(t, path, total)

	t.Run("absent keeps the default ceiling", func(t *testing.T) {
		count, content := loadLines(t, dir, path, nil)
		if count != DefaultMaxLines {
			t.Errorf("lineCount = %d, want %d", count, DefaultMaxLines)
		}
		if strings.Contains(content, fmt.Sprintf("line %d", total)) {
			t.Error("content reached the last line despite the default ceiling")
		}
	})

	t.Run("zero means no ceiling", func(t *testing.T) {
		count, content := loadLines(t, dir, path, map[string]any{"maxLines": float64(0)})
		if count != total {
			t.Errorf("lineCount = %d, want %d", count, total)
		}
		if !strings.HasSuffix(content, fmt.Sprintf("line %d", total)) {
			t.Error("content did not reach the last line")
		}
	})

	t.Run("an explicit ceiling is honoured", func(t *testing.T) {
		count, _ := loadLines(t, dir, path, map[string]any{"maxLines": float64(10)})
		if count != 10 {
			t.Errorf("lineCount = %d, want 10", count)
		}
	})

	t.Run("a ceiling above the file returns the whole file", func(t *testing.T) {
		count, _ := loadLines(t, dir, path, map[string]any{"maxLines": float64(total + 1000)})
		if count != total {
			t.Errorf("lineCount = %d, want %d", count, total)
		}
	})

	t.Run("no ceiling still truncates an over-long line", func(t *testing.T) {
		wide := filepath.Join(dir, "wide.txt")
		if err := os.WriteFile(wide, []byte(strings.Repeat("x", MaxLineLength+100)), 0o644); err != nil {
			t.Fatalf("write file: %v", err)
		}
		_, content := loadLines(t, dir, wide, map[string]any{"maxLines": float64(0)})
		if len(content) > MaxLineLength+100 {
			t.Errorf("over-long line was returned whole (%d bytes) — only raw mode does that", len(content))
		}
	})
}
