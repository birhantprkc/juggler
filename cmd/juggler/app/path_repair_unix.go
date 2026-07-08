//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !windows

package app

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"
)

// repairPathForGUILaunch merges the user's login-shell $PATH into this process's
// PATH so every child it later spawns (the bash tool, git, the claude/codex CLIs)
// resolves tools the way a terminal launch would. A Finder/Dock launch inherits a
// minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin) with none of the Homebrew,
// version-manager (nvm/fnm/volta/asdf), or ~/.local/bin entries the shell adds,
// because LaunchServices never sources the shell's profile/rc files.
//
// A terminal launch already has the full PATH, so this is a no-op there. Any
// failure (no $SHELL, timeout, bad exit) leaves PATH untouched — no worse than
// before.
func repairPathForGUILaunch(hasTerminal bool) {
	if hasTerminal {
		return
	}
	if loginPath := loginShellPath(); loginPath != "" {
		_ = os.Setenv("PATH", mergePath(os.Getenv("PATH"), loginPath))
	}
}

// loginShellPath runs the user's login shell and captures the $PATH it builds,
// or "" if $SHELL is unset or the probe fails/times out. -l -i sources both the
// profile and the interactive rc files (.zshrc/.bashrc), where version managers
// register their bin dirs; the flags are separate (not -lic) for fish.
//
// Setsid is load-bearing: it puts the shell in a new session with no controlling
// terminal, so an interactive shell can't grab our tty's foreground group or
// leave it in raw mode — which, when the 4s timeout SIGKILLs a slow shell before
// it restores the terminal, would background us (SIGTTIN → "suspended (tty
// input)") and corrupt the terminal. Stdin is /dev/null by default.
func loginShellPath() string {
	shell := os.Getenv("SHELL")
	if shell == "" {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, shell, "-l", "-i", "-c", "printf %s \"$PATH\"")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}
