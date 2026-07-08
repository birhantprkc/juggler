//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build windows

package claudecode

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// claudeInstallLocationsHint names the fallback install dirs probed when the
// claude CLI isn't resolvable via %PATH%; used in the not-found error message.
const claudeInstallLocationsHint = `%USERPROFILE%\.local\bin, %APPDATA%\npm, %LOCALAPPDATA%\Programs\claude`

// claudeBinaryCandidates lists absolute paths to probe for the claude CLI when
// it isn't resolvable via PATH+PATHEXT. Each directory is probed for both the
// native installer's claude.exe and the npm global shim's claude.cmd, in that
// order (the directly-spawnable .exe is preferred).
func claudeBinaryCandidates() []string {
	var candidates []string
	add := func(dir string) {
		if dir == "" {
			return
		}
		candidates = append(candidates,
			filepath.Join(dir, "claude.exe"),
			filepath.Join(dir, "claude.cmd"),
		)
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		add(filepath.Join(home, ".local", "bin"))
		add(filepath.Join(home, ".claude", "local"))
	}
	if appData := os.Getenv("APPDATA"); appData != "" {
		add(filepath.Join(appData, "npm"))
	}
	if localAppData := os.Getenv("LOCALAPPDATA"); localAppData != "" {
		add(filepath.Join(localAppData, "Programs", "claude"))
	}
	return candidates
}

// isExecutableFile reports whether a probed candidate is runnable. Windows has
// no Unix execute bit, so any regular file qualifies (the caller already
// excludes directories).
func isExecutableFile(info os.FileInfo) bool { return !info.IsDir() }

// claudeCommand builds the exec.Cmd that launches the CLI. A .cmd/.bat shim
// (e.g. the npm global install) can't be executed directly by CreateProcess,
// so it is run through "cmd /c"; a native .exe is invoked directly. Note: very
// complex arguments routed through cmd.exe are subject to its quoting rules —
// the native .exe install avoids that path entirely and is preferred.
func claudeCommand(ctx context.Context, bin string, args []string) *exec.Cmd {
	switch strings.ToLower(filepath.Ext(bin)) {
	case ".cmd", ".bat":
		return exec.CommandContext(ctx, "cmd", append([]string{"/c", bin}, args...)...)
	default:
		return exec.CommandContext(ctx, bin, args...)
	}
}
