//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !windows

package claudecode

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
)

// claudeInstallLocationsHint names the fallback install dirs probed when the
// claude CLI isn't on $PATH; used in the not-found error message.
const claudeInstallLocationsHint = "~/.local/bin, ~/.claude/local, ~/.npm-global/bin, /opt/homebrew/bin, /usr/local/bin"

// claudeBinaryCandidates lists absolute paths to probe for the claude CLI.
// macOS GUI launches inherit a minimal PATH (typically just
// /usr/bin:/bin:/usr/sbin:/sbin) that omits user-local bin directories like
// ~/.local/bin where the official installer puts the binary, so we check the
// installer and common npm locations explicitly.
func claudeBinaryCandidates() []string {
	var candidates []string
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		candidates = append(candidates,
			filepath.Join(home, ".local", "bin", "claude"),
			filepath.Join(home, ".claude", "local", "claude"),
			filepath.Join(home, ".npm-global", "bin", "claude"),
		)
	}
	return append(candidates,
		"/opt/homebrew/bin/claude",
		"/usr/local/bin/claude",
	)
}

// isExecutableFile reports whether a probed candidate is runnable. On Unix that
// means at least one execute bit is set.
func isExecutableFile(info os.FileInfo) bool { return info.Mode()&0o111 != 0 }

// claudeCommand builds the exec.Cmd that launches the CLI. On Unix the binary
// is invoked directly.
func claudeCommand(ctx context.Context, bin string, args []string) *exec.Cmd {
	return exec.CommandContext(ctx, bin, args...)
}
