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

// CheapModelStore persists the user's chosen "cheap" model — a small/fast model
// used for out-of-band micro-tasks (auto-naming a tab, plugin generateText
// calls) rather than for the conversation itself. It lives in
// ~/.juggler/cheap-model.json (0600, owner-only). An absent file means "Auto":
// the server derives a cheap model from the primary model's provider instead.
//
// Deliberately a near-verbatim sibling of DefaultModelStore — same ModelRef,
// same absent-file-means-automatic contract — so the two settings behave
// identically from the UI's point of view.
type CheapModelStore struct {
	filePath string
}

// NewCheapModelStore creates a store rooted at ~/.juggler.
func NewCheapModelStore() (*CheapModelStore, error) {
	return &CheapModelStore{
		filePath: filepath.Join(userpaths.ConfigDir(), "cheap-model.json"),
	}, nil
}

// Load reads the stored cheap model. Returns an empty ModelRef (Provider and
// Model both "") when the file does not exist or is empty — i.e. Auto.
func (s *CheapModelStore) Load() (ModelRef, error) {
	data, err := os.ReadFile(s.filePath)
	if os.IsNotExist(err) {
		return ModelRef{}, nil
	}
	if err != nil {
		return ModelRef{}, fmt.Errorf("failed to read cheap model file: %w", err)
	}
	if len(data) == 0 {
		return ModelRef{}, nil
	}

	var ref ModelRef
	if err := json.Unmarshal(data, &ref); err != nil {
		return ModelRef{}, fmt.Errorf("failed to parse cheap model file: %w", err)
	}
	return ref, nil
}

// Save persists the cheap model. An empty ref (either field blank) clears the
// stored value, reverting to Auto by deleting the file.
func (s *CheapModelStore) Save(ref ModelRef) error {
	if ref.Provider == "" || ref.Model == "" {
		if err := os.Remove(s.filePath); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("failed to clear cheap model file: %w", err)
		}
		return nil
	}

	dir := filepath.Dir(s.filePath)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return fmt.Errorf("failed to create cheap model directory: %w", err)
	}

	data, err := json.MarshalIndent(ref, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal cheap model: %w", err)
	}
	if err := os.WriteFile(s.filePath, data, 0600); err != nil {
		return fmt.Errorf("failed to write cheap model file: %w", err)
	}
	return nil
}
