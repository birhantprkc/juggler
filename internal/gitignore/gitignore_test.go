//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitignore

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// writeFile writes content to root/rel, creating parent directories.
func writeFile(t *testing.T, root, rel, content string) {
	t.Helper()
	abs := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(abs, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// mkdir creates root/rel as a directory.
func mkdir(t *testing.T, root, rel string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(root, filepath.FromSlash(rel)), 0o755); err != nil {
		t.Fatal(err)
	}
}

// buildFixture creates a git-safe fixture tree (no nested repos, no always-
// ignored .juggler) usable by both the table test and the git-parity test. The
// root is a real git repo (has .git) so .git/info/exclude is exercised.
func buildFixture(t *testing.T) string {
	t.Helper()
	root := t.TempDir()

	writeFile(t, root, ".gitignore", strings.Join([]string{
		"# a comment",
		"*.log",
		"!important.log",
		"/build",
		"doc/frotz",
		"temp?",
		"data[0-9].bin",
		"cache/",
		"**/generated",
		"foo/**/bar",
		`\#literal`,
	}, "\n")+"\n")

	// A repo-root marker so root counts as a repo boundary, plus info/exclude.
	mkdir(t, root, ".git")
	writeFile(t, root, ".git/info/exclude", "secret.key\n")

	// *.log / negation
	writeFile(t, root, "app.log", "x")
	writeFile(t, root, "important.log", "x")

	// /build anchored to root; src/build is NOT ignored
	writeFile(t, root, "build/output.o", "x")
	writeFile(t, root, "src/build/keep.go", "x")

	// doc/frotz anchored (interior slash) → only at root
	writeFile(t, root, "doc/frotz/a.txt", "x")
	writeFile(t, root, "a/doc/frotz/b.txt", "x")

	// temp? single-char wildcard
	writeFile(t, root, "temp1", "x")
	writeFile(t, root, "tempAB", "x")

	// data[0-9].bin char class
	writeFile(t, root, "data5.bin", "x")
	writeFile(t, root, "dataX.bin", "x")

	// cache/ dir-only: dir ignored, a file named cache is not
	writeFile(t, root, "cache/f", "x")
	writeFile(t, root, "x/cache", "x")

	// **/generated at any depth
	writeFile(t, root, "generated/top", "x")
	writeFile(t, root, "deep/generated/z", "x")

	// foo/**/bar
	writeFile(t, root, "foo/x/y/bar", "x")
	writeFile(t, root, "foo/x/y/baz", "x")

	// escaped literal hash
	writeFile(t, root, "#literal", "x")

	// deeper-file precedence: sub/.gitignore re-includes keep.log
	writeFile(t, root, "sub/.gitignore", "!keep.log\n")
	writeFile(t, root, "sub/keep.log", "x")
	writeFile(t, root, "sub/other.log", "x")

	// info/exclude
	writeFile(t, root, "secret.key", "x")

	return root
}

func TestMatcherTable(t *testing.T) {
	root := buildFixture(t)
	m := NewMatcher(root)

	cases := []struct {
		path  string
		isDir bool
		want  bool
	}{
		{"app.log", false, true},
		{"important.log", false, false},
		{"build", true, true},
		{"build/output.o", false, true}, // excluded parent
		{"src/build", true, false},
		{"src/build/keep.go", false, false},
		{"doc/frotz", true, true},
		{"doc/frotz/a.txt", false, true},
		{"a/doc/frotz", true, false},
		{"a/doc/frotz/b.txt", false, false},
		{"temp1", false, true},
		{"tempAB", false, false},
		{"data5.bin", false, true},
		{"dataX.bin", false, false},
		{"cache", true, true},
		{"cache/f", false, true},
		{"x/cache", false, false}, // dir-only pattern does not match a file
		{"generated", true, true},
		{"deep/generated", true, true},
		{"deep/generated/z", false, true},
		{"foo/x/y/bar", false, true},
		{"foo/x/y/baz", false, false},
		{"#literal", false, true},
		{"sub/keep.log", false, false}, // re-included by deeper file
		{"sub/other.log", false, true},
		{"secret.key", false, true}, // .git/info/exclude
		{".git", true, true},
		{".juggler", true, true},
		{"nested/.juggler/state", false, true},
	}

	for _, c := range cases {
		if got := m.Ignored(c.path, c.isDir); got != c.want {
			t.Errorf("Ignored(%q, isDir=%v) = %v, want %v", c.path, c.isDir, got, c.want)
		}
	}
}

func TestNestedRepoDir(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, ".gitignore", "*.tmp\n")
	writeFile(t, root, "outer.tmp", "x")
	// nested repo marked by a .git directory
	mkdir(t, root, "nested/.git")
	writeFile(t, root, "nested/.gitignore", "keep\n")
	writeFile(t, root, "nested/inner.tmp", "x")
	writeFile(t, root, "nested/keep", "x")

	m := NewMatcher(root)
	if !m.Ignored("outer.tmp", false) {
		t.Error("outer.tmp should be ignored by outer *.tmp")
	}
	if m.Ignored("nested/inner.tmp", false) {
		t.Error("nested/inner.tmp must NOT inherit the outer *.tmp (fresh context)")
	}
	if !m.Ignored("nested/keep", false) {
		t.Error("nested/keep should be ignored by the nested repo's own rule")
	}
}

func TestNestedRepoGitfile(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, ".gitignore", "*.tmp\n")
	// nested repo marked by a .git FILE (submodule/worktree form)
	writeFile(t, root, "mod/.git", "gitdir: /somewhere/.git/modules/mod\n")
	writeFile(t, root, "mod/inner.tmp", "x")

	m := NewMatcher(root)
	if m.Ignored("mod/inner.tmp", false) {
		t.Error("gitfile should also start a fresh context; mod/inner.tmp must not be ignored")
	}
}

func TestNilMatcher(t *testing.T) {
	var m *Matcher
	if m.Ignored("anything/at/all.log", false) {
		t.Error("nil matcher must report nothing ignored")
	}
}

func TestCacheRevalidation(t *testing.T) {
	root := t.TempDir()
	gi := filepath.Join(root, ".gitignore")
	if err := os.WriteFile(gi, []byte("*.log\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	if !NewMatcher(root).Ignored("a.log", false) {
		t.Fatal("a.log should be ignored initially")
	}
	if NewMatcher(root).Ignored("a.txt", false) {
		t.Fatal("a.txt should not be ignored initially")
	}

	// Rewrite with different content and bump mtime forward so the size/mtime
	// stamp changes and the cache re-parses.
	if err := os.WriteFile(gi, []byte("*.txt\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	future := time.Now().Add(2 * time.Second)
	if err := os.Chtimes(gi, future, future); err != nil {
		t.Fatal(err)
	}

	if NewMatcher(root).Ignored("a.log", false) {
		t.Error("after edit, a.log should no longer be ignored")
	}
	if !NewMatcher(root).Ignored("a.txt", false) {
		t.Error("after edit, a.txt should be ignored")
	}
}

// TestGitParity builds the fixture, then walks it and compares every entry's
// verdict against `git check-ignore`. Skipped when git is unavailable.
func TestGitParity(t *testing.T) {
	gitPath, err := exec.LookPath("git")
	if err != nil {
		t.Skip("git not available; skipping parity test")
	}

	root := buildFixture(t)
	// buildFixture writes a bare .git/info/exclude under a plain directory; make
	// it a real repo so check-ignore reads the same info/exclude.
	if err := os.RemoveAll(filepath.Join(root, ".git")); err != nil {
		t.Fatal(err)
	}
	runGit(t, gitPath, root, "init", "-q")
	writeFile(t, root, ".git/info/exclude", "secret.key\n")

	// Collect every entry (dirs with a trailing slash so check-ignore applies
	// dir-only patterns), skipping the .git directory.
	var paths []string
	rels := map[string]bool{}
	err = filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		rel, _ := filepath.Rel(root, p)
		rel = filepath.ToSlash(rel)
		if rel == "." {
			return nil
		}
		if rel == ".git" || strings.HasPrefix(rel, ".git/") {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		q := rel
		if d.IsDir() {
			q = rel + "/"
		}
		paths = append(paths, q)
		rels[q] = d.IsDir()
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}

	ignoredByGit := gitCheckIgnore(t, gitPath, root, paths)

	m := NewMatcher(root)
	for _, q := range paths {
		isDir := rels[q]
		rel := strings.TrimSuffix(q, "/")
		got := m.Ignored(rel, isDir)
		want := ignoredByGit[q]
		if got != want {
			t.Errorf("parity mismatch for %q (isDir=%v): matcher=%v git=%v", rel, isDir, got, want)
		}
	}
}

func runGit(t *testing.T, gitPath, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command(gitPath, args...)
	cmd.Dir = dir
	cmd.Env = gitEnv(dir)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v failed: %v\n%s", args, err, out)
	}
}

// gitCheckIgnore returns the set of paths (verbatim, including trailing slash)
// that git reports as ignored.
func gitCheckIgnore(t *testing.T, gitPath, dir string, paths []string) map[string]bool {
	t.Helper()
	cmd := exec.Command(gitPath, "check-ignore", "--no-index", "--stdin")
	cmd.Dir = dir
	cmd.Env = gitEnv(dir)
	cmd.Stdin = strings.NewReader(strings.Join(paths, "\n") + "\n")
	var out bytes.Buffer
	cmd.Stdout = &out
	// Exit code 1 means "nothing matched" — not an error for our purposes.
	_ = cmd.Run()

	result := map[string]bool{}
	for _, line := range strings.Split(out.String(), "\n") {
		line = strings.TrimRight(line, "\r")
		if line != "" {
			result[line] = true
		}
	}
	return result
}

// gitEnv isolates git from the developer's global/system config so the parity
// comparison reflects only the fixture's own ignore files.
func gitEnv(dir string) []string {
	return append(os.Environ(),
		"HOME="+dir,
		"GIT_CONFIG_GLOBAL=/dev/null",
		"GIT_CONFIG_SYSTEM=/dev/null",
		"GIT_AUTHOR_NAME=t",
		"GIT_AUTHOR_EMAIL=t@t",
		"GIT_COMMITTER_NAME=t",
		"GIT_COMMITTER_EMAIL=t@t",
	)
}
