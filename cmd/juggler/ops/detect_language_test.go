//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

// TestDetectLanguage covers the shape of the lookup rather than the whole table:
// which of the two tables wins, and what an unknown name falls back to.
func TestDetectLanguage(t *testing.T) {
	cases := map[string]string{
		"main.go":              "go",
		"src/App.tsx":          "typescript",
		"/a/b/Widget.HPP":      "cpp",
		"kernel.cu":            "cpp",
		"Makefile":             "makefile",
		"deps/GNUmakefile":     "makefile",
		"Dockerfile":           "docker",
		"build/CMakeLists.txt": "cmake",
		"build.gradle":         "groovy",
		".env":                 "ini",
		".editorconfig":        "ini",
		"notes.txt":            "text",
		"README":               "text",
		"data.unknownext":      "text",
		"":                     "text",
	}
	for path, want := range cases {
		if got := detectLanguage(path); got != want {
			t.Errorf("detectLanguage(%q) = %q, want %q", path, got, want)
		}
	}
}

// jsEntry matches one `key: 'value',` pair of a JavaScript object literal, with
// the key optionally quoted (`'c++': 'cpp'`).
var jsEntry = regexp.MustCompile(`(?m)(?:^|,)\s*'?([\w.+-]+)'?:\s*'([\w-]+)'`)

// jsTable extracts the object literal assigned to `export const <name>` from the
// browser's language module, as a map.
func jsTable(t *testing.T, source, name string) map[string]string {
	t.Helper()
	open := regexp.MustCompile(`export const ` + name + ` = \{`).FindStringIndex(source)
	if open == nil {
		t.Fatalf("no `export const %s = {` in web/sdk/lib/languages.js", name)
	}
	rest := source[open[1]:]
	end := regexp.MustCompile(`(?m)^\};`).FindStringIndex(rest)
	if end == nil {
		t.Fatalf("unterminated %s literal in web/sdk/lib/languages.js", name)
	}
	table := map[string]string{}
	for _, match := range jsEntry.FindAllStringSubmatch(rest[:end[0]], -1) {
		table[match[1]] = match[2]
	}
	if len(table) == 0 {
		t.Fatalf("parsed no entries out of %s", name)
	}
	return table
}

// TestDetectLanguageMatchesClient pins the server's table to the browser's copy
// in web/sdk/lib/languages.js. The two exist separately because a file read
// through a tool carries its language with it while a file dropped into the UI
// never reaches the server — but a file that highlights one way when read and
// another when dropped is a bug, so they have to say the same thing.
func TestDetectLanguageMatchesClient(t *testing.T) {
	path := filepath.Join("..", "..", "..", "web", "sdk", "lib", "languages.js")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	source := string(data)

	for _, table := range []struct {
		name string
		js   map[string]string
		go_  map[string]string
	}{
		{"LANGUAGE_BY_EXT", jsTable(t, source, "LANGUAGE_BY_EXT"), languageByExt},
		{"LANGUAGE_BY_FILENAME", jsTable(t, source, "LANGUAGE_BY_FILENAME"), languageByFilename},
	} {
		for key, want := range table.js {
			got, ok := table.go_[key]
			if !ok {
				t.Errorf("%s: %q is in the browser table but not the Go one", table.name, key)
				continue
			}
			if got != want {
				t.Errorf("%s: %q is %q in Go and %q in the browser", table.name, key, got, want)
			}
		}
		for key := range table.go_ {
			if _, ok := table.js[key]; !ok {
				t.Errorf("%s: %q is in the Go table but not the browser one", table.name, key)
			}
		}
	}
}
