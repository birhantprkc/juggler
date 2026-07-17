//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// The skills marketplace fetches skill definitions from external registries. A
// registry is reached through registryFetcher, a three-call seam
// (Resolve → Tree → Blob) that pins everything to a single commit so a moving
// branch can never yield an inconsistent mix of versions. v1 implements GitHub
// only; the interface is also the test seam — the whole handler runs against
// httptest servers by injecting fixture base URLs (see skills_registry_test.go).

// treeEntry is one node of a repository's recursive git tree: a forward-slash
// path, its git mode (100644 file, 040000 dir, 120000 symlink, 160000
// submodule), object type ("blob"/"tree"), sha, and — for blobs — size. The
// per-directory tree sha (Sha of a "tree" entry) is the update signal a skill's
// provenance is compared against.
type treeEntry struct {
	Path string `json:"path"`
	Mode string `json:"mode"`
	Type string `json:"type"`
	Sha  string `json:"sha"`
	Size int64  `json:"size"`
}

// registryFetcher talks to one kind of skill registry. Everything downstream of
// Resolve is pinned to the returned commit sha, never the branch name.
type registryFetcher interface {
	// Resolve turns a ref (branch/tag/sha; "" → default branch) into the commit
	// sha and its root tree sha. When a prior etag is supplied and the ref is
	// unchanged, notModified is true and the caller reuses its cached catalog.
	Resolve(ctx context.Context, repo, ref, etag string) (commit, treeSha, newETag string, notModified bool, err error)
	// Tree returns every entry under treeSha (recursively). truncated is set when
	// the repository is too large for one response (caller falls back / degrades).
	Tree(ctx context.Context, repo, treeSha string) (entries []treeEntry, truncated bool, err error)
	// Blob returns one file's bytes, pinned to commit. It enforces a hard
	// per-file size cap so a hostile registry can't stream an unbounded body.
	Blob(ctx context.Context, repo, commit, path string) ([]byte, error)
}

const (
	// defaultGitHubAPIBase is the GitHub REST API root (git trees + commits).
	defaultGitHubAPIBase = "https://api.github.com"
	// defaultGitHubRawBase serves raw file contents from a CDN that does NOT
	// consume the 60/hr unauthenticated API rate limit.
	defaultGitHubRawBase = "https://raw.githubusercontent.com"
	// maxSkillBlobSize caps any single fetched file (SKILL.md, a script, an
	// asset). tree-reported sizes are advisory; this LimitReader is the guarantee.
	maxSkillBlobSize = 2 << 20 // 2 MiB
)

// githubFetcher implements registryFetcher against GitHub. apiBase and rawBase
// are fields (not constants) so tests point them at httptest servers. An empty
// token means unauthenticated (60 req/hr); GITHUB_TOKEN raises it to 5000.
type githubFetcher struct {
	apiBase string
	rawBase string
	token   string
	client  *http.Client
}

// newGitHubFetcher builds the production fetcher: real GitHub endpoints, a
// GITHUB_TOKEN read from the environment (v1 has no dedicated config field), and
// a client with explicit timeouts mirroring webfetch_ops.go's discipline.
func newGitHubFetcher() *githubFetcher {
	return &githubFetcher{
		apiBase: defaultGitHubAPIBase,
		rawBase: defaultGitHubRawBase,
		token:   strings.TrimSpace(os.Getenv("GITHUB_TOKEN")),
		client:  &http.Client{Timeout: 30 * time.Second},
	}
}

// newRequest builds a GET with context, a Juggler User-Agent, and (when set) the
// bearer token. GitHub requires a User-Agent or it rejects the request.
func (f *githubFetcher) newRequest(ctx context.Context, url string) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Juggler/1.0 (AI Coding Assistant)")
	if f.token != "" {
		req.Header.Set("Authorization", "Bearer "+f.token)
	}
	return req, nil
}

// Resolve fetches the commit for a ref via the commits API, which returns both
// the commit sha and its root tree sha in one call. A 304 (ETag match) short-
// circuits a refresh without spending rate limit.
func (f *githubFetcher) Resolve(ctx context.Context, repo, ref, etag string) (commit, treeSha, newETag string, notModified bool, err error) {
	if ref == "" {
		ref = "HEAD"
	}
	url := fmt.Sprintf("%s/repos/%s/commits/%s", f.apiBase, repo, ref)
	req, err := f.newRequest(ctx, url)
	if err != nil {
		return "", "", "", false, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	if etag != "" {
		req.Header.Set("If-None-Match", etag)
	}
	resp, err := f.client.Do(req)
	if err != nil {
		return "", "", "", false, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotModified {
		return "", "", etag, true, nil
	}
	if resp.StatusCode != http.StatusOK {
		return "", "", "", false, fmt.Errorf("resolve %s@%s: %s", repo, ref, httpStatusMessage(resp))
	}
	var payload struct {
		Sha    string `json:"sha"`
		Commit struct {
			Tree struct {
				Sha string `json:"sha"`
			} `json:"tree"`
		} `json:"commit"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxSkillBlobSize)).Decode(&payload); err != nil {
		return "", "", "", false, fmt.Errorf("resolve %s: decode: %w", repo, err)
	}
	if payload.Sha == "" || payload.Commit.Tree.Sha == "" {
		return "", "", "", false, fmt.Errorf("resolve %s: empty commit/tree sha", repo)
	}
	return payload.Sha, payload.Commit.Tree.Sha, resp.Header.Get("ETag"), false, nil
}

// Tree fetches the full recursive tree for treeSha. The truncated flag (huge
// repos) is surfaced so the catalog can degrade rather than silently list a
// partial set.
func (f *githubFetcher) Tree(ctx context.Context, repo, treeSha string) ([]treeEntry, bool, error) {
	url := fmt.Sprintf("%s/repos/%s/git/trees/%s?recursive=1", f.apiBase, repo, treeSha)
	req, err := f.newRequest(ctx, url)
	if err != nil {
		return nil, false, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := f.client.Do(req)
	if err != nil {
		return nil, false, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, false, fmt.Errorf("tree %s@%s: %s", repo, treeSha, httpStatusMessage(resp))
	}
	var payload struct {
		Tree      []treeEntry `json:"tree"`
		Truncated bool        `json:"truncated"`
	}
	// Trees can be large; allow well beyond a blob but still bounded.
	if err := json.NewDecoder(io.LimitReader(resp.Body, 32<<20)).Decode(&payload); err != nil {
		return nil, false, fmt.Errorf("tree %s: decode: %w", repo, err)
	}
	return payload.Tree, payload.Truncated, nil
}

// Blob fetches one file from the raw CDN, pinned to commit, capped by
// maxSkillBlobSize. A body exactly at the cap+1 boundary is rejected as
// oversize rather than silently truncated (a truncated skill file is worse than
// a refused one).
func (f *githubFetcher) Blob(ctx context.Context, repo, commit, path string) ([]byte, error) {
	url := fmt.Sprintf("%s/%s/%s/%s", f.rawBase, repo, commit, escapeBlobPath(path))
	req, err := f.newRequest(ctx, url)
	if err != nil {
		return nil, err
	}
	resp, err := f.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("blob %s@%s/%s: %s", repo, commit, path, httpStatusMessage(resp))
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxSkillBlobSize+1))
	if err != nil {
		return nil, fmt.Errorf("blob %s: read: %w", path, err)
	}
	if len(data) > maxSkillBlobSize {
		return nil, fmt.Errorf("blob %s: exceeds %d-byte cap", path, maxSkillBlobSize)
	}
	return data, nil
}

// escapeBlobPath percent-escapes each path segment so a space or other reserved
// character in a remote file name survives the raw URL, without escaping the
// slashes that separate segments.
func escapeBlobPath(path string) string {
	parts := strings.Split(path, "/")
	for i, p := range parts {
		parts[i] = urlPathSegmentEscape(p)
	}
	return strings.Join(parts, "/")
}

// urlPathSegmentEscape escapes one path segment. It uses a minimal manual escape
// of space (the common case) plus '#' and '?', which would otherwise terminate
// the path; the tree walk already excludes control characters.
func urlPathSegmentEscape(s string) string {
	r := strings.NewReplacer(" ", "%20", "#", "%23", "?", "%3F")
	return r.Replace(s)
}

// httpStatusMessage renders a concise status line, folding GitHub's 403 rate-
// limit response into a clearer message when the remaining-quota header is zero.
func httpStatusMessage(resp *http.Response) string {
	if resp.StatusCode == http.StatusForbidden && resp.Header.Get("X-RateLimit-Remaining") == "0" {
		return "GitHub API rate limit exceeded (set GITHUB_TOKEN to raise it)"
	}
	return fmt.Sprintf("HTTP %d", resp.StatusCode)
}
