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
	"time"
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

// resolveViaLoginShell asks the user's login shell where claude is, so we
// resolve it exactly as a terminal's `which claude` does. This is the general
// fix for the macOS-GUI case: an app launched from Finder/Dock inherits a
// minimal PATH that omits the version-manager bin dirs (nvm/fnm/volta/asdf) and
// homebrew prefixes where the binary actually lives, but those are set up in
// the shell's rc files. We run the login+interactive shell so the same profile
// and rc files are sourced, then read the resolved path. Returns "" when $SHELL
// is unset, the probe fails or times out, or the result isn't a runnable file.
func resolveViaLoginShell() string {
	shell := os.Getenv("SHELL")
	if shell == "" {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()

	// -l (login) + -i (interactive) source the profile + rc files where version
	// managers register their PATH. `command -v claude` is POSIX and works in
	// bash/zsh/fish. Flags are passed separately (not bundled as -lic) for fish
	// compatibility. Stdin defaults to /dev/null so an interactive shell can't
	// block waiting for input; stderr (rc-file chatter, job-control warnings) is
	// discarded by Output, which captures stdout only.
	cmd := exec.CommandContext(ctx, shell, "-l", "-i", "-c", "command -v claude")
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	path := lastNonEmptyLine(string(out))
	if path == "" || !filepath.IsAbs(path) || !isExecutablePath(path) {
		return ""
	}
	return path
}

// claudeCommand builds the exec.Cmd that launches the CLI. On Unix the binary
// is invoked directly.
func claudeCommand(ctx context.Context, bin string, args []string) *exec.Cmd {
	return exec.CommandContext(ctx, bin, args...)
}
