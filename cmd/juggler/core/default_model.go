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

// DefaultModelStore persists the single model a new conversation is seeded
// with, in ~/.juggler/default-model.json (0600, owner-only). An absent file
// means "automatic" — the server computes a preferred model from the live
// provider list instead.
type DefaultModelStore struct {
	filePath string
}

// NewDefaultModelStore creates a store rooted at ~/.juggler.
func NewDefaultModelStore() (*DefaultModelStore, error) {
	return &DefaultModelStore{
		filePath: filepath.Join(userpaths.ConfigDir(), "default-model.json"),
	}, nil
}

// Load reads the stored default model. Returns an empty ModelRef (Provider and
// Model both "") when the file does not exist or is empty — i.e. automatic.
func (s *DefaultModelStore) Load() (ModelRef, error) {
	data, err := os.ReadFile(s.filePath)
	if os.IsNotExist(err) {
		return ModelRef{}, nil
	}
	if err != nil {
		return ModelRef{}, fmt.Errorf("failed to read default model file: %w", err)
	}
	if len(data) == 0 {
		return ModelRef{}, nil
	}

	var ref ModelRef
	if err := json.Unmarshal(data, &ref); err != nil {
		return ModelRef{}, fmt.Errorf("failed to parse default model file: %w", err)
	}
	return ref, nil
}

// Save persists the default model. An empty ref (either field blank) clears the
// stored value, reverting to automatic selection by deleting the file.
func (s *DefaultModelStore) Save(ref ModelRef) error {
	if ref.Provider == "" || ref.Model == "" {
		if err := os.Remove(s.filePath); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("failed to clear default model file: %w", err)
		}
		return nil
	}

	dir := filepath.Dir(s.filePath)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return fmt.Errorf("failed to create default model directory: %w", err)
	}

	data, err := json.MarshalIndent(ref, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal default model: %w", err)
	}
	if err := os.WriteFile(s.filePath, data, 0600); err != nil {
		return fmt.Errorf("failed to write default model file: %w", err)
	}
	return nil
}
