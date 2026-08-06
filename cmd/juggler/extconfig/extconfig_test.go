//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package extconfig

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/extmanifest"
)

func testOperations(t *testing.T) (*operations, extmanifest.Manifest) {
	t.Helper()
	root := t.TempDir()
	t.Setenv("JUGGLER_CONFIG_DIR", root)
	credentials, err := core.NewCredentialsStore()
	if err != nil {
		t.Fatal(err)
	}
	manifest := extmanifest.Manifest{
		ID: "@test/settings", Name: "Settings", Version: "1.0.0", EngineAPI: "^1.0.0",
		Provides: extmanifest.Provides{Commands: []string{"command.js"}},
		Settings: []extmanifest.Setting{
			{Key: "name", Type: "string", Label: "Name", Default: json.RawMessage(`"default"`)},
			{Key: "token", Type: "secret", Label: "Token"},
			{Key: "enabled", Type: "boolean", Label: "Enabled", Default: json.RawMessage(`true`)},
			{Key: "count", Type: "number", Label: "Count"},
			{Key: "mode", Type: "enum", Label: "Mode", Options: []string{"fast", "deep"}},
			{Key: "endpoint", Type: "url", Label: "Endpoint"},
		},
	}
	return &operations{
		configRoot:  root,
		credentials: credentials,
		manifest: func(id string) (extmanifest.Manifest, error) {
			if id == manifest.ID {
				return manifest, nil
			}
			return extmanifest.Manifest{}, os.ErrNotExist
		},
		writeGate: make(chan struct{}, 1),
	}, manifest
}

func execute(t *testing.T, o *operations, operation string, values map[string]any) map[string]any {
	t.Helper()
	params := map[string]any{"extId": "@test/settings"}
	for key, value := range values {
		params[key] = value
	}
	result, err := o.Execute(context.Background(), operation, params)
	if err != nil {
		t.Fatalf("%s: %v", operation, err)
	}
	return result.(map[string]any)
}

func TestGetSetResolve(t *testing.T) {
	o, manifest := testOperations(t)
	got := execute(t, o, "get", nil)
	want := map[string]any{
		"name": "default", "enabled": true,
		"token": map[string]any{"__present": false},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("initial get = %#v, want %#v", got, want)
	}

	got = execute(t, o, "set", map[string]any{"values": map[string]any{
		"name": "custom", "token": "top-secret", "enabled": false,
		"count": float64(3), "mode": "deep", "endpoint": "https://example.com/api",
	}})
	if marker := got["token"].(map[string]any); marker["__present"] != true {
		t.Fatalf("secret marker = %#v", marker)
	}
	resolved := execute(t, o, "resolve", nil)
	if resolved["token"] != "top-secret" || resolved["count"] != float64(3) {
		t.Fatalf("resolve = %#v", resolved)
	}

	configPath := o.configPath(manifest.ID)
	data, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) == "" || contains(string(data), "top-secret") {
		t.Fatalf("non-secret config leaked secret: %s", data)
	}
	if mode := mustMode(t, configPath); mode.Perm() != 0o600 {
		t.Fatalf("config mode = %o, want 600", mode.Perm())
	}
	credentialsPath := filepath.Join(os.Getenv("JUGGLER_CONFIG_DIR"), "credentials.json")
	if mode := mustMode(t, credentialsPath); mode.Perm() != 0o600 {
		t.Fatalf("credentials mode = %o, want 600", mode.Perm())
	}
}

func TestSecretPreserveAndClear(t *testing.T) {
	o, _ := testOperations(t)
	execute(t, o, "set", map[string]any{"values": map[string]any{"token": "first"}})
	execute(t, o, "set", map[string]any{"values": map[string]any{
		"token": map[string]any{"__present": true}, "name": "changed",
	}})
	if got := execute(t, o, "resolve", nil)["token"]; got != "first" {
		t.Fatalf("preserved secret = %v", got)
	}
	execute(t, o, "set", map[string]any{"values": map[string]any{"token": ""}})
	if _, ok := execute(t, o, "resolve", nil)["token"]; ok {
		t.Fatal("cleared secret remained in resolve")
	}
	if present := execute(t, o, "get", nil)["token"].(map[string]any)["__present"]; present != false {
		t.Fatalf("cleared secret presence = %v", present)
	}
}

func TestSetValidationAndScope(t *testing.T) {
	o, _ := testOperations(t)
	cases := []map[string]any{
		{"values": map[string]any{"unknown": true}},
		{"values": map[string]any{"enabled": "yes"}},
		{"values": map[string]any{"mode": "other"}},
		{"values": map[string]any{"endpoint": "relative"}},
		{"values": map[string]any{"token": map[string]any{"__present": false}}},
		{"scope": "project", "values": map[string]any{}},
	}
	for _, params := range cases {
		params["extId"] = "@test/settings"
		if _, err := o.Execute(context.Background(), "set", params); err == nil {
			t.Errorf("expected error for %#v", params)
		}
	}
}

func TestConfigPathCannotTraverse(t *testing.T) {
	o, _ := testOperations(t)
	for _, id := range []string{"../../outside", "@scope/name", `C:\outside`} {
		filename := o.configPath(id)
		rel, err := filepath.Rel(o.configRoot, filename)
		if err != nil || rel == ".." || filepath.IsAbs(rel) || contains(rel, ".."+string(filepath.Separator)) {
			t.Fatalf("configPath(%q) escaped root: %q", id, filename)
		}
	}
}

func contains(value, needle string) bool {
	for i := 0; i+len(needle) <= len(value); i++ {
		if value[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}

func mustMode(t *testing.T, filename string) os.FileMode {
	t.Helper()
	info, err := os.Stat(filename)
	if err != nil {
		t.Fatal(err)
	}
	return info.Mode()
}
