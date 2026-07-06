//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	"juggler/cmd/juggler/server/handlers"
	"juggler/internal/userpaths/userpathstest"
)

// TestScaffoldExtensionValid asserts the scaffolded files exist, the manifest is
// valid JSON with the required fields, and every capability sample imports only
// from the public juggler/* SDK.
func TestScaffoldExtensionValid(t *testing.T) {
	files := scaffoldExtension("code-review")

	want := []string{
		extManifestFile,
		"context-items/echo-context-item.js",
		"strategies/sample-strategy-type.js",
		"commands/hello-command-type.js",
		"README.md",
	}
	for _, rel := range want {
		if _, ok := files[rel]; !ok {
			t.Errorf("scaffold missing %q", rel)
		}
	}

	var m handlers.ExtensionManifest
	dec := json.NewDecoder(strings.NewReader(files[extManifestFile]))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&m); err != nil {
		t.Fatalf("manifest is not valid JSON: %v", err)
	}
	if m.ID != "@local/code-review" {
		t.Errorf("manifest id = %q, want @local/code-review", m.ID)
	}
	if m.Name != "code-review" || m.Version == "" {
		t.Errorf("manifest name/version = %q/%q", m.Name, m.Version)
	}
	if len(m.Provides.ContextItems) == 0 || len(m.Provides.Strategies) == 0 || len(m.Provides.Commands) == 0 {
		t.Errorf("manifest provides incomplete: %+v", m.Provides)
	}

	// Each capability sample must import its base class from juggler/*, never a
	// relative host path — the dogfood contract for third-party parity.
	imports := map[string]string{
		"context-items/echo-context-item.js": "juggler/context-item",
		"strategies/sample-strategy-type.js": "juggler/strategy-type",
		"commands/hello-command-type.js":     "juggler/command-type",
	}
	for file, spec := range imports {
		body := files[file]
		if !strings.Contains(body, "from '"+spec+"'") {
			t.Errorf("%s does not import from %q", file, spec)
		}
		if strings.Contains(body, "../../js/") || strings.Contains(body, "../js/") {
			t.Errorf("%s reaches into host internals via a relative import", file)
		}
	}
}

// TestExtInitProducesDiscoverableExtension scaffolds into an extension container
// and proves the result is discovered + validated by the real extensions handler
// with no error — i.e. the scaffold loads with zero edits.
func TestExtInitProducesDiscoverableExtension(t *testing.T) {
	container := t.TempDir()
	extDir := filepath.Join(container, "myext")
	if code := extInit([]string{extDir}); code != 0 {
		t.Fatalf("extInit exit code = %d, want 0", code)
	}
	if _, err := os.Stat(filepath.Join(extDir, extManifestFile)); err != nil {
		t.Fatalf("manifest not written: %v", err)
	}

	// builtin FS supplies only the SDK version so the engineApi ^1.0.0 check passes.
	builtinFS := fstest.MapFS{
		"sdk/version.js": {Data: []byte("export const ENGINE_API_VERSION = '1.0.0';")},
	}
	api := handlers.NewExtensionsAPI(builtinFS, "", container)
	req := httptest.NewRequest(http.MethodGet, "/api/extensions", nil)
	rec := httptest.NewRecorder()
	api.HandleListExtensions(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}

	var exts []handlers.Extension
	if err := json.Unmarshal(rec.Body.Bytes(), &exts); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	var found *handlers.Extension
	for i := range exts {
		if exts[i].Manifest.ID == "@local/myext" {
			found = &exts[i]
		}
	}
	if found == nil {
		t.Fatal("scaffolded extension not discovered")
	}
	if found.Error != "" {
		t.Fatalf("scaffolded extension reported error: %s", found.Error)
	}
	if len(found.Capabilities.ContextItems) != 1 ||
		len(found.Capabilities.Strategies) != 1 ||
		len(found.Capabilities.Commands) != 1 {
		t.Errorf("expected one capability per type, got %+v", found.Capabilities)
	}
}

// TestExtInitRefusesExisting ensures init never clobbers an existing directory.
func TestExtInitRefusesExisting(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "exists")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if code := extInit([]string{dir}); code == 0 {
		t.Error("extInit should refuse an existing directory")
	}
}

// TestExtLinkCreatesSymlink scaffolds a dev extension, links it, and asserts the
// symlink lands in ~/.juggler/extensions pointing back at the dev dir.
func TestExtLinkCreatesSymlink(t *testing.T) {
	home := userpathstest.Isolate(t)

	devDir := filepath.Join(t.TempDir(), "dev-ext")
	if code := extInit([]string{devDir}); code != 0 {
		t.Fatalf("extInit exit code = %d", code)
	}

	if code := extLink([]string{devDir}); code != 0 {
		t.Fatalf("extLink exit code = %d, want 0", code)
	}

	link := filepath.Join(home, ".juggler", "extensions", "dev-ext")
	target, err := os.Readlink(link)
	if err != nil {
		t.Fatalf("expected symlink at %s: %v", link, err)
	}
	if target != devDir {
		t.Errorf("symlink target = %q, want %q", target, devDir)
	}

	// Re-linking is idempotent (replaces the existing symlink).
	if code := extLink([]string{devDir}); code != 0 {
		t.Errorf("re-link exit code = %d, want 0", code)
	}
}

// TestExtLinkRejectsNonExtension refuses to link a directory with no manifest.
func TestExtLinkRejectsNonExtension(t *testing.T) {
	userpathstest.Isolate(t)
	plain := filepath.Join(t.TempDir(), "plain")
	if err := os.MkdirAll(plain, 0o755); err != nil {
		t.Fatal(err)
	}
	if code := extLink([]string{plain}); code == 0 {
		t.Error("extLink should reject a directory without a manifest")
	}
}

// TestExtValidateAcceptsScaffold proves a freshly scaffolded extension passes
// `juggler ext validate` with exit 0 — the scaffold-loads-unedited contract,
// checked through the same admission path the server uses.
func TestExtValidateAcceptsScaffold(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "good")
	if code := extInit([]string{dir}); code != 0 {
		t.Fatalf("extInit exit code = %d", code)
	}
	if code := extValidate([]string{dir}); code != 0 {
		t.Errorf("extValidate exit code = %d, want 0", code)
	}
}

// TestExtValidateRejectsBadManifest covers the fatal cases: no manifest, an
// unknown key, an incompatible engineApi, and a provides glob matching no files.
func TestExtValidateRejectsBadManifest(t *testing.T) {
	cases := map[string]string{
		// no manifest at all
		"empty": "",
		// unknown top-level key (DisallowUnknownFields)
		"typo": `{"id":"@x/y","name":"Y","version":"1.0.0","permision":[],` +
			`"provides":{"commands":["commands/*.js"]}}`,
		// engineApi incompatible with the host (1.0.0)
		"incompat": `{"id":"@x/y","name":"Y","version":"1.0.0","engineApi":"^2.0.0",` +
			`"provides":{"commands":["commands/hi-command-type.js"]}}`,
		// valid manifest but the declared glob resolves to nothing
		"emptyglob": `{"id":"@x/y","name":"Y","version":"1.0.0","engineApi":"^1.0.0",` +
			`"provides":{"commands":["commands/*-command-type.js"]}}`,
	}
	for name, manifest := range cases {
		t.Run(name, func(t *testing.T) {
			dir := filepath.Join(t.TempDir(), name)
			if err := os.MkdirAll(dir, 0o755); err != nil {
				t.Fatal(err)
			}
			if manifest != "" {
				if err := os.WriteFile(filepath.Join(dir, extManifestFile), []byte(manifest), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			if code := extValidate([]string{dir}); code == 0 {
				t.Errorf("extValidate(%s) exit code = 0, want non-zero", name)
			}
		})
	}
}

// TestRepoBaseName covers the install-dir derivation for `juggler ext add`.
func TestRepoBaseName(t *testing.T) {
	cases := map[string]string{
		"github.com/juggler-ai/code-review":     "code-review",
		"github.com/juggler-ai/code-review.git": "code-review",
		"https://github.com/foo/bar.git":        "bar",
		"git@github.com:foo/bar.git":            "bar",
		"bar":                                   "bar",
		"github.com/foo/bar/":                   "bar",
	}
	for in, want := range cases {
		if got := repoBaseName(in); got != want {
			t.Errorf("repoBaseName(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestNormalizeRepoURL covers URL normalisation for `juggler ext add`.
func TestNormalizeRepoURL(t *testing.T) {
	cases := map[string]string{
		"github.com/foo/bar":           "https://github.com/foo/bar",
		"https://github.com/foo/bar":   "https://github.com/foo/bar",
		"git@github.com:foo/bar.git":   "git@github.com:foo/bar.git",
		"ssh://git@github.com/foo/bar": "ssh://git@github.com/foo/bar",
	}
	for in, want := range cases {
		if got := normalizeRepoURL(in); got != want {
			t.Errorf("normalizeRepoURL(%q) = %q, want %q", in, got, want)
		}
	}
}
