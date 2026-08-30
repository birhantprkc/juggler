//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"bufio"
	"bytes"
	"context"
	"io/fs"
	"net/http"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// GitStatusAPI summarises the working-tree state of every git repository found
// under the current project — the root repo plus any nested subrepos/submodules
// — for the "Git status" info card and pinboard pin. The project path is read
// through a provider func so a runtime project switch retargets the scan.
type GitStatusAPI struct {
	pathProvider func() string
}

// NewGitStatusAPI creates a new GitStatusAPI. pathProvider must return the
// current project path on each call ("" when no project is loaded).
func NewGitStatusAPI(pathProvider func() string) *GitStatusAPI {
	return &GitStatusAPI{pathProvider: pathProvider}
}

// Repo-discovery bounds. The walk is deliberately shallow — a git repo lives at
// the top of its tree, so scanning a few levels catches the root repo and its
// direct submodules without risking a long recursive crawl of a deep source tree.
const (
	gitScanMaxDepth  = 4   // directory levels below the project root to descend
	gitScanMaxRepos  = 32  // stop discovering after this many repos
	gitStatusMaxFile = 200 // per repo, the most files listed individually
	gitStatusPerCmd  = 3 * time.Second
	gitStatusBudget  = 6 * time.Second
)

// gitFileStatus is one file in a repository's working tree. Index and Worktree
// are porcelain status letters — "M", "A", "D", "?" and so on — where "." means
// that side is unmodified.
type gitFileStatus struct {
	Path     string `json:"path"`
	Index    string `json:"index"`
	Worktree string `json:"worktree"`
}

// gitRepoStatus is one repository's summary. Path is relative to the project
// root ("" for the root repo itself), always forward-slashed. Files is bounded
// at gitStatusMaxFile entries; Truncated says the tree holds more than that and
// Total says how many. Changed, Staged and Total count the whole tree either way.
type gitRepoStatus struct {
	Path      string          `json:"path"`
	Changed   int             `json:"changed"` // files with working-tree changes (incl. untracked)
	Staged    int             `json:"staged"`  // files with staged (index) changes
	Total     int             `json:"total"`   // files git reported, listed or not
	Branch    string          `json:"branch"`  // "" on a detached head or an unreadable ref
	Upstream  string          `json:"upstream"`
	Ahead     int             `json:"ahead"`
	Behind    int             `json:"behind"`
	Detached  bool            `json:"detached"`
	Files     []gitFileStatus `json:"files"`
	Truncated bool            `json:"truncated"`
}

// gitStatusResponse is the JSON response shape for GET /api/git/status.
type gitStatusResponse struct {
	Root  string          `json:"root"`
	Repos []gitRepoStatus `json:"repos"`
}

// HandleGitStatus handles GET /api/git/status. It discovers repositories under
// the project root and reports each one's branch, divergence from its upstream,
// changed/staged counts and bounded file list. Results are best-effort: a repo
// whose `git status` fails (git missing, bare repo) is simply omitted rather
// than failing the whole response.
func (a *GitStatusAPI) HandleGitStatus(w http.ResponseWriter, r *http.Request) {
	root := a.pathProvider()
	resp := gitStatusResponse{Root: root, Repos: []gitRepoStatus{}}
	if root == "" {
		WriteJSON(w, r, 0, resp)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), gitStatusBudget)
	defer cancel()

	for _, dir := range discoverRepos(ctx, root) {
		status, ok := repoStatus(ctx, dir)
		if !ok {
			continue
		}
		rel, err := filepath.Rel(root, dir)
		if err != nil || rel == "." {
			rel = ""
		}
		status.Path = filepath.ToSlash(rel)
		resp.Repos = append(resp.Repos, status)
	}

	// Root repo first, then nested repos alphabetically — stable ordering so the
	// card doesn't reshuffle between polls.
	sort.SliceStable(resp.Repos, func(i, j int) bool {
		return resp.Repos[i].Path < resp.Repos[j].Path
	})

	WriteJSON(w, r, 0, resp)
}

// discoverRepos walks the project tree (bounded in depth, repo count, and pruned
// of heavy/uninteresting directories) and returns the absolute path of every
// directory that holds a `.git` entry. `.git` is a directory in a normal repo
// and a file in a submodule or linked worktree, so both are recognised. The walk
// aborts promptly if ctx is cancelled (e.g. the client disconnected).
func discoverRepos(ctx context.Context, root string) []string {
	var repos []string
	sep := string(filepath.Separator)

	_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // unreadable entry — skip it, keep walking
		}
		if ctx.Err() != nil {
			return filepath.SkipAll // request cancelled / budget spent — stop walking
		}
		if len(repos) >= gitScanMaxRepos {
			return filepath.SkipAll
		}

		if !d.IsDir() {
			// A `.git` file marks a submodule or linked-worktree repo root.
			if d.Name() == ".git" {
				repos = append(repos, filepath.Dir(p))
			}
			return nil
		}

		name := d.Name()
		if name == ".git" {
			repos = append(repos, filepath.Dir(p))
			return fs.SkipDir // never descend into git internals
		}
		if p == root {
			return nil // always scan the root itself
		}
		// Prune directories that are large and never repo roots we care about.
		switch name {
		case "node_modules", "vendor", "dist", "build", ".juggler":
			return fs.SkipDir
		}
		// Depth guard: stop descending past the configured level.
		if rel, rerr := filepath.Rel(root, p); rerr == nil {
			if strings.Count(rel, sep)+1 >= gitScanMaxDepth {
				return fs.SkipDir
			}
		}
		return nil
	})

	return repos
}

// repoStatus runs git in dir and summarises the working tree. ok is false when
// git could not report (missing binary, not a work tree, timeout), so the caller
// can omit the repo entirely. Path is left for the caller to fill in.
func repoStatus(ctx context.Context, dir string) (gitRepoStatus, bool) {
	cctx, cancel := context.WithTimeout(ctx, gitStatusPerCmd)
	defer cancel()

	// --no-optional-locks: this is a background poll, so never take index.lock to
	// write back refreshed stat info — that would contend with the user's own git
	// client mid-operation. Status is still computed correctly, just not persisted.
	//
	// core.quotePath=false stops git escaping non-ASCII paths, which would
	// otherwise reach the UI as \303\251 rather than é.
	//
	// Porcelain v2 with --branch reports the branch, its upstream, ahead/behind
	// and per-file detail in this one invocation — everything shown, for the cost
	// of the counts alone.
	cmd := exec.CommandContext(cctx, "git",
		"--no-optional-locks", "-c", "core.quotePath=false",
		"status", "--porcelain=v2", "--branch")
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		return gitRepoStatus{}, false
	}
	return parseGitStatusV2(out), true
}

// parseGitStatusV2 reads `git status --porcelain=v2 --branch` output.
//
// Header lines carry the branch and its divergence. Entry lines are keyed by
// their first field: "1" ordinary changes, "2" renames/copies, "u" unmerged, "?"
// untracked. Each carries an XY status pair where X is the index state, Y the
// working-tree state, and "." means that side is unmodified — so the counts are
// the v1 counts, spelled with "." where v1 spelled a space.
//
// A line git did not write in a shape this understands is skipped rather than
// failing the repo: a summary that omits one file is worth more than no summary.
func parseGitStatusV2(out []byte) gitRepoStatus {
	status := gitRepoStatus{Files: []gitFileStatus{}}

	sc := bufio.NewScanner(bytes.NewReader(out))
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		line := sc.Text()
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "# ") {
			parseGitBranchHeader(line[2:], &status)
			continue
		}

		kind, rest, found := strings.Cut(line, " ")
		if !found {
			continue
		}

		var index, worktree, path string
		switch kind {
		case "?":
			// Untracked. v1 wrote "??": unmodified in the index, present in the
			// working tree, which is why it counts as changed and not as staged.
			index, worktree, path = ".", "?", rest
		case "1", "2", "u":
			xy, tail, ok := strings.Cut(rest, " ")
			if !ok || len(xy) != 2 {
				continue
			}
			index, worktree = string(xy[0]), string(xy[1])
			path = gitEntryPath(kind, tail)
		default:
			continue
		}
		if path == "" {
			continue
		}

		status.Total++
		if index != "." {
			status.Staged++
		}
		if worktree != "." {
			status.Changed++
		}
		if len(status.Files) >= gitStatusMaxFile {
			status.Truncated = true
			continue
		}
		status.Files = append(status.Files, gitFileStatus{
			Path:     unquoteGitPath(path),
			Index:    index,
			Worktree: worktree,
		})
	}

	return status
}

// parseGitBranchHeader applies one "# branch.*" header to status. Anything else
// git puts in the header block is ignored.
func parseGitBranchHeader(header string, status *gitRepoStatus) {
	key, value, ok := strings.Cut(header, " ")
	if !ok {
		return
	}
	switch key {
	case "branch.head":
		// A detached head is reported as the literal "(detached)", which is a
		// state rather than a name — so say so, and leave the name empty.
		if value == "(detached)" {
			status.Detached = true
			return
		}
		status.Branch = value
	case "branch.upstream":
		status.Upstream = value
	case "branch.ab":
		ahead, behind, cut := strings.Cut(value, " ")
		if !cut {
			return
		}
		status.Ahead = gitCount(ahead)
		status.Behind = gitCount(behind)
	}
}

// gitEntryPath pulls the path out of an entry line's tail. A rename or copy
// ("2") ends with the new path, a tab, then the old one; everything else ends
// with the path alone. The fixed-width fields before it hold no spaces, so the
// path is what follows the last one.
func gitEntryPath(kind, tail string) string {
	fields := 6 // 1: <sub> <mH> <mI> <mW> <hH> <hI>
	switch kind {
	case "2":
		fields = 7 // plus <X><score>
	case "u":
		fields = 8 // <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3>
	}
	for i := 0; i < fields; i++ {
		_, rest, ok := strings.Cut(tail, " ")
		if !ok {
			return ""
		}
		tail = rest
	}
	if kind == "2" {
		path, _, _ := strings.Cut(tail, "\t")
		return path
	}
	return tail
}

// gitCount reads a signed "+3"/"-0" divergence count as a plain magnitude.
func gitCount(field string) int {
	n, err := strconv.Atoi(strings.TrimPrefix(field, "+"))
	if err != nil {
		return 0
	}
	if n < 0 {
		return -n
	}
	return n
}

// unquoteGitPath undoes the C-style quoting git falls back to for a path holding
// a quote, a newline or a control character. core.quotePath=false covers the
// common case of non-ASCII names; this covers the rest, and returns the path
// untouched when it was never quoted or cannot be read.
func unquoteGitPath(path string) string {
	if !strings.HasPrefix(path, `"`) {
		return path
	}
	if unquoted, err := strconv.Unquote(path); err == nil {
		return unquoted
	}
	return path
}
