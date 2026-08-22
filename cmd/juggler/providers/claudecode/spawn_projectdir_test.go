//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"context"
	"path/filepath"
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

// TestSpawn_UsesConfigProjectDir pins the fix for the spawned-CLI working
// directory: the claude CLI must run in the project the server has open
// (provider.Config.ProjectPath, the value the conversation cache fills from
// Server.ProjectPath()), NOT the directory the server was launched from.
//
// The regression it guards: NewClient derived workingDir from
// os.Getenv("JUGGLER_PROJECT_PATH") (a seam nothing populates in production)
// with an os.Getwd() fallback, so the CLI inherited the launch directory and
// Claude Code resolved the wrong project — loading the other project's
// CLAUDE.md, transcripts, and .claude/settings.json.
//
// To prove Config wins, JUGGLER_PROJECT_PATH is deliberately pointed at a
// DECOY directory: the spawn must still land in the Config project dir.
func TestSpawn_UsesConfigProjectDir(t *testing.T) {
	projectDir := t.TempDir() // what the window shows — where the CLI must run
	decoyDir := t.TempDir()   // the legacy env seam / "launch dir" — must lose
	t.Setenv("JUGGLER_PROJECT_PATH", decoyDir)

	tracePath := installFakeClaude(t, fakeModeUntilClose, "uuid-projectdir")

	p, err := NewClient(provider.Config{Model: "claude-sonnet-4-6", ProjectPath: projectDir})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	c := p.(*Client)
	t.Cleanup(c.closeSession)

	convID := "conv-projectdir"
	if _, err := c.streamMessage(context.Background(), provider.MessageRequest{
		ConversationID: convID, SystemPrompt: "sys", Messages: []provider.Message{userMsg("hello")},
	}, nopCallback()); err != nil {
		t.Fatalf("streamMessage: %v", err)
	}

	// The child reports os.Getwd(), which resolves symlinks (on macOS
	// /var → /private/var), so compare symlink-resolved forms.
	want := evalSymlinks(t, projectDir)
	trace := readTrace(t, tracePath)
	if len(trace) == 0 {
		t.Fatal("expected at least one fake-CLI spawn, got none")
	}
	for i, rec := range trace {
		if evalSymlinks(t, rec.Cwd) != want {
			t.Errorf("spawn #%d ran in Cwd = %q; want the Config project dir %q (decoy env dir was %q)",
				i, rec.Cwd, projectDir, decoyDir)
		}
	}

	c.dropSession(convID)
}

// evalSymlinks resolves symlinks for a robust path comparison; falls back to
// the input when the path can't be resolved.
func evalSymlinks(t *testing.T, p string) string {
	t.Helper()
	if resolved, err := filepath.EvalSymlinks(p); err == nil {
		return resolved
	}
	return p
}
