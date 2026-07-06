//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"os"
	"path/filepath"
	"runtime"
)

// IsUnsuitableProjectRoot reports whether dir is a "well-known" location a
// user almost certainly did not intend as a project root — the filesystem or
// drive root, the home directory itself, the directory that contains home
// dirs (/Users, /home, C:\Users), a standard top-level home folder (Desktop,
// Documents, Downloads, …), or a system folder (/Applications, C:\Program
// Files, /usr, …). Launching juggler from such a place would scatter a stray
// .juggler/ folder where the user does not expect one, so startup treats these
// as "no project" and shows the picker instead of silently adopting them.
//
// homeDir is the user's home directory (from os.UserHomeDir); pass "" to skip
// the home-relative checks when home can't be determined. The check is purely
// lexical on cleaned, symlink-resolved paths and is OS-aware via
// runtime.GOOS — it never inspects the directory's contents.
func IsUnsuitableProjectRoot(dir, homeDir string) bool {
	d := canonicalDir(dir)
	if d == "" {
		return false
	}

	// Filesystem root ("/" on Unix) or a Windows drive/UNC root: the only
	// directories whose parent is themselves.
	if d == filepath.Dir(d) {
		return true
	}

	for _, r := range systemRoots() {
		if d == canonicalDir(r) {
			return true
		}
	}

	home := canonicalDir(homeDir)
	if home == "" {
		return false
	}
	// The home directory itself, and the directory that holds home dirs
	// (/Users, /home, C:\Users) — derived from home so it needs no per-OS
	// hardcoding.
	if d == home || d == filepath.Dir(home) {
		return true
	}
	for _, name := range genericHomeSubdirs() {
		if d == filepath.Join(home, name) {
			return true
		}
	}
	return false
}

// canonicalDir returns an absolute, cleaned, symlink-resolved form of p so two
// spellings of the same directory compare equal. EvalSymlinks fails for paths
// that don't exist (or system roots on the "wrong" OS); in that case we keep
// the absolute-cleaned form, which is still consistent between operands.
func canonicalDir(p string) string {
	if p == "" {
		return ""
	}
	abs, err := filepath.Abs(p)
	if err != nil {
		abs = filepath.Clean(p)
	}
	if resolved, err := filepath.EvalSymlinks(abs); err == nil {
		return resolved
	}
	return abs
}

// genericHomeSubdirs returns the standard top-level folder names inside a
// user's home directory for the current OS. None is a sensible project root.
func genericHomeSubdirs() []string {
	common := []string{"Desktop", "Documents", "Downloads", "Music", "Pictures"}
	switch runtime.GOOS {
	case "darwin":
		return append(common, "Movies", "Public", "Library", "Applications", "Sites")
	case "windows":
		return append(common, "Videos", "Favorites", "Links", "Contacts",
			"Searches", "Saved Games", "3D Objects", "OneDrive")
	default: // linux and other Unixes follow the XDG user-dirs convention
		return append(common, "Videos", "Public", "Templates")
	}
}

// systemRoots returns absolute locations that are never project roots for the
// current OS. Drive and filesystem roots are handled separately (see
// IsUnsuitableProjectRoot); these are the OS/app system trees. On Windows the
// real paths are read from the environment so a non-C: install is honoured.
func systemRoots() []string {
	switch runtime.GOOS {
	case "darwin":
		return []string{
			"/Applications", "/System", "/Library", "/private",
			"/usr", "/bin", "/sbin", "/opt", "/Volumes", "/cores",
		}
	case "windows":
		var roots []string
		for _, env := range []string{
			"SystemRoot", "windir", "ProgramFiles", "ProgramFiles(x86)",
			"ProgramW6432", "ProgramData",
		} {
			if v := os.Getenv(env); v != "" {
				roots = append(roots, v)
			}
		}
		return roots
	default:
		return []string{
			"/usr", "/etc", "/bin", "/sbin", "/lib", "/opt", "/var",
			"/boot", "/dev", "/proc", "/sys", "/run", "/mnt", "/media",
			"/srv", "/root", "/tmp",
		}
	}
}
