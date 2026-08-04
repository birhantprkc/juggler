//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// newTestConfigAPI builds a ConfigAPI with an isolated credentials store
// (JUGGLER_CONFIG_DIR) and a temp project path, so a test never touches the
// developer's real ~/.juggler/credentials.json.
func newTestConfigAPI(t *testing.T) *ConfigAPI {
	t.Helper()
	t.Setenv("JUGGLER_CONFIG_DIR", t.TempDir())
	project := t.TempDir()
	api, err := NewConfigAPI(func() string { return project }, nil, nil)
	if err != nil {
		t.Fatalf("NewConfigAPI: %v", err)
	}
	return api
}

// getAutoCompactDisabled drives HandleGetConfig and returns the
// autoCompactDisabled field from the payload.
func getAutoCompactDisabled(t *testing.T, api *ConfigAPI) bool {
	t.Helper()
	rec := httptest.NewRecorder()
	api.HandleGetConfig(rec, httptest.NewRequest(http.MethodGet, "/api/config", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/config = %d, want 200", rec.Code)
	}
	var payload struct {
		AutoCompactDisabled bool `json:"autoCompactDisabled"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode GET payload: %v", err)
	}
	return payload.AutoCompactDisabled
}

// putConfig drives HandleUpdateConfig with the given JSON body.
func putConfig(t *testing.T, api *ConfigAPI, body map[string]any) {
	t.Helper()
	raw, _ := json.Marshal(body)
	rec := httptest.NewRecorder()
	api.HandleUpdateConfig(rec, httptest.NewRequest(http.MethodPut, "/api/config", bytes.NewReader(raw)))
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT /api/config = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
}

// TestAutoCompactDisabledRoundTrip pins the config round-trip for the global
// auto-compaction switch: default is enabled (false disabled), PUT true
// persists, and PUT false clears it back to the default.
func TestAutoCompactDisabledRoundTrip(t *testing.T) {
	api := newTestConfigAPI(t)

	if getAutoCompactDisabled(t, api) {
		t.Fatal("default autoCompactDisabled = true, want false (enabled by default)")
	}

	putConfig(t, api, map[string]any{"auto_compact_disabled": true})
	if !getAutoCompactDisabled(t, api) {
		t.Fatal("after PUT true, autoCompactDisabled = false, want true")
	}

	putConfig(t, api, map[string]any{"auto_compact_disabled": false})
	if getAutoCompactDisabled(t, api) {
		t.Fatal("after PUT false, autoCompactDisabled = true, want false (cleared)")
	}
}
