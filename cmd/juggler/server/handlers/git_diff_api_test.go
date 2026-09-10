//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// newDiffResponse builds the zero value HandleGitDiff starts from, so a parser
// test sees the same starting state the handler would have given it.
func newDiffResponse() *gitDiffResponse {
	return &gitDiffResponse{Status: "unchanged", Hunks: []gitDiffHunk{}}
}

func parsePatch(t *testing.T, patch string) *gitDiffResponse {
	t.Helper()
	resp := newDiffResponse()
	parseGitPatch([]byte(patch), resp)
	return resp
}

// The fixtures are real `git diff` output, trimmed to the header lines that say
// something. What each test varies is the part it is about.
const modifiedPatch = `diff --git a/main.go b/main.go
index 1111111..2222222 100644
--- a/main.go
+++ b/main.go
@@ -10,6 +10,7 @@ func main() {
 	first
 	second
-	dropped
+	added one
+	added two
 	third
 	fourth
`

func TestGitDiffParsesHunkGeometry(t *testing.T) {
	got := parsePatch(t, modifiedPatch)

	if got.Status != "modified" {
		t.Errorf("Status = %q, want %q", got.Status, "modified")
	}
	if len(got.Hunks) != 1 {
		t.Fatalf("len(Hunks) = %d, want 1", len(got.Hunks))
	}
	h := got.Hunks[0]
	if h.OldStart != 10 || h.OldLines != 6 || h.NewStart != 10 || h.NewLines != 7 {
		t.Errorf("ranges = -%d,%d +%d,%d, want -10,6 +10,7", h.OldStart, h.OldLines, h.NewStart, h.NewLines)
	}
	if h.Heading != "func main() {" {
		t.Errorf("Heading = %q, want the section git named", h.Heading)
	}
	if got.Added != 2 || got.Removed != 1 {
		t.Errorf("Added/Removed = %d/%d, want 2/1", got.Added, got.Removed)
	}
}

func TestGitDiffNumbersEachLineOnItsOwnSide(t *testing.T) {
	got := parsePatch(t, modifiedPatch)
	h := got.Hunks[0]

	want := []gitDiffLine{
		{Kind: "context", Old: 10, New: 10, Text: "\tfirst"},
		{Kind: "context", Old: 11, New: 11, Text: "\tsecond"},
		{Kind: "remove", Old: 12, Text: "\tdropped"},
		{Kind: "add", New: 12, Text: "\tadded one"},
		{Kind: "add", New: 13, Text: "\tadded two"},
		{Kind: "context", Old: 13, New: 14, Text: "\tthird"},
		{Kind: "context", Old: 14, New: 15, Text: "\tfourth"},
	}
	if len(h.Lines) != len(want) {
		t.Fatalf("len(Lines) = %d, want %d", len(h.Lines), len(want))
	}
	for i, w := range want {
		if h.Lines[i] != w {
			t.Errorf("Lines[%d] = %+v, want %+v", i, h.Lines[i], w)
		}
	}
}

// A removed line has no number in the new file and an added line none in the
// old one. Carrying the other side's number would misplace the line in any view
// that trusts it, so the zero is load-bearing rather than merely absent.
func TestGitDiffLeavesTheAbsentSideUnnumbered(t *testing.T) {
	got := parsePatch(t, modifiedPatch)
	for _, l := range got.Hunks[0].Lines {
		if l.Kind == "add" && l.Old != 0 {
			t.Errorf("added line %q has Old = %d, want 0", l.Text, l.Old)
		}
		if l.Kind == "remove" && l.New != 0 {
			t.Errorf("removed line %q has New = %d, want 0", l.Text, l.New)
		}
	}
}

func TestGitDiffReadsHunkHeaderWithoutCounts(t *testing.T) {
	// A one-line range omits its count; the missing comma means 1, not 0.
	got := parsePatch(t, "@@ -7 +9 @@\n-old\n+new\n")

	if len(got.Hunks) != 1 {
		t.Fatalf("len(Hunks) = %d, want 1", len(got.Hunks))
	}
	h := got.Hunks[0]
	if h.OldStart != 7 || h.OldLines != 1 || h.NewStart != 9 || h.NewLines != 1 {
		t.Errorf("ranges = -%d,%d +%d,%d, want -7,1 +9,1", h.OldStart, h.OldLines, h.NewStart, h.NewLines)
	}
	if h.Lines[0].Old != 7 || h.Lines[1].New != 9 {
		t.Errorf("lines numbered %d/%d, want the header's starts 7/9", h.Lines[0].Old, h.Lines[1].New)
	}
}

func TestGitDiffStatusFromHeader(t *testing.T) {
	tests := []struct {
		name    string
		header  string
		want    string
		oldPath string
	}{
		{"added", "new file mode 100644", "added", ""},
		{"deleted", "deleted file mode 100644", "deleted", ""},
		{"renamed", "rename from old/name.go", "renamed", "old/name.go"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := parsePatch(t, "diff --git a/x b/x\n"+tc.header+"\n@@ -0,0 +1 @@\n+hello\n")
			if got.Status != tc.want {
				t.Errorf("Status = %q, want %q", got.Status, tc.want)
			}
			if got.OldPath != tc.oldPath {
				t.Errorf("OldPath = %q, want %q", got.OldPath, tc.oldPath)
			}
		})
	}
}

func TestGitDiffBinaryFileShowsNoLines(t *testing.T) {
	got := parsePatch(t, "diff --git a/logo.png b/logo.png\nindex 111..222 100644\nBinary files a/logo.png and b/logo.png differ\n")

	if !got.Binary {
		t.Error("Binary = false for a patch git refused to spell out")
	}
	if len(got.Hunks) != 0 {
		t.Errorf("len(Hunks) = %d, want 0 — there are no lines to show", len(got.Hunks))
	}
}

// "\ No newline at end of file" annotates the line above rather than being one.
// Taken as a line it would become a removal, inventing a change git never made.
func TestGitDiffIgnoresNoNewlineMarker(t *testing.T) {
	got := parsePatch(t, "@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n")

	if got.Added != 1 || got.Removed != 1 {
		t.Errorf("Added/Removed = %d/%d, want 1/1", got.Added, got.Removed)
	}
	for _, l := range got.Hunks[0].Lines {
		if strings.HasPrefix(l.Text, " No newline") {
			t.Errorf("marker kept as a %s line: %q", l.Kind, l.Text)
		}
	}
}

// The endpoint asks for one path, but a patch that somehow carries a second
// file must not have its header lines swallowed into the open hunk as content.
func TestGitDiffEndsHunkAtTheNextFileHeader(t *testing.T) {
	got := parsePatch(t, "@@ -1,1 +1,1 @@\n-old\n+new\ndiff --git a/other.go b/other.go\nindex 111..222 100644\n@@ -5,1 +5,1 @@\n+second\n")

	if len(got.Hunks) != 2 {
		t.Fatalf("len(Hunks) = %d, want 2", len(got.Hunks))
	}
	for _, l := range got.Hunks[0].Lines {
		if strings.HasPrefix(l.Text, "iff --git") || strings.Contains(l.Text, "index 111") {
			t.Errorf("header line kept as content: %q", l.Text)
		}
	}
	if n := len(got.Hunks[0].Lines); n != 2 {
		t.Errorf("len(Hunks[0].Lines) = %d, want 2", n)
	}
}

func TestGitDiffSkipsUnparseableHunkHeader(t *testing.T) {
	// The lines under a header we could not read have no numbers to carry, so
	// they are dropped rather than numbered from a guess.
	got := parsePatch(t, "@@ what @@\n+orphan\n@@ -1,1 +1,1 @@\n+kept\n")

	if len(got.Hunks) != 1 {
		t.Fatalf("len(Hunks) = %d, want 1", len(got.Hunks))
	}
	if got.Hunks[0].Lines[0].Text != "kept" {
		t.Errorf("Lines[0] = %q, want the line under the header we could read", got.Hunks[0].Lines[0].Text)
	}
}

// The ceiling is on the whole diff. Applied per hunk it would never be met by
// the file that most needs it — a generated file rewritten wholesale arrives as
// thousands of small hunks, none of them individually large.
func TestGitDiffTruncatesAcrossHunksNotWithinThem(t *testing.T) {
	var b strings.Builder
	const hunks, perHunk = 400, 100
	for h := range hunks {
		fmt.Fprintf(&b, "@@ -%d,0 +%d,%d @@\n", h*perHunk+1, h*perHunk+1, perHunk)
		for i := range perHunk {
			fmt.Fprintf(&b, "+line %d\n", h*perHunk+i)
		}
	}
	total := hunks * perHunk
	if total <= gitDiffMaxLines {
		t.Fatalf("fixture has %d lines, which does not reach the %d ceiling", total, gitDiffMaxLines)
	}

	got := parsePatch(t, b.String())

	kept := 0
	for _, h := range got.Hunks {
		kept += len(h.Lines)
	}
	if kept != gitDiffMaxLines {
		t.Errorf("kept %d lines, want the ceiling %d", kept, gitDiffMaxLines)
	}
	if !got.Truncated {
		t.Error("Truncated = false after dropping lines")
	}
	// The counts are a diffstat, not a description of what was kept: they stay
	// true past the ceiling so they cannot disagree with the status card.
	if got.Added != total {
		t.Errorf("Added = %d, want every added line %d", got.Added, total)
	}
}

func TestGitDiffUnderTheCeilingIsNotTruncated(t *testing.T) {
	got := parsePatch(t, modifiedPatch)
	if got.Truncated {
		t.Error("Truncated = true for a seven-line diff")
	}
}

func TestCleanRepoRelativeAcceptsPathsInside(t *testing.T) {
	tests := []struct{ in, want string }{
		{"", ""},
		{"main.go", "main.go"},
		{"web/js/app.js", "web/js/app.js"},
		{"  web/js/app.js  ", "web/js/app.js"},
		{"web/../web/js/app.js", "web/js/app.js"},
		{"web/./app.js", "web/app.js"},
	}
	for _, tc := range tests {
		got, ok := cleanRepoRelative(tc.in)
		if !ok || got != tc.want {
			t.Errorf("cleanRepoRelative(%q) = %q, %v; want %q, true", tc.in, got, ok, tc.want)
		}
	}
}

// Where this endpoint may be pointed is the whole of its security: it reads
// whatever it is given, so anything that leaves the anchor is refused outright
// rather than clamped back inside it.
//
// Every one of these is refused on every platform. What a path escapes to is a
// property of the client that sent it, not of the machine the server happens to
// run on, so a Windows path is refused by a Linux server and vice versa.
func TestCleanRepoRelativeRefusesPathsOutside(t *testing.T) {
	for _, in := range []string{
		"/etc/passwd",
		"..",
		"../secrets",
		"web/../../secrets",
		".",
		`C:\Windows\system.ini`,
		"C:/Windows/system.ini",
		`web\js\app.js`,
		`\\server\share`,
		"//server/share",
		"web/\x00/app.js",
	} {
		if got, ok := cleanRepoRelative(in); ok {
			t.Errorf("cleanRepoRelative(%q) = %q, true; want refused", in, got)
		}
	}
}

// git looks upward for a repository when the directory it is handed is not one,
// so an ordinary subdirectory accepted as `repo` would answer from whatever
// repository sits above the project. Only directories discovery actually found
// are repositories.
func TestResolveRepoDirRefusesADirectoryThatIsNotARepo(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "nested", ".git"), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "plain"), 0o750); err != nil {
		t.Fatal(err)
	}

	if _, ok := resolveRepoDir(t.Context(), root, "nested"); !ok {
		t.Error("refused a directory holding a .git")
	}
	if got, ok := resolveRepoDir(t.Context(), root, "plain"); ok {
		t.Errorf("resolveRepoDir(plain) = %q, true; want refused — it is not a repo", got)
	}
}

// A path can be lexically innocent and still leave the project by passing
// through a symlinked directory, which no amount of cleaning the string finds.
func TestWithinDirRefusesAPathThatLeavesThroughASymlink(t *testing.T) {
	base := t.TempDir()
	dir := filepath.Join(base, "repo")
	outside := filepath.Join(base, "outside")
	for _, d := range []string{dir, outside} {
		if err := os.MkdirAll(d, 0o750); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(outside, filepath.Join(dir, "escape")); err != nil {
		t.Skipf("symlinks unavailable here: %v", err)
	}
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}

	if !withinDir(filepath.Join(dir, "ordinary.go"), dir) {
		t.Error("refused an ordinary path inside the repo")
	}
	if withinDir(filepath.Join(dir, "escape", "secret.txt"), dir) {
		t.Error("accepted a path that leaves the repo through a symlinked directory")
	}
	if withinDir(dir, dir) {
		t.Error("accepted the directory itself as a file inside it")
	}
}

// Cutting on a byte count alone leaves a partial final line, which parses as a
// real line holding half its text — a quieter wrong answer than a missing line.
func TestCapAtLineBoundaryKeepsWholeLines(t *testing.T) {
	body := []byte(strings.Repeat("0123456789abcdef\n", (gitDiffMaxBytes/17)+64))
	got, truncated := capAtLineBoundary(body)

	if !truncated {
		t.Fatal("truncated = false for input past the ceiling")
	}
	if len(got) > gitDiffMaxBytes {
		t.Errorf("len = %d, want no more than %d", len(got), gitDiffMaxBytes)
	}
	if len(got) == 0 || got[len(got)-1] != '\n' {
		t.Error("cut mid-line: the result does not end at a line boundary")
	}

	short := []byte("one\ntwo\n")
	if got, truncated := capAtLineBoundary(short); truncated || string(got) != "one\ntwo\n" {
		t.Errorf("capAtLineBoundary(short) = %q, %v; want it returned whole", got, truncated)
	}
}

func TestUntrackedDiffShowsEveryLineAsAdded(t *testing.T) {
	abs := filepath.Join(t.TempDir(), "new.txt")
	if err := os.WriteFile(abs, []byte("alpha\nbeta\ngamma\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	resp := newDiffResponse()
	untrackedDiff(abs, resp)

	if resp.Status != "untracked" {
		t.Errorf("Status = %q, want %q", resp.Status, "untracked")
	}
	if len(resp.Hunks) != 1 {
		t.Fatalf("len(Hunks) = %d, want 1", len(resp.Hunks))
	}
	h := resp.Hunks[0]
	if h.NewStart != 1 || h.NewLines != 3 {
		t.Errorf("range = +%d,%d, want +1,3", h.NewStart, h.NewLines)
	}
	if resp.Added != 3 || resp.Removed != 0 {
		t.Errorf("Added/Removed = %d/%d, want 3/0", resp.Added, resp.Removed)
	}
	for i, want := range []string{"alpha", "beta", "gamma"} {
		if h.Lines[i].Kind != "add" || h.Lines[i].Text != want || h.Lines[i].New != i+1 {
			t.Errorf("Lines[%d] = %+v, want add %q at %d", i, h.Lines[i], want, i+1)
		}
	}
}

// A CRLF file's carriage returns belong to the line endings, not to the text.
// Kept, they would show as a stray glyph at the end of every line.
func TestUntrackedDiffStripsCarriageReturns(t *testing.T) {
	abs := filepath.Join(t.TempDir(), "crlf.txt")
	if err := os.WriteFile(abs, []byte("alpha\r\nbeta\r\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	resp := newDiffResponse()
	untrackedDiff(abs, resp)

	for _, l := range resp.Hunks[0].Lines {
		if strings.HasSuffix(l.Text, "\r") {
			t.Errorf("line %q kept its carriage return", l.Text)
		}
	}
}

func TestUntrackedDiffReportsBinaryWithoutShowingIt(t *testing.T) {
	abs := filepath.Join(t.TempDir(), "blob.bin")
	if err := os.WriteFile(abs, []byte("PNG\x00\x01\x02rest"), 0o600); err != nil {
		t.Fatal(err)
	}

	resp := newDiffResponse()
	untrackedDiff(abs, resp)

	if !resp.Binary {
		t.Error("Binary = false for a file with a NUL in it")
	}
	if len(resp.Hunks) != 0 {
		t.Errorf("len(Hunks) = %d, want 0 for a binary file", len(resp.Hunks))
	}
}

func TestUntrackedDiffEmptyFileHasNoHunk(t *testing.T) {
	abs := filepath.Join(t.TempDir(), "empty.txt")
	if err := os.WriteFile(abs, nil, 0o600); err != nil {
		t.Fatal(err)
	}

	resp := newDiffResponse()
	untrackedDiff(abs, resp)

	if resp.Status != "untracked" {
		t.Errorf("Status = %q, want %q", resp.Status, "untracked")
	}
	if len(resp.Hunks) != 0 {
		t.Errorf("len(Hunks) = %d, want 0 — an empty file adds nothing", len(resp.Hunks))
	}
}

// A symlink is a pointer, not a file, and following it would let a request that
// looks like it names something inside the project return bytes from anywhere on
// disk. Where this endpoint may be pointed is the whole of its security, so an
// untracked link is refused rather than read through.
func TestUntrackedDiffDoesNotReadThroughASymlink(t *testing.T) {
	dir := t.TempDir()
	secret := filepath.Join(dir, "secret.txt")
	if err := os.WriteFile(secret, []byte("sekrit-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "link.txt")
	if err := os.Symlink(secret, link); err != nil {
		t.Skipf("symlinks unavailable here: %v", err)
	}

	resp := newDiffResponse()
	untrackedDiff(link, resp)

	for _, h := range resp.Hunks {
		for _, l := range h.Lines {
			if strings.Contains(l.Text, "sekrit-token") {
				t.Fatalf("read through the symlink: %q", l.Text)
			}
		}
	}
}

// The ceiling drops lines from what is shown, never from what is counted: a
// truncated diff still tells the truth about the size of the change, so it can
// never disagree with the status card it sits beside.
func TestUntrackedDiffCountsEveryLineItTruncates(t *testing.T) {
	abs := filepath.Join(t.TempDir(), "big.txt")
	total := gitDiffMaxLines + 100
	var b strings.Builder
	for i := range total {
		fmt.Fprintf(&b, "line %d\n", i)
	}
	if err := os.WriteFile(abs, []byte(b.String()), 0o600); err != nil {
		t.Fatal(err)
	}

	resp := newDiffResponse()
	untrackedDiff(abs, resp)

	if !resp.Truncated {
		t.Error("Truncated = false after dropping lines")
	}
	if n := len(resp.Hunks[0].Lines); n != gitDiffMaxLines {
		t.Errorf("kept %d lines, want the ceiling %d", n, gitDiffMaxLines)
	}
	if resp.Added != total {
		t.Errorf("Added = %d, want every added line %d", resp.Added, total)
	}
}

// A line too long for the scanner's buffer stops the scan where it stands. Left
// unchecked that ends the patch early and silently, and what reaches the reader
// is a complete-looking diff of a file that simply had fewer hunks than it does.
func TestGitDiffReportsAScanThatCouldNotFinish(t *testing.T) {
	giant := strings.Repeat("x", 2*1024*1024)
	got := parsePatch(t, "@@ -1,1 +1,1 @@\n+"+giant+"\n+after\n")

	if !got.Truncated {
		t.Error("Truncated = false after the scanner gave up part-way through the patch")
	}
}

// A file git has never been told about is still missing from disk sometimes:
// deleted between the status poll and this read. That is nothing to show, not
// an error and not an untracked file.
func TestUntrackedDiffMissingFileSaysNothing(t *testing.T) {
	resp := newDiffResponse()
	untrackedDiff(filepath.Join(t.TempDir(), "gone.txt"), resp)

	if resp.Status != "unchanged" {
		t.Errorf("Status = %q, want it left as %q", resp.Status, "unchanged")
	}
	if len(resp.Hunks) != 0 {
		t.Errorf("len(Hunks) = %d, want 0", len(resp.Hunks))
	}
}
