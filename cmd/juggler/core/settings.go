//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"juggler/internal/userpaths"
)

// GlobalSettings is the user's global (not per-project) preference document,
// stored at <ConfigDir>/settings.json (~/.juggler/settings.json on macOS/Win,
// $XDG_CONFIG_HOME/juggler/settings.json on Linux). It is distinct from the
// per-project .juggler/config.json (Config): this file holds preferences that
// apply to the user across every project. Built to grow — add new sections as
// sibling fields; unknown keys are ignored on read, so the format is additive.
type GlobalSettings struct {
	Updates UpdateSettings `json:"updates"`
}

// UpdateSettings controls how the app looks for and applies new versions.
type UpdateSettings struct {
	// Mode is one of UpdateModeAutomatic / UpdateModeNotify / UpdateModeOff.
	// An empty value normalises to automatic (the shipped default), so an
	// absent file or an untouched setting behaves exactly as before.
	Mode string `json:"mode,omitempty"`
}

// Update-mode values persisted in UpdateSettings.Mode.
const (
	// UpdateModeAutomatic checks on a schedule and auto-downloads (default).
	UpdateModeAutomatic = "automatic"
	// UpdateModeNotify checks on a schedule and surfaces an "Update"
	// affordance, but never auto-downloads — the user starts the download.
	UpdateModeNotify = "notify"
	// UpdateModeOff disables automatic checking entirely; an explicit manual
	// "Check for updates" still runs on demand.
	UpdateModeOff = "off"
)

// NormalizeUpdateMode maps any value to a known mode, defaulting anything
// unrecognised (including the empty string) to automatic. Use this on read and
// before comparing modes, so callers never have to special-case "".
func NormalizeUpdateMode(mode string) string {
	switch mode {
	case UpdateModeNotify:
		return UpdateModeNotify
	case UpdateModeOff:
		return UpdateModeOff
	default:
		return UpdateModeAutomatic
	}
}

// IsKnownUpdateMode reports whether mode is one of the three recognised values.
// The API validator uses this to reject a hand-posted or typo'd mode; the empty
// string is NOT known (callers that accept "as default" check for "" first).
func IsKnownUpdateMode(mode string) bool {
	return mode == UpdateModeAutomatic || mode == UpdateModeNotify || mode == UpdateModeOff
}

// defaultGlobalSettings returns the settings a fresh install (no file) uses.
func defaultGlobalSettings() *GlobalSettings {
	return &GlobalSettings{Updates: UpdateSettings{Mode: UpdateModeAutomatic}}
}

// globalSettingsPath is the on-disk location of the settings document.
func globalSettingsPath() string {
	return filepath.Join(userpaths.ConfigDir(), "settings.json")
}

// LoadGlobalSettings reads the global settings, tolerating a missing or corrupt
// file by returning defaults (a hand-edit typo must never brick startup). The
// returned pointer is always non-nil and fully normalised, so callers can use
// it even when a non-nil error is also returned (missing file returns nil
// error; a real read/parse failure returns defaults plus the error for logging).
func LoadGlobalSettings() (*GlobalSettings, error) {
	data, err := os.ReadFile(globalSettingsPath())
	if err != nil {
		if os.IsNotExist(err) {
			return defaultGlobalSettings(), nil
		}
		return defaultGlobalSettings(), fmt.Errorf("failed to read settings: %w", err)
	}
	gs := defaultGlobalSettings()
	if err := json.Unmarshal(data, gs); err != nil {
		// Corrupt file: fall back to clean defaults but report what happened.
		return defaultGlobalSettings(), fmt.Errorf("failed to parse settings: %w", err)
	}
	gs.Updates.Mode = NormalizeUpdateMode(gs.Updates.Mode)
	return gs, nil
}

// SaveGlobalSettings writes gs as indented JSON (0644), creating the config
// directory if needed. The mode is normalised before writing so the file always
// holds a canonical value.
func SaveGlobalSettings(gs *GlobalSettings) error {
	if gs == nil {
		gs = defaultGlobalSettings()
	}
	gs.Updates.Mode = NormalizeUpdateMode(gs.Updates.Mode)

	dir := userpaths.ConfigDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("failed to create config directory: %w", err)
	}
	data, err := json.MarshalIndent(gs, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal settings: %w", err)
	}
	if err := os.WriteFile(globalSettingsPath(), data, 0o644); err != nil {
		return fmt.Errorf("failed to write settings: %w", err)
	}
	return nil
}
