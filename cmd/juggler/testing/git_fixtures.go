//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package testing

import (
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// GitFixtureConfig defines configuration for a git-based fixture
type GitFixtureConfig struct {
	RepoURL         string   `json:"repo_url"`
	BaseCommit      string   `json:"base_commit"`
	InstallCommands []string `json:"install_commands"`
}

// getCacheKey hashes a repo URL + commit into a unique cache key identifying
// that exact repository state.
func getCacheKey(repoURL, commit string) string {
	data := fmt.Sprintf("%s@%s", repoURL, commit)
	hash := sha256.Sum256([]byte(data))
	return fmt.Sprintf("%x", hash[:16]) // first 16 bytes (32 hex chars)
}

// getCachePath returns the cache directory path for a given repo + commit
func getCachePath(repoURL, commit string) string {
	cacheKey := getCacheKey(repoURL, commit)
	return filepath.Join(os.TempDir(), "juggler", "cache", "git", cacheKey)
}

// isCached reports whether a cached clone (a directory holding a .git) exists
// for the given repo + commit.
func isCached(repoURL, commit string) bool {
	cachePath := getCachePath(repoURL, commit)
	gitDir := filepath.Join(cachePath, ".git")
	info, err := os.Stat(gitDir)
	return err == nil && info.IsDir()
}

// copyDirectory recursively copies a directory tree
func copyDirectory(src, dst string) error {
	srcInfo, err := os.Stat(src)
	if err != nil {
		return fmt.Errorf("failed to stat source: %w", err)
	}

	if err := os.MkdirAll(dst, srcInfo.Mode()); err != nil {
		return fmt.Errorf("failed to create destination: %w", err)
	}

	entries, err := os.ReadDir(src)
	if err != nil {
		return fmt.Errorf("failed to read source directory: %w", err)
	}

	for _, entry := range entries {
		srcPath := filepath.Join(src, entry.Name())
		dstPath := filepath.Join(dst, entry.Name())

		if entry.IsDir() {
			if err := copyDirectory(srcPath, dstPath); err != nil {
				return err
			}
		} else {
			if err := copyFile(srcPath, dstPath); err != nil {
				return err
			}
		}
	}

	return nil
}

// copyFile copies a single file with permissions preserved
func copyFile(src, dst string) error {
	srcFile, err := os.Open(src)
	if err != nil {
		return fmt.Errorf("failed to open source file: %w", err)
	}
	defer srcFile.Close()

	srcInfo, err := srcFile.Stat()
	if err != nil {
		return fmt.Errorf("failed to stat source file: %w", err)
	}

	dstFile, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, srcInfo.Mode())
	if err != nil {
		return fmt.Errorf("failed to create destination file: %w", err)
	}
	defer dstFile.Close()

	if _, err := io.Copy(dstFile, srcFile); err != nil {
		return fmt.Errorf("failed to copy file content: %w", err)
	}

	return nil
}

// SetupGitFixture clones a git repository and sets it up as a test fixture
// Uses a cache to avoid re-cloning the same repo+commit multiple times
// Returns the temporary directory path and any error
func SetupGitFixture(ctx context.Context, config GitFixtureConfig) (string, error) {
	// Validate inputs
	if config.RepoURL == "" {
		return "", fmt.Errorf("repo_url is required")
	}
	if config.BaseCommit == "" {
		return "", fmt.Errorf("base_commit is required")
	}

	// Security: Only allow HTTPS URLs from trusted sources
	if !strings.HasPrefix(config.RepoURL, "https://github.com/") &&
		!strings.HasPrefix(config.RepoURL, "https://gitlab.com/") {
		return "", fmt.Errorf("only GitHub and GitLab HTTPS URLs are allowed for security")
	}

	repoName := extractRepoName(config.RepoURL)

	// Use os.TempDir()/juggler as base directory (cross-platform temp directory)
	fixtureBaseDir := filepath.Join(os.TempDir(), "juggler")
	if err := os.MkdirAll(fixtureBaseDir, 0o755); err != nil {
		return "", fmt.Errorf("failed to create fixture directory: %w", err)
	}

	// Create temp directory for this test run
	tmpDir, err := os.MkdirTemp(fixtureBaseDir, fmt.Sprintf("git-%s-*", repoName))
	if err != nil {
		return "", fmt.Errorf("failed to create temp dir: %w", err)
	}

	// Check if we have a cached clone
	cachePath := getCachePath(config.RepoURL, config.BaseCommit)

	if isCached(config.RepoURL, config.BaseCommit) {
		// Cache hit - copy from cache
		log.Printf("💾 Using cached clone: %s (commit: %.8s)", repoName, config.BaseCommit)
		if err := copyDirectory(cachePath, tmpDir); err != nil {
			os.RemoveAll(tmpDir)
			return "", fmt.Errorf("failed to copy from cache: %w", err)
		}
		log.Printf("✅ Cached repository copied successfully")
	} else {
		// Cache miss - clone to cache first, then copy
		log.Printf("📥 Cloning repository to cache: %s (this may take a few minutes)...", repoName)

		// Ensure cache directory exists
		cacheBaseDir := filepath.Dir(cachePath)
		if err := os.MkdirAll(cacheBaseDir, 0o755); err != nil {
			os.RemoveAll(tmpDir)
			return "", fmt.Errorf("failed to create cache directory: %w", err)
		}

		// Clone to cache
		if err := cloneRepoWithRetry(ctx, config.RepoURL, cachePath, 3); err != nil {
			os.RemoveAll(tmpDir)
			os.RemoveAll(cachePath) // Clean up partial cache
			return "", fmt.Errorf("failed to clone repo after retries: %w", err)
		}
		log.Printf("✅ Repository cloned to cache")

		// Checkout specific commit in cache
		log.Printf("🔀 Checking out commit in cache: %.8s...", config.BaseCommit)
		if err := checkoutCommit(ctx, cachePath, config.BaseCommit); err != nil {
			os.RemoveAll(tmpDir)
			os.RemoveAll(cachePath) // Clean up invalid cache
			return "", fmt.Errorf("failed to checkout commit: %w", err)
		}
		log.Printf("✅ Commit checked out in cache")

		// Copy from cache to test directory
		log.Printf("📋 Copying from cache to test directory...")
		if err := copyDirectory(cachePath, tmpDir); err != nil {
			os.RemoveAll(tmpDir)
			return "", fmt.Errorf("failed to copy from cache: %w", err)
		}
		log.Printf("✅ Repository copied from cache")
	}

	// Run installation commands if provided
	// NOTE: Installation is run in the test directory, not the cache
	// This allows each test to have its own isolated installation
	if len(config.InstallCommands) > 0 {
		log.Printf("📦 Running %d installation command(s)...", len(config.InstallCommands))
		if err := runInstallCommands(ctx, tmpDir, config.InstallCommands); err != nil {
			os.RemoveAll(tmpDir)
			return "", fmt.Errorf("failed to run install commands: %w", err)
		}
		log.Printf("✅ Installation completed successfully")
	}

	return tmpDir, nil
}

// findPythonBinary finds the best Python version to use
// Prefers Python 3.11 for SWE-bench compatibility (has cgi module)
// Falls back to python3 (or python on Windows) if 3.11 is not available
func findPythonBinary() string {
	// Platform-specific candidates
	var candidates []string
	if runtime.GOOS == "windows" {
		// Windows: try py launcher first (supports version selection), then python
		candidates = []string{
			"py", "-3.11", // py launcher with version (handled specially below)
			"python3.11", // If in PATH
			"python",     // Windows default
		}
	} else {
		// Unix: try common locations for Python 3.11
		candidates = []string{
			"python3.11",                   // If in PATH
			"/opt/homebrew/bin/python3.11", // Homebrew on Apple Silicon (macOS)
			"/usr/local/bin/python3.11",    // Homebrew on Intel (macOS) or Linux
			"python3",                      // Fallback to default
		}
	}

	for i, candidate := range candidates {
		// Special handling for Windows py launcher with version argument
		if runtime.GOOS == "windows" && candidate == "py" && i+1 < len(candidates) && candidates[i+1] == "-3.11" {
			cmd := exec.Command("py", "-3.11", "--version")
			if err := cmd.Run(); err == nil {
				// py -3.11 works, but we need to return just "py" and handle args elsewhere
				// For simplicity, try python3.11 in PATH first
				continue
			}
		}
		if candidate == "-3.11" {
			continue // Skip the version argument
		}

		// Check if this binary exists and works
		cmd := exec.Command(candidate, "--version")
		if err := cmd.Run(); err == nil {
			return candidate
		}
	}

	// Absolute fallback - platform-specific
	if runtime.GOOS == "windows" {
		return "python"
	}
	return "python3"
}

// extractRepoName extracts repository name from URL
// e.g., "https://github.com/django/django.git" -> "django"
func extractRepoName(repoURL string) string {
	parts := strings.Split(repoURL, "/")
	if len(parts) > 0 {
		name := parts[len(parts)-1]
		// Remove .git suffix if present
		name = strings.TrimSuffix(name, ".git")
		return name
	}
	return "repo"
}

// cloneRepoWithRetry attempts to clone a repository with retries for transient failures
func cloneRepoWithRetry(ctx context.Context, repoURL, destDir string, maxRetries int) error {
	var lastErr error

	for attempt := 1; attempt <= maxRetries; attempt++ {
		// Check if context was cancelled before attempting
		if ctx.Err() != nil {
			return fmt.Errorf("clone cancelled: %w", ctx.Err())
		}

		if attempt > 1 {
			log.Printf("   Retry attempt %d/%d...", attempt, maxRetries)
		}

		err := cloneRepo(ctx, repoURL, destDir)
		if err == nil {
			return nil // Success
		}

		lastErr = err

		// Don't retry on timeout - those are likely to fail again
		if strings.Contains(err.Error(), "timed out") {
			return fmt.Errorf("attempt %d/%d: %w (not retrying timeouts)", attempt, maxRetries, err)
		}

		// Don't retry on context cancellation
		if ctx.Err() != nil {
			return fmt.Errorf("clone cancelled after attempt %d: %w", attempt, ctx.Err())
		}

		// Don't retry on the last attempt
		if attempt < maxRetries {
			// Wait before retrying (exponential backoff: 2s, 4s, 8s, etc.)
			waitTime := time.Duration(1<<uint(attempt)) * time.Second
			log.Printf("   Clone failed, waiting %v before retry...", waitTime)
			time.Sleep(waitTime)
		}
	}

	return fmt.Errorf("all %d attempts failed, last error: %w", maxRetries, lastErr)
}

// cloneRepo clones a git repository with timeout and context cancellation support
func cloneRepo(ctx context.Context, repoURL, destDir string) error {
	// Create context with 5 minute timeout
	cloneCtx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()

	// Use CommandContext so git respects context cancellation
	cmd := exec.CommandContext(cloneCtx, "git", "clone", "--depth", "1", "--no-single-branch", repoURL, destDir)

	output, err := cmd.CombinedOutput()
	if err != nil {
		// Check if it was a timeout or cancellation
		if cloneCtx.Err() == context.DeadlineExceeded {
			return fmt.Errorf("git clone timed out after 5 minutes (repo: %s). Check network connectivity or try a smaller repository", repoURL)
		}
		if cloneCtx.Err() == context.Canceled {
			return fmt.Errorf("git clone cancelled (repo: %s)", repoURL)
		}
		return fmt.Errorf("git clone failed: %w\nOutput: %s", err, string(output))
	}

	return nil
}

// checkoutCommit checks out a specific commit with context cancellation support
func checkoutCommit(ctx context.Context, repoDir, commit string) error {
	// First, fetch the commit if it's not available (in case --depth=1 didn't get it)
	fetchCtx, fetchCancel := context.WithTimeout(ctx, 5*time.Minute)
	defer fetchCancel()

	fetchCmd := exec.CommandContext(fetchCtx, "git", "fetch", "origin", commit)
	fetchCmd.Dir = repoDir

	// Fetch might fail if commit already exists locally, that's okay
	fetchOutput, fetchErr := fetchCmd.CombinedOutput()
	if fetchErr != nil {
		if fetchCtx.Err() == context.DeadlineExceeded {
			return fmt.Errorf("git fetch timed out after 5 minutes (commit: %s). Check network connectivity", commit)
		}
		if fetchCtx.Err() == context.Canceled {
			return fmt.Errorf("git fetch cancelled (commit: %s)", commit)
		}
	}

	// Now checkout the commit
	checkoutCmd := exec.CommandContext(ctx, "git", "checkout", commit)
	checkoutCmd.Dir = repoDir

	output, err := checkoutCmd.CombinedOutput()
	if err != nil {
		if ctx.Err() == context.Canceled {
			return fmt.Errorf("git checkout cancelled (commit: %s)", commit)
		}
		// Provide helpful error message with fetch output if available
		errMsg := fmt.Sprintf("git checkout failed (commit: %s): %v\nCheckout output: %s", commit, err, string(output))
		if fetchErr != nil {
			errMsg += fmt.Sprintf("\nFetch output: %s", string(fetchOutput))
		}
		return fmt.Errorf("%s", errMsg)
	}

	return nil
}

// getVenvBinDir returns the bin/Scripts directory inside a venv (platform-specific)
func getVenvBinDir(venvPath string) string {
	if runtime.GOOS == "windows" {
		return filepath.Join(venvPath, "Scripts")
	}
	return filepath.Join(venvPath, "bin")
}

// getVenvPython returns the path to the Python executable inside a venv (platform-specific)
func getVenvPython(venvPath string) string {
	if runtime.GOOS == "windows" {
		return filepath.Join(venvPath, "Scripts", "python.exe")
	}
	return filepath.Join(venvPath, "bin", "python")
}

// runInstallCommands executes installation commands in the repository directory with context cancellation support
func runInstallCommands(ctx context.Context, repoDir string, commands []string) error {
	// Check if we need to set up a Python virtual environment
	needsVenv := false
	for _, cmd := range commands {
		if strings.Contains(cmd, "pip") || strings.Contains(cmd, "python") {
			needsVenv = true
			break
		}
	}

	// Create and activate virtual environment if needed
	venvPath := ""
	if needsVenv {
		venvPath = filepath.Join(repoDir, ".venv")

		pythonBinary := findPythonBinary()

		// Create virtual environment
		venvCmd := exec.CommandContext(ctx, pythonBinary, "-m", "venv", venvPath)
		venvCmd.Dir = repoDir
		if output, err := venvCmd.CombinedOutput(); err != nil {
			if ctx.Err() == context.Canceled {
				return fmt.Errorf("venv creation cancelled")
			}
			return fmt.Errorf("failed to create virtual environment: %w\nOutput: %s", err, string(output))
		}
	}

	for i, cmdStr := range commands {
		// If we have a venv and this is a Python command, use the venv's Python
		if venvPath != "" && (strings.HasPrefix(cmdStr, "python ") || cmdStr == "python") {
			venvPython := getVenvPython(venvPath)
			cmdStr = strings.Replace(cmdStr, "python", venvPython, 1)
		}

		// Parse command string into parts
		parts := parseCommand(cmdStr)
		if len(parts) == 0 {
			continue
		}

		// Log which command we're running
		log.Printf("   [%d/%d] Running: %s", i+1, len(commands), cmdStr)

		// Create context with 10 minute timeout per install command
		installCtx, installCancel := context.WithTimeout(ctx, 10*time.Minute)
		defer installCancel()

		cmd := exec.CommandContext(installCtx, parts[0], parts[1:]...)
		cmd.Dir = repoDir

		// Set up environment with venv activated if needed
		env := os.Environ()
		if venvPath != "" {
			// Update PATH to include venv bin directory first
			// Use os.PathListSeparator for cross-platform compatibility (: on Unix, ; on Windows)
			venvBinDir := getVenvBinDir(venvPath)
			env = append(env, fmt.Sprintf("PATH=%s%c%s", venvBinDir, os.PathListSeparator, os.Getenv("PATH")))
			env = append(env, fmt.Sprintf("VIRTUAL_ENV=%s", venvPath))
		}
		env = append(env, "PYTHONUNBUFFERED=1") // For better output streaming
		cmd.Env = env

		output, err := cmd.CombinedOutput()
		if err != nil {
			if installCtx.Err() == context.DeadlineExceeded {
				return fmt.Errorf("install command %d timed out after 10 minutes (%s). This may indicate a hung installation or missing dependencies",
					i+1, cmdStr)
			}
			if installCtx.Err() == context.Canceled {
				return fmt.Errorf("install command %d cancelled (%s)", i+1, cmdStr)
			}
			return fmt.Errorf("install command %d failed (%s): %w\nOutput: %s",
				i+1, cmdStr, err, string(output))
		}
	}

	return nil
}

// parseCommand splits a command string into parts, respecting quotes
// Simple implementation - doesn't handle all shell syntax
func parseCommand(cmdStr string) []string {
	var parts []string
	var current strings.Builder
	inQuote := false
	quoteChar := rune(0)

	for _, ch := range cmdStr {
		switch {
		case ch == '"' || ch == '\'':
			if !inQuote {
				inQuote = true
				quoteChar = ch
			} else if ch == quoteChar {
				inQuote = false
				quoteChar = 0
			} else {
				current.WriteRune(ch)
			}
		case ch == ' ' && !inQuote:
			if current.Len() > 0 {
				parts = append(parts, current.String())
				current.Reset()
			}
		default:
			current.WriteRune(ch)
		}
	}

	if current.Len() > 0 {
		parts = append(parts, current.String())
	}

	return parts
}
