//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"juggler/web"
)

var workerModuleImportRe = regexp.MustCompile(`(?m)(\b(?:import|export)\s+(?:[^'";]+?\s+from\s+)?|\bimport\s*\(\s*)(['"])([^'"]+)(['"])`)

var workerSDKImports = map[string]string{
	"juggler/context-item":  "/sdk/context-item.js",
	"juggler/strategy-type": "/sdk/strategy-type.js",
	"juggler/command-type":  "/sdk/command-type.js",
	"juggler/ops":           "/sdk/ops.js",
	"juggler/sandbox":       "/sdk/sandbox.js",
	"juggler/ui":            "/sdk/ui-worker.js",
	"juggler/model":         "/sdk/model.js",
	"juggler/item-utils":    "/sdk/item-utils-worker.js",
	"juggler/registry":      "/sdk/registry.js",
	"juggler/version":       "/sdk/version.js",
	"juggler/utils/html":    "/sdk/lib/html.js",
}

// serveWorkerModule serves a JS module transformed for module-worker imports.
// Workers do not inherit the document import map, so extension modules that use
// the public `juggler/*` SDK specifiers need those imports rewritten to concrete
// URLs. Relative imports are also routed back through this handler so nested
// extension modules receive the same treatment.
func (s *Server) serveWorkerModule(w http.ResponseWriter, r *http.Request) {
	rawURL := r.URL.Query().Get("url")
	if rawURL == "" || !strings.HasPrefix(rawURL, "/") || strings.Contains(rawURL, "..") {
		http.Error(w, "invalid module url", http.StatusBadRequest)
		return
	}

	content, err := s.readWorkerModule(rawURL)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}

	source := s.rewriteWorkerModuleImports(rawURL, string(content))
	w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, must-revalidate")
	_, _ = w.Write([]byte(source))
}

func (s *Server) readWorkerModule(moduleURL string) ([]byte, error) {
	path := moduleURL
	vPrefix := "/v" + s.staticVersion
	if strings.HasPrefix(path, vPrefix+"/") {
		path = strings.TrimPrefix(path, vPrefix)
	}
	path = strings.TrimPrefix(path, "/")

	if s.assetsFromDisk {
		if staticDir, err := s.findStaticDir(); err == nil {
			if content, err := os.ReadFile(filepath.Join(staticDir, filepath.FromSlash(path))); err == nil {
				return content, nil
			}
		}
	}
	return web.Files.ReadFile(path)
}

func (s *Server) rewriteWorkerModuleImports(moduleURL, source string) string {
	return workerModuleImportRe.ReplaceAllStringFunc(source, func(match string) string {
		parts := workerModuleImportRe.FindStringSubmatch(match)
		if len(parts) != 5 {
			return match
		}
		prefix, quote, spec, endQuote := parts[1], parts[2], parts[3], parts[4]
		rewritten := s.resolveWorkerModuleSpecifier(moduleURL, spec)
		if rewritten == spec {
			return match
		}
		return prefix + quote + rewritten + endQuote
	})
}

func (s *Server) resolveWorkerModuleSpecifier(moduleURL, spec string) string {
	if sdkPath, ok := workerSDKImports[spec]; ok {
		return s.workerModuleURL(sdkPath)
	}
	if strings.HasPrefix(spec, "/") {
		return s.workerModuleURL(spec)
	}
	if strings.HasPrefix(spec, "./") || strings.HasPrefix(spec, "../") {
		base, err := url.Parse(moduleURL)
		if err != nil {
			return spec
		}
		resolved := base.ResolveReference(&url.URL{Path: spec}).Path
		return s.workerModuleURL(resolved)
	}
	return spec
}

// workerModuleURL builds the loader URL for a module, CANONICALIZING the path by
// stripping any "/v<staticVersion>" cache-busting prefix first. ES module identity
// is keyed by resolved URL, so a file referenced both with the version prefix
// (e.g. via the SDK import map, "/v123/sdk/ops.js" → "/v123/js/services/websocket.js")
// and without it (the engine graph entry "/js/engine-app.js" → "/js/services/websocket.js")
// would otherwise load TWICE as two separate instances — duplicating singletons
// like wsService, one of which never connects. Canonicalizing to the unprefixed
// path guarantees one instance per file.
func (s *Server) workerModuleURL(moduleURL string) string {
	vPrefix := "/v" + s.staticVersion
	if strings.HasPrefix(moduleURL, vPrefix+"/") {
		moduleURL = strings.TrimPrefix(moduleURL, vPrefix)
	}
	return fmt.Sprintf("/worker-module?url=%s", url.QueryEscape(moduleURL))
}
