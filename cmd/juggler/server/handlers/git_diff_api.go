//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strconv"
	"strings"
)

// Diff bounds. A diff is read to be looked at, so the ceilings are the size of a
// thing a person can scroll rather than the size of a thing git can produce: a
// generated file rewritten wholesale is the common way to meet them, and it is
// better answered with the first few thousand lines and a note than with a
// megabyte nobody reads.
const (
	gitDiffContext  = 3       // lines of context git is asked for around each hunk
	gitDiffMaxLines = 20000   // diff lines returned before the rest is dropped
	gitDiffMaxBytes = 8 << 20 // patch bytes read from git before it is cut short
	gitDiffSniff    = 8000    // bytes of an untracked file read to judge it binary
)

// gitDiffLine is one line of a hunk. Old and New are the line's number on each
// side, and are 0 on the side the line does not exist — an added line has no
// number in the old file. Text carries no leading +/-/space: which side a line
// is on is Kind's job, not the text's.
type gitDiffLine struct {
	Kind string `json:"kind"` // "context", "add" or "remove"
	Old  int    `json:"oldLine,omitempty"`
	New  int    `json:"newLine,omitempty"`
	Text string `json:"text"`
}

// gitDiffHunk is one run of changed lines and the context around it, with the
// range it covers on each side. Heading is the section git names in the `@@`
// line — usually the enclosing function — and is often empty.
type gitDiffHunk struct {
	OldStart int           `json:"oldStart"`
	OldLines int           `json:"oldLines"`
	NewStart int           `json:"newStart"`
	NewLines int           `json:"newLines"`
	Heading  string        `json:"heading,omitempty"`
	Lines    []gitDiffLine `json:"lines"`
}

// gitDiffResponse is the JSON response shape for GET /api/git/diff: one file's
// working tree against HEAD. Status is what happened to the file rather than a
// porcelain letter, because a reader is being told a story about the file and
// not asked to decode one.
type gitDiffResponse struct {
	Repo      string        `json:"repo"`
	Path      string        `json:"path"`
	OldPath   string        `json:"oldPath,omitempty"`
	Status    string        `json:"status"` // modified, added, deleted, renamed, untracked, unchanged
	Binary    bool          `json:"binary"`
	Truncated bool          `json:"truncated"`
	Added     int           `json:"added"`
	Removed   int           `json:"removed"`
	Hunks     []gitDiffHunk `json:"hunks"`
}

// HandleGitDiff handles GET /api/git/diff?repo=<rel>&path=<rel>. It answers with
// one file's whole working-tree change relative to HEAD — index and worktree
// together, the same comparison the status card's line counts are taken from, so
// a file's diffstat there and its diff here can never disagree.
//
// `repo` locates the repository within the project ("" for the root repo) and
// `path` locates the file within that repository. Both are relative and are
// refused if they climb out of where they belong: this endpoint reads whatever
// it is pointed at, so where it may be pointed is the whole of its security.
func (a *GitStatusAPI) HandleGitDiff(w http.ResponseWriter, r *http.Request) {
	root := a.pathProvider()
	if root == "" {
		WriteError(w, r, http.StatusBadRequest, "No project is open")
		return
	}

	repoRel, ok := cleanRepoRelative(r.URL.Query().Get("repo"))
	if !ok {
		WriteError(w, r, http.StatusBadRequest, "Not a path inside the project: repo")
		return
	}
	fileRel, ok := cleanRepoRelative(r.URL.Query().Get("path"))
	if !ok || fileRel == "" {
		WriteError(w, r, http.StatusBadRequest, "Not a path inside the repository: path")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), gitStatusBudget)
	defer cancel()

	dir, ok := resolveRepoDir(ctx, root, repoRel)
	if !ok {
		WriteError(w, r, http.StatusBadRequest, "Not a repository in this project: repo")
		return
	}
	abs := filepath.Join(dir, filepath.FromSlash(fileRel))
	if !withinDir(abs, dir) {
		WriteError(w, r, http.StatusBadRequest, "Not a path inside the repository: path")
		return
	}

	resp := gitDiffResponse{Repo: repoRel, Path: fileRel, Status: "unchanged", Hunks: []gitDiffHunk{}}

	patch, truncated, err := gitFilePatch(ctx, dir, fileRel)
	if err != nil {
		WriteError(w, r, http.StatusBadGateway, "Couldn't read the diff. "+err.Error())
		return
	}
	resp.Truncated = truncated
	if len(patch) > 0 {
		parseGitPatch(patch, &resp)
		WriteJSON(w, r, 0, resp)
		return
	}

	// Nothing from `git diff` is either an unchanged file or one git has never
	// been told about, and only the second has anything to show. An untracked
	// file is diffed here rather than by `--no-index` against the null device,
	// which is spelled differently on each platform for a file we have to read
	// anyway to know whether it is text.
	if untracked, uerr := gitIsUntracked(ctx, dir, fileRel); uerr == nil && untracked {
		untrackedDiff(abs, &resp)
	}
	WriteJSON(w, r, 0, resp)
}

// resolveRepoDir turns the client's `repo` into the directory git runs in, and
// refuses anything that is not a repository this project actually contains.
// Without that check an ordinary subdirectory is accepted, and git — which looks
// upward for a repository when the directory it is given is not one — answers
// from whatever repository sits above the project, which may be one the user
// never opened.
func resolveRepoDir(ctx context.Context, root, repoRel string) (string, bool) {
	dir := filepath.Join(root, filepath.FromSlash(repoRel))
	for _, found := range discoverRepos(ctx, root) {
		if resolvedPath(found) == resolvedPath(dir) {
			return dir, true
		}
	}
	return "", false
}

// withinDir reports whether abs lives inside dir once every symlink in both has
// been resolved. A path can be lexically innocent and still leave the project by
// passing through a symlinked directory, and resolving it is the only way to
// find that out.
func withinDir(abs, dir string) bool {
	realAbs, realDir := resolvedPath(abs), resolvedPath(dir)
	if realAbs == realDir {
		return false
	}
	return strings.HasPrefix(realAbs, realDir+string(filepath.Separator))
}

// resolvedPath is a path with its symlinks followed. Resolving matters even for
// paths nobody is trying to abuse: macOS hands out temporary directories under
// /var, which is itself a symlink to /private/var, so an unresolved path can
// fail to match a resolved one that names the same place.
//
// A path that does not exist cannot be resolved, and a deleted file still has a
// diff to show, so the deepest ancestor that does exist is resolved instead and
// the rest of the path put back on the end. Comparing the literal path in that
// case would be the bug it looks like a shortcut for: every path below a
// symlinked ancestor would stop matching the directory it is inside.
func resolvedPath(p string) string {
	p = filepath.Clean(p)
	if real, err := filepath.EvalSymlinks(p); err == nil {
		return filepath.Clean(real)
	}
	rest := ""
	for {
		parent := filepath.Dir(p)
		rest = filepath.Join(filepath.Base(p), rest)
		if parent == p {
			return filepath.Clean(filepath.Join(p, rest))
		}
		p = parent
		if real, err := filepath.EvalSymlinks(p); err == nil {
			return filepath.Clean(filepath.Join(real, rest))
		}
	}
}

// cleanRepoRelative normalises a client-supplied relative path and rejects one
// that is absolute or climbs above where it is anchored. "" is allowed and means
// the anchor itself, which is how the root repository names itself.
//
// These paths are slash-separated whatever the client is, and they are judged
// here without the host's path rules: `filepath` answers for the machine the
// server happens to run on, which would make what escapes a property of the
// server rather than of the path. A backslash is refused outright for the same
// reason — folding it to a separator, which is what ToSlash does on Windows,
// turns `web\js\app.js` and `C:\Windows` into ordinary-looking relative paths
// that every check below then waves through.
func cleanRepoRelative(raw string) (string, bool) {
	rel := strings.TrimSpace(raw)
	if rel == "" {
		return "", true
	}
	if strings.ContainsAny(rel, "\\\x00") || strings.HasPrefix(rel, "/") || hasDriveLetter(rel) {
		return "", false
	}
	cleaned := path.Clean(rel)
	if cleaned == ".." || strings.HasPrefix(cleaned, "../") || cleaned == "." {
		return "", false
	}
	return cleaned, true
}

// hasDriveLetter reports whether a path opens with a Windows drive specifier
// such as "C:". It is absolute on Windows and names nothing anywhere else, so
// it is refused wherever the server is running.
func hasDriveLetter(p string) bool {
	if len(p) < 2 || p[1] != ':' {
		return false
	}
	return (p[0] >= 'a' && p[0] <= 'z') || (p[0] >= 'A' && p[0] <= 'Z')
}

// gitFilePatch runs the diff for one path and returns its raw patch text, empty
// when the file is unchanged or untracked, and whether the patch was cut short.
// The flags match the status poll's for the same reasons — no index.lock, no
// path escaping — plus the ones that keep the output parseable and the ones that
// keep it inert: no colour, and no external diff driver or textconv filter,
// either of which would run a command out of the repository's own configuration.
func gitFilePatch(ctx context.Context, dir, fileRel string) ([]byte, bool, error) {
	cctx, cancel := context.WithTimeout(ctx, gitStatusPerCmd)
	defer cancel()

	cmd := exec.CommandContext(cctx, "git",
		"--no-optional-locks", "-c", "core.quotePath=false", "-c", "diff.external=",
		"diff", "--no-color", "--no-ext-diff", "--no-textconv", "--find-renames",
		"--unified="+strconv.Itoa(gitDiffContext), "HEAD", "--", fileRel)
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		if cctx.Err() != nil {
			return nil, false, cctx.Err()
		}
		// An unborn repository has no HEAD to compare against; everything in it is
		// untracked, which the caller handles. Every other failure is a failure and
		// is reported as one — read as an empty diff it would become the claim that
		// a file did not change, which is the one thing this must never say wrongly.
		var exit *exec.ExitError
		if errors.As(err, &exit) && bytes.Contains(exit.Stderr, []byte("unknown revision")) {
			return nil, false, nil
		}
		return nil, false, err
	}
	patch, truncated := capAtLineBoundary(out)
	return patch, truncated, nil
}

// capAtLineBoundary limits how much text is read, cutting at the last line
// boundary below the ceiling so that what survives ends in a whole line. Half a
// line would parse as a real line holding half its text, which is a worse answer
// than the line being absent, and the bool is how the caller knows to say so.
func capAtLineBoundary(b []byte) ([]byte, bool) {
	if len(b) <= gitDiffMaxBytes {
		return b, false
	}
	cut := b[:gitDiffMaxBytes]
	if i := bytes.LastIndexByte(cut, '\n'); i >= 0 {
		cut = cut[:i+1]
	}
	return cut, true
}

// gitIsUntracked reports whether git has never been told about this path. A
// missing file is not untracked — it is nothing — so a path git does not know
// and disk does not hold is reported as tracked-and-unchanged, which is what an
// empty diff already said.
func gitIsUntracked(ctx context.Context, dir, fileRel string) (bool, error) {
	if _, err := os.Stat(filepath.Join(dir, filepath.FromSlash(fileRel))); err != nil {
		return false, nil
	}
	cmd := exec.CommandContext(ctx, "git", "--no-optional-locks",
		"ls-files", "--error-unmatch", "--", fileRel)
	cmd.Dir = dir
	if err := cmd.Run(); err != nil {
		return true, nil
	}
	return false, nil
}

// untrackedDiff fills resp with a file that is entirely new: one hunk holding
// every line, added. A binary file says so and shows nothing, exactly as git
// would have.
func untrackedDiff(abs string, resp *gitDiffResponse) {
	// Lstat rather than Stat: a symlink is a pointer, and the bytes on the other
	// end of it may be anywhere on disk. An untracked link is a link — it is
	// reported as present and shown as nothing, because there is no honest way to
	// render whatever it names as the contents of a file inside the project.
	info, err := os.Lstat(abs)
	if err != nil {
		return
	}
	if !info.Mode().IsRegular() {
		resp.Status = "untracked"
		return
	}

	data, err := os.ReadFile(abs) //nolint:gosec // path is validated and symlinks are refused above
	if err != nil {
		return
	}
	resp.Status = "untracked"
	sniff := data
	if len(sniff) > gitDiffSniff {
		sniff = sniff[:gitDiffSniff]
	}
	if bytes.IndexByte(sniff, 0) >= 0 {
		resp.Binary = true
		return
	}
	data, cut := capAtLineBoundary(data)
	if cut {
		resp.Truncated = true
	}

	text := strings.TrimSuffix(string(data), "\n")
	if text == "" && len(data) == 0 {
		return
	}
	lines := strings.Split(text, "\n")
	hunk := gitDiffHunk{NewStart: 1, NewLines: len(lines), Lines: make([]gitDiffLine, 0, min(len(lines), gitDiffMaxLines))}
	for i, line := range lines {
		if len(hunk.Lines) >= gitDiffMaxLines {
			resp.Truncated = true
			break
		}
		hunk.Lines = append(hunk.Lines, gitDiffLine{Kind: "add", New: i + 1, Text: strings.TrimSuffix(line, "\r")})
	}
	// The count is every line the file adds, not every line shown: a truncated
	// response still tells the truth about the size of the change.
	resp.Added = len(lines)
	resp.Hunks = append(resp.Hunks, hunk)
}

// parseGitPatch reads a unified patch for a single file into resp.
//
// The header block before the first `@@` says what happened to the file; the
// hunks say what happened inside it. A line git wrote in a shape this does not
// understand is skipped rather than failing the diff, on the same grounds as the
// status parser: a diff missing one line is worth more than no diff.
func parseGitPatch(patch []byte, resp *gitDiffResponse) {
	resp.Status = "modified"

	var hunk *gitDiffHunk
	oldLine, newLine := 0, 0
	emitted := 0

	// add records one parsed line, keeping it only while the response is still
	// under its ceiling — which is a ceiling on the whole diff and not on each
	// hunk, or a file of ten thousand small hunks would never meet it. Counting
	// carries on past the ceiling, so Added and Removed describe the whole change
	// even once the lines shown stop doing so.
	add := func(l gitDiffLine) {
		if emitted >= gitDiffMaxLines {
			resp.Truncated = true
			return
		}
		hunk.Lines = append(hunk.Lines, l)
		emitted++
	}

	sc := bufio.NewScanner(bytes.NewReader(patch))
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		line := sc.Text()

		if strings.HasPrefix(line, "@@") {
			if hunk != nil {
				resp.Hunks = append(resp.Hunks, *hunk)
			}
			next, ok := parseHunkHeader(line)
			if !ok {
				hunk = nil
				continue
			}
			hunk = &next
			oldLine, newLine = next.OldStart, next.NewStart
			continue
		}

		if hunk == nil {
			parseGitPatchHeader(line, resp)
			continue
		}

		// "\ No newline at end of file" annotates the line above rather than
		// being one, and the trailing "--" of a mail-formatted patch is not a
		// removal. Neither belongs in the hunk.
		if strings.HasPrefix(line, `\`) {
			continue
		}
		switch {
		case strings.HasPrefix(line, "+"):
			add(gitDiffLine{Kind: "add", New: newLine, Text: line[1:]})
			newLine++
			resp.Added++
		case strings.HasPrefix(line, "-"):
			add(gitDiffLine{Kind: "remove", Old: oldLine, Text: line[1:]})
			oldLine++
			resp.Removed++
		case strings.HasPrefix(line, " ") || line == "":
			// An all-whitespace context line reaches us stripped of its single
			// leading space by whatever wrote the patch; an empty one is an empty
			// context line, not a hunk boundary.
			text := ""
			if line != "" {
				text = line[1:]
			}
			add(gitDiffLine{Kind: "context", Old: oldLine, New: newLine, Text: text})
			oldLine++
			newLine++
		default:
			// A header for the next file in a multi-file patch — which this is
			// not asked for — ends the hunk rather than joining it.
			resp.Hunks = append(resp.Hunks, *hunk)
			hunk = nil
			parseGitPatchHeader(line, resp)
		}
	}
	// A scan that stopped early — a line longer than the buffer is the way it
	// happens — leaves the rest of the patch unread. Unsaid, that reaches the
	// reader as a whole diff of a file with fewer hunks than it really has.
	if sc.Err() != nil {
		resp.Truncated = true
	}
	if hunk != nil {
		resp.Hunks = append(resp.Hunks, *hunk)
	}
}

// parseGitPatchHeader applies one line of a patch's header block to resp.
func parseGitPatchHeader(line string, resp *gitDiffResponse) {
	switch {
	case strings.HasPrefix(line, "new file mode"):
		resp.Status = "added"
	case strings.HasPrefix(line, "deleted file mode"):
		resp.Status = "deleted"
	case strings.HasPrefix(line, "rename from "):
		resp.Status = "renamed"
		resp.OldPath = strings.TrimPrefix(line, "rename from ")
	case strings.HasPrefix(line, "Binary files ") || strings.HasPrefix(line, "GIT binary patch"):
		resp.Binary = true
	}
}

// parseHunkHeader reads `@@ -oldStart,oldLines +newStart,newLines @@ heading`.
// A one-line range omits its count, which is what the missing comma means.
func parseHunkHeader(line string) (gitDiffHunk, bool) {
	body := strings.TrimPrefix(line, "@@")
	ranges, heading, found := strings.Cut(body, "@@")
	if !found {
		return gitDiffHunk{}, false
	}

	var hunk gitDiffHunk
	seen := 0
	for _, field := range strings.Fields(ranges) {
		start, count, ok := parseHunkRange(field)
		if !ok {
			continue
		}
		if strings.HasPrefix(field, "-") {
			hunk.OldStart, hunk.OldLines = start, count
		} else {
			hunk.NewStart, hunk.NewLines = start, count
		}
		seen++
	}
	if seen != 2 {
		return gitDiffHunk{}, false
	}

	hunk.Heading = strings.TrimSpace(heading)
	hunk.Lines = []gitDiffLine{}
	return hunk, true
}

// parseHunkRange reads one "-58,6" or "+60" side of a hunk header.
func parseHunkRange(field string) (int, int, bool) {
	if len(field) < 2 || (field[0] != '-' && field[0] != '+') {
		return 0, 0, false
	}
	startText, countText, hasCount := strings.Cut(field[1:], ",")
	start, err := strconv.Atoi(startText)
	if err != nil {
		return 0, 0, false
	}
	count := 1
	if hasCount {
		count, err = strconv.Atoi(countText)
		if err != nil {
			return 0, 0, false
		}
	}
	return start, count, true
}
