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

// CheapModelSetting is the persisted cheap-model choice: a model pin, or the
// explicit decision not to have one at all.
//
// ModelRef is embedded rather than nested so the JSON stays a flat object,
// which is what lets a file written with only {provider, model} keep loading
// as the pin it names.
//
// Disabled is the field that makes this type necessary, and it exists because
// an absent file cannot mean two things at once. "Never set" and "turned off"
// both name no model, so without a flag to tell them apart the server has no
// way to honour a user who wants no cheap model — it would keep deriving one,
// and keep nudging about it.
type CheapModelSetting struct {
	ModelRef
	Disabled bool `json:"disabled,omitempty"`
}

// CheapModelStore persists the user's chosen "cheap" model — a small/fast model
// used for out-of-band micro-tasks (auto-naming a tab, plugin generateText
// calls) rather than for the conversation itself. It lives in
// ~/.juggler/cheap-model.json (0600, owner-only). An absent file means "Auto":
// the server derives a cheap model from the primary model's provider instead.
//
// A close sibling of DefaultModelStore — same file discipline, same
// absent-file-means-automatic contract — but deliberately not the same type.
// A default model has no meaningful "off" (a conversation must run on
// something), whereas a cheap model does: nothing breaks if the micro-tasks
// simply don't run, so the user is allowed to say so, and CheapModelSetting is
// where that answer is kept.
type CheapModelStore struct {
	filePath string
}

// NewCheapModelStore creates a store rooted at ~/.juggler.
func NewCheapModelStore() (*CheapModelStore, error) {
	return &CheapModelStore{
		filePath: filepath.Join(userpaths.ConfigDir(), "cheap-model.json"),
	}, nil
}

// Load reads the stored cheap-model setting. Returns the zero setting — no
// model, not disabled — when the file does not exist or is empty, i.e. Auto.
func (s *CheapModelStore) Load() (CheapModelSetting, error) {
	data, err := os.ReadFile(s.filePath)
	if os.IsNotExist(err) {
		return CheapModelSetting{}, nil
	}
	if err != nil {
		return CheapModelSetting{}, fmt.Errorf("failed to read cheap model file: %w", err)
	}
	if len(data) == 0 {
		return CheapModelSetting{}, nil
	}

	var setting CheapModelSetting
	if err := json.Unmarshal(data, &setting); err != nil {
		return CheapModelSetting{}, fmt.Errorf("failed to parse cheap model file: %w", err)
	}
	return setting, nil
}

// Save persists the cheap-model setting. Three outcomes, in this order:
//
//   - Disabled ⇒ the file is written with the flag, model pin or not. This case
//     comes first because an off setting names no model, so the clearing rule
//     below would otherwise delete the record of the very choice being made and
//     read it back as Auto.
//   - An empty ref ⇒ the file is deleted, reverting to Auto. Absence is how Auto
//     is spelled, so there is nothing to write.
//   - Otherwise the pin is written.
func (s *CheapModelStore) Save(setting CheapModelSetting) error {
	if !setting.Disabled && (setting.Provider == "" || setting.Model == "") {
		if err := os.Remove(s.filePath); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("failed to clear cheap model file: %w", err)
		}
		return nil
	}

	dir := filepath.Dir(s.filePath)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return fmt.Errorf("failed to create cheap model directory: %w", err)
	}

	data, err := json.MarshalIndent(setting, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal cheap model: %w", err)
	}
	if err := os.WriteFile(s.filePath, data, 0600); err != nil {
		return fmt.Errorf("failed to write cheap model file: %w", err)
	}
	return nil
}
