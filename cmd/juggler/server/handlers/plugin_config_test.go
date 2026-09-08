//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"juggler/cmd/juggler/core"
)

// getPluginConfig drives HandleGetPluginConfig and returns the resolved
// disabled-id list the UI is handed.
func getPluginConfig(t *testing.T, api *ConfigAPI) []string {
	t.Helper()
	rec := httptest.NewRecorder()
	api.HandleGetPluginConfig(rec, httptest.NewRequest(http.MethodGet, "/api/config/plugins", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/config/plugins = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	var payload struct {
		Disabled []string `json:"disabled"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode plugin config: %v", err)
	}
	return payload.Disabled
}

// putPluginConfig states the resolved set of ids that should be switched off.
func putPluginConfig(t *testing.T, api *ConfigAPI, disabled []string) {
	t.Helper()
	raw, _ := json.Marshal(map[string]any{"disabled": disabled})
	rec := httptest.NewRecorder()
	api.HandleUpdatePluginConfig(rec,
		httptest.NewRequest(http.MethodPut, "/api/config/plugins", bytes.NewReader(raw)))
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT /api/config/plugins = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
}

// rawPluginLists reads the two lists as they were actually written to disk.
func rawPluginLists(t *testing.T, api *ConfigAPI) (disabled, enabled []string) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(api.projectPath(), ".juggler", "config.json"))
	if err != nil {
		t.Fatalf("read config.json: %v", err)
	}
	var file struct {
		Plugins struct {
			Disabled []string `json:"disabled"`
			Enabled  []string `json:"enabled"`
		} `json:"plugins"`
	}
	if err := json.Unmarshal(data, &file); err != nil {
		t.Fatalf("decode config.json: %v", err)
	}
	return file.Plugins.Disabled, file.Plugins.Enabled
}

// writeRawConfig plants a config.json ahead of the handlers, for the shapes a
// user's file can already be in.
func writeRawConfig(t *testing.T, api *ConfigAPI, plugins map[string]any) {
	t.Helper()
	dir := filepath.Join(api.projectPath(), ".juggler")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir .juggler: %v", err)
	}
	raw, _ := json.Marshal(map[string]any{"plugins": plugins})
	if err := os.WriteFile(filepath.Join(dir, "config.json"), raw, 0o644); err != nil {
		t.Fatalf("write config.json: %v", err)
	}
}

// putPluginConfigWithAttribution states the resolved set plus what the caller
// knows about the ids it is switching off.
func putPluginConfigWithAttribution(t *testing.T, api *ConfigAPI, disabled []string, attribution map[string]any) {
	t.Helper()
	raw, _ := json.Marshal(map[string]any{"disabled": disabled, "attribution": attribution})
	rec := httptest.NewRecorder()
	api.HandleUpdatePluginConfig(rec,
		httptest.NewRequest(http.MethodPut, "/api/config/plugins", bytes.NewReader(raw)))
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT /api/config/plugins = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
}

// getPluginAttribution drives the GET and returns the attribution map.
func getPluginAttribution(t *testing.T, api *ConfigAPI) map[string]core.PluginAttribution {
	t.Helper()
	rec := httptest.NewRecorder()
	api.HandleGetPluginConfig(rec, httptest.NewRequest(http.MethodGet, "/api/config/plugins", nil))
	var payload struct {
		Attribution map[string]core.PluginAttribution `json:"attribution"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode plugin config: %v", err)
	}
	return payload.Attribution
}

// TestPluginAttributionOutlivesTheCapability: the disabled list holds bare ids,
// and a capability's id lives inside the JS module that defines it. So once that
// module stops loading — its extension removed, its file renamed, a fault
// introduced — nothing in the running app can say what the leftover id WAS, and
// its row degrades to a filename with no working toggle. The attribution
// lookaside is written at the moment of the switch-off, when the truth is known,
// so the row can still name itself afterwards.
func TestPluginAttributionOutlivesTheCapability(t *testing.T) {
	api := newTestConfigAPI(t)

	putPluginConfigWithAttribution(t, api, []string{"exa-search"}, map[string]any{
		"exa-search": map[string]any{
			"extension": "@juggler/exa",
			"file":      "exa-search-context-item.js",
			"type":      "context-item",
			"name":      "Exa Search",
		},
	})

	got := getPluginAttribution(t, api)
	entry, ok := got["exa-search"]
	if !ok {
		t.Fatalf("attribution for the switched-off id was not kept: %v", got)
	}
	if entry.Extension != "@juggler/exa" || entry.File != "exa-search-context-item.js" ||
		entry.Type != "context-item" || entry.Name != "Exa Search" {
		t.Errorf("attribution came back altered: %+v", entry)
	}

	// A later write that knows nothing new must not lose it — that later write
	// is exactly the case where the module is no longer loading.
	putPluginConfig(t, api, []string{"exa-search"})
	if _, ok := getPluginAttribution(t, api)["exa-search"]; !ok {
		t.Errorf("a write with no hints dropped what we already knew: %v", getPluginAttribution(t, api))
	}
}

// TestPluginAttributionIsPrunedWithTheList: it describes switched-off ids and
// nothing else, so switching one back on takes its entry with it. Otherwise the
// file accumulates a record of every capability ever toggled.
func TestPluginAttributionIsPrunedWithTheList(t *testing.T) {
	api := newTestConfigAPI(t)
	putPluginConfigWithAttribution(t, api, []string{"exa-search", "memory"}, map[string]any{
		"exa-search": map[string]any{"extension": "@juggler/exa", "file": "a.js", "type": "context-item"},
		"memory":     map[string]any{"extension": "@juggler/core", "file": "b.js", "type": "context-item"},
	})

	putPluginConfig(t, api, []string{"memory"})

	got := getPluginAttribution(t, api)
	if _, ok := got["exa-search"]; ok {
		t.Errorf("attribution outlived the id being switched back on: %v", got)
	}
	if _, ok := got["memory"]; !ok {
		t.Errorf("attribution for a still-disabled id was dropped: %v", got)
	}
}

// TestPluginConfigKeepsEachIdInOneList pins the split between the two lists.
// `enabled` exists only to countermand a default-off plugin, so switching such
// a plugin on must MOVE its id, never leave it in both lists at once. The same
// id appearing under `disabled` and `enabled` simultaneously used to be the
// normal representation of "switched on", which is unreadable by hand and made
// the resolved state impossible to reason about from the file.
func TestPluginConfigKeepsEachIdInOneList(t *testing.T) {
	api := newTestConfigAPI(t)

	// @juggler/exa ships default-off. The user switches the extension ON and one
	// capability inside it OFF: the resolved set is exactly {exa-search}.
	putPluginConfig(t, api, []string{"exa-search"})

	disabled, enabled := rawPluginLists(t, api)
	if slices.Contains(disabled, "@juggler/exa") {
		t.Errorf("a switched-on plugin is still listed disabled: disabled=%v enabled=%v", disabled, enabled)
	}
	if !slices.Contains(enabled, "@juggler/exa") {
		t.Errorf("the countermand for a default-off plugin was not recorded: enabled=%v", enabled)
	}
	if !slices.Contains(disabled, "exa-search") {
		t.Errorf("the switched-off capability was not recorded: disabled=%v", disabled)
	}

	if got := getPluginConfig(t, api); !slices.Equal(got, []string{"exa-search"}) {
		t.Errorf("resolved disabled = %v, want [exa-search]", got)
	}
}

// TestPluginConfigDefaultOffPluginNeedsNoUserEntry: a default-off plugin left
// alone is reported off without the user's file mentioning it. The default
// belongs to the code, so it must not be written into the user's data.
func TestPluginConfigDefaultOffPluginNeedsNoUserEntry(t *testing.T) {
	api := newTestConfigAPI(t)

	if got := getPluginConfig(t, api); !slices.Contains(got, "@juggler/exa") {
		t.Errorf("a default-off plugin is not reported off: %v", got)
	}

	// Switching something unrelated off must not drag the default into the file.
	putPluginConfig(t, api, []string{"@juggler/exa", "memory"})
	disabled, enabled := rawPluginLists(t, api)
	if slices.Contains(disabled, "@juggler/exa") {
		t.Errorf("the code-level default was written into the user's list: disabled=%v", disabled)
	}
	if len(enabled) != 0 {
		t.Errorf("nothing was countermanded, so enabled should be empty: %v", enabled)
	}
	if got := getPluginConfig(t, api); !slices.Contains(got, "memory") || !slices.Contains(got, "@juggler/exa") {
		t.Errorf("resolved disabled = %v, want both memory and @juggler/exa", got)
	}
}

// TestPluginConfigReadsLegacyBothListsShape: files already on disk carry an id
// in both lists (that was how "on" was stored). Such a file must resolve to the
// same set as the clean shape, and the next write must clean it up — no
// migration step, no user action.
func TestPluginConfigReadsLegacyBothListsShape(t *testing.T) {
	api := newTestConfigAPI(t)
	writeRawConfig(t, api, map[string]any{
		"disabled": []string{"@juggler/mcp", "memory", "exa-search", "@juggler/exa"},
		"enabled":  []string{"@juggler/exa"},
	})

	got := getPluginConfig(t, api)
	slices.Sort(got)
	want := []string{"@juggler/mcp", "exa-search", "memory"}
	if !slices.Equal(got, want) {
		t.Fatalf("legacy config resolved to %v, want %v", got, want)
	}

	putPluginConfig(t, api, got)
	disabled, enabled := rawPluginLists(t, api)
	for _, id := range disabled {
		if slices.Contains(enabled, id) {
			t.Errorf("%q is still in both lists after a write: disabled=%v enabled=%v", id, disabled, enabled)
		}
	}
	if !slices.Contains(enabled, "@juggler/exa") {
		t.Errorf("the extension is still switched on after the rewrite: enabled=%v", enabled)
	}
}
