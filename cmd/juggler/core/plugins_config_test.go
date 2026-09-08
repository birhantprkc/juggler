//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

// writePluginsConfig plants a .juggler/config.json holding just the plugin lists.
func writePluginsConfig(t *testing.T, dir string, plugins map[string]any) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(dir, ".juggler"), 0o755); err != nil {
		t.Fatalf("mkdir .juggler: %v", err)
	}
	raw, _ := json.Marshal(map[string]any{"plugins": plugins})
	if err := os.WriteFile(filepath.Join(dir, ".juggler", "config.json"), raw, 0o644); err != nil {
		t.Fatalf("write config.json: %v", err)
	}
}

// TestLoadConfigLeavesTheUsersDisabledListAlone: loading is a read. The
// code-level default set used to be appended into the loaded config, so every
// read mutated the user's data and the default could never be removed — it came
// back on the next load. Defaults now resolve on top of the file instead.
func TestLoadConfigLeavesTheUsersDisabledListAlone(t *testing.T) {
	dir := t.TempDir()
	writePluginsConfig(t, dir, map[string]any{"disabled": []string{"memory"}})

	cfg, err := LoadConfig(dir)
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if !slices.Equal(cfg.Plugins.Disabled, []string{"memory"}) {
		t.Errorf("LoadConfig edited the user's disabled list: %v", cfg.Plugins.Disabled)
	}
	if !slices.Contains(cfg.ResolvedDisabledPlugins(), "@juggler/exa") {
		t.Errorf("the default-off plugin is not resolved off: %v", cfg.ResolvedDisabledPlugins())
	}
	if !slices.Contains(cfg.ResolvedDisabledPlugins(), "memory") {
		t.Errorf("the user's own entry was lost: %v", cfg.ResolvedDisabledPlugins())
	}
}

// TestResolvedDisabledPluginsAppliesTheCountermand: `enabled` overrides both the
// code default and an explicit user entry, and the resolved set never repeats an
// id however many times the two lists mention it.
func TestResolvedDisabledPluginsAppliesTheCountermand(t *testing.T) {
	dir := t.TempDir()
	writePluginsConfig(t, dir, map[string]any{
		"disabled": []string{"@juggler/exa", "memory", "memory"},
		"enabled":  []string{"@juggler/exa"},
	})

	cfg, err := LoadConfig(dir)
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	got := cfg.ResolvedDisabledPlugins()
	if !slices.Equal(got, []string{"memory"}) {
		t.Errorf("resolved = %v, want exactly [memory]", got)
	}
}
