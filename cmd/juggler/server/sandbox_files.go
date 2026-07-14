//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// sandboxImportRoot normalises the project path for the explore_code sandbox's
// absolute-path module loader: forward slashes so it matches the worker's
// origin-resolved import URLs on every OS (a Windows ProjectPath uses
// backslashes, but the sandbox and its URLs are POSIX-style throughout).
func sandboxImportRoot(projectPath string) string {
	return filepath.ToSlash(projectPath)
}

// sandboxImportPath aligns a request URL path with sandboxImportRoot. A POSIX
// project root is itself absolute ("/Users/…"), so the worker's origin+spec
// already yields a matching "/Users/…/web/…" path. A Windows drive-letter root
// ("C:/…") has no leading slash, so the worker resolves it against the origin as
// "/C:/…/web/…"; drop that synthetic leading slash so the prefix lines up.
func sandboxImportPath(urlPath, root string) string {
	if len(root) >= 2 && root[1] == ':' {
		return strings.TrimPrefix(urlPath, "/")
	}
	return urlPath
}

// sandboxProjectFile maps an explore_code sandbox import URL to a real file on
// disk inside the project root, or reports ok=false. The sandbox worker resolves
// user code's `import('<projectRoot>/rel/path')` against its http origin, so the
// request path is the absolute project path. We serve it only when it (a) stays
// strictly inside the project root and (b) is an importable module, so the
// ACAO=* response never exposes arbitrary project files (secrets, source) to a
// cross-origin reader — only JavaScript/JSON modules the sandbox can import().
func (s *Server) sandboxProjectFile(urlPath string) (string, bool) {
	root := sandboxImportRoot(s.ProjectPath())
	if root == "" {
		return "", false
	}
	p := path.Clean(sandboxImportPath(urlPath, root))
	// Clean has collapsed any "..", so a path still under the root cannot escape
	// it. Reject the root itself and anything outside it.
	if p != root && !strings.HasPrefix(p, root+"/") {
		return "", false
	}
	if !sandboxImportableExt(p) {
		return "", false
	}
	diskPath := filepath.FromSlash(p)
	info, err := os.Stat(diskPath)
	if err != nil || info.IsDir() {
		return "", false
	}
	return diskPath, true
}

// sandboxImportableExt reports whether p has an extension the sandbox may load
// over HTTP. Restricted to browser-importable module types so the ACAO=* static
// route can never be used to read non-module project files cross-origin.
func sandboxImportableExt(p string) bool {
	switch strings.ToLower(path.Ext(p)) {
	case ".js", ".mjs", ".cjs", ".json":
		return true
	default:
		return false
	}
}

// serveSandboxProjectFile writes a project file resolved by sandboxProjectFile.
// It sets an explicit JavaScript/JSON MIME because .mjs/.cjs are absent from
// Go's mime table and a module import() requires a JavaScript media type — a
// sniffed text/plain would make the browser reject the module.
func serveSandboxProjectFile(w http.ResponseWriter, r *http.Request, diskPath string) {
	f, err := os.Open(diskPath)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer func() { _ = f.Close() }()
	info, err := f.Stat()
	if err != nil || info.IsDir() {
		http.NotFound(w, r)
		return
	}
	// Reuse the shared web-asset MIME map, defaulting to JavaScript since
	// sandbox project files are imported as ES modules.
	ct := staticAssetContentType(diskPath)
	if ct == "" {
		ct = "text/javascript; charset=utf-8"
	}
	w.Header().Set("Content-Type", ct)
	http.ServeContent(w, r, filepath.Base(diskPath), info.ModTime(), f)
}

// staticAssetContentType returns a stable Content-Type for the web-asset
// extensions the app serves, or "" to defer to the file server's own detection.
//
// http.FileServer derives the type from mime.TypeByExtension, which consults the
// host MIME database — and on Windows that comes from the registry, where .mjs is
// frequently mapped to text/plain (and other web types are unreliable too). A
// module script served as text/plain is rejected by the browser's strict MIME
// check, which silently breaks the app's entire ES-module graph (e.g.
// web/js/vendor/yjs.mjs) while leaving unrelated standalone modules loading — so
// we set these types explicitly rather than trust the OS. Mirrors the explicit
// Content-Type in serveSandboxProjectFile.
func staticAssetContentType(p string) string {
	switch strings.ToLower(path.Ext(p)) {
	case ".js", ".mjs", ".cjs":
		return "text/javascript; charset=utf-8"
	case ".json", ".map":
		return "application/json; charset=utf-8"
	case ".css":
		return "text/css; charset=utf-8"
	case ".svg":
		return "image/svg+xml"
	case ".wasm":
		return "application/wasm"
	default:
		return ""
	}
}

// staticAssetHandler wraps a static file server, forcing a stable Content-Type
// for known web-asset extensions so serving is correct regardless of the host
// MIME database. See staticAssetContentType. http.ServeContent (used by
// http.FileServer) only sniffs a type when Content-Type is unset, so a header we
// set here is preserved.
func staticAssetHandler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if ct := staticAssetContentType(r.URL.Path); ct != "" {
			w.Header().Set("Content-Type", ct)
		}
		next.ServeHTTP(w, r)
	})
}
