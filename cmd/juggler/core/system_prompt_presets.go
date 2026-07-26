//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"juggler/internal/userpaths"
)

// SystemPromptPreset is one user-saved system-prompt preset: a named, full
// prompt body. Built-in presets ship in the frontend and are NOT stored here —
// this store holds only the user's own presets plus the id of whichever preset
// (built-in or user) is the session default.
type SystemPromptPreset struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Content string `json:"content"`
}

// systemPromptPresetsFile is the on-disk shape of system-prompt-presets.json.
type systemPromptPresetsFile struct {
	Presets   []SystemPromptPreset `json:"presets"`
	DefaultID string               `json:"defaultId"`
}

// SystemPromptPresetStore persists user-saved system-prompt presets and the
// chosen default preset id in ~/.juggler/system-prompt-presets.json (0600,
// owner-only). An absent file means "no user presets, no explicit default" —
// the frontend then falls back to the built-in `default` preset.
type SystemPromptPresetStore struct {
	filePath string
}

// NewSystemPromptPresetStore creates a store rooted at ~/.juggler.
func NewSystemPromptPresetStore() (*SystemPromptPresetStore, error) {
	return &SystemPromptPresetStore{
		filePath: filepath.Join(userpaths.ConfigDir(), "system-prompt-presets.json"),
	}, nil
}

// Load reads the stored user presets and default id. Returns an empty slice and
// empty default id when the file does not exist or is empty.
func (s *SystemPromptPresetStore) Load() ([]SystemPromptPreset, string, error) {
	f, err := s.read()
	if err != nil {
		return nil, "", err
	}
	if f.Presets == nil {
		f.Presets = []SystemPromptPreset{}
	}
	return f.Presets, f.DefaultID, nil
}

// Create appends a new user preset with a generated unique id and returns it.
// Name and content are required (after trimming).
func (s *SystemPromptPresetStore) Create(name, content string) (SystemPromptPreset, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return SystemPromptPreset{}, fmt.Errorf("preset name is required")
	}
	if strings.TrimSpace(content) == "" {
		return SystemPromptPreset{}, fmt.Errorf("preset content is required")
	}

	f, err := s.read()
	if err != nil {
		return SystemPromptPreset{}, err
	}

	preset := SystemPromptPreset{
		ID:      uniquePresetID(name, f.Presets),
		Name:    name,
		Content: content,
	}
	f.Presets = append(f.Presets, preset)
	if err := s.write(f); err != nil {
		return SystemPromptPreset{}, err
	}
	return preset, nil
}

// Delete removes the user preset with the given id. Deleting an unknown id is a
// no-op (idempotent). If the deleted preset was the default, the default is
// cleared (reverting to the built-in default).
func (s *SystemPromptPresetStore) Delete(id string) error {
	f, err := s.read()
	if err != nil {
		return err
	}
	kept := f.Presets[:0]
	for _, p := range f.Presets {
		if p.ID != id {
			kept = append(kept, p)
		}
	}
	f.Presets = kept
	if f.DefaultID == id {
		f.DefaultID = ""
	}
	return s.write(f)
}

// Update replaces the name and content of an existing user preset identified by
// id. Name and content are required (after trimming). Returns the updated preset
// or an error when the id is not found.
func (s *SystemPromptPresetStore) Update(id, name, content string) (SystemPromptPreset, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return SystemPromptPreset{}, fmt.Errorf("preset name is required")
	}
	if strings.TrimSpace(content) == "" {
		return SystemPromptPreset{}, fmt.Errorf("preset content is required")
	}

	f, err := s.read()
	if err != nil {
		return SystemPromptPreset{}, err
	}

	for i, p := range f.Presets {
		if p.ID == id {
			f.Presets[i].Name = name
			f.Presets[i].Content = content
			if err := s.write(f); err != nil {
				return SystemPromptPreset{}, err
			}
			return f.Presets[i], nil
		}
	}
	return SystemPromptPreset{}, fmt.Errorf("preset %q not found", id)
}

// SetDefault records which preset id new conversations are seeded from. The id
// may name a built-in preset (e.g. "default") or a user preset — the store does
// not validate it against the built-in set, which lives in the frontend. An
// empty id clears the explicit default.
func (s *SystemPromptPresetStore) SetDefault(id string) error {
	f, err := s.read()
	if err != nil {
		return err
	}
	f.DefaultID = id
	return s.write(f)
}

// read loads and parses the file, returning a zero-value struct when absent.
func (s *SystemPromptPresetStore) read() (systemPromptPresetsFile, error) {
	var f systemPromptPresetsFile
	data, err := os.ReadFile(s.filePath)
	if os.IsNotExist(err) {
		return f, nil
	}
	if err != nil {
		return f, fmt.Errorf("failed to read system prompt presets file: %w", err)
	}
	if len(data) == 0 {
		return f, nil
	}
	if err := json.Unmarshal(data, &f); err != nil {
		return f, fmt.Errorf("failed to parse system prompt presets file: %w", err)
	}
	return f, nil
}

// write persists the file (0600). When the file would carry no presets and no
// default, it is removed so an empty store leaves no stale file behind.
func (s *SystemPromptPresetStore) write(f systemPromptPresetsFile) error {
	if len(f.Presets) == 0 && f.DefaultID == "" {
		if err := os.Remove(s.filePath); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("failed to clear system prompt presets file: %w", err)
		}
		return nil
	}
	if f.Presets == nil {
		f.Presets = []SystemPromptPreset{}
	}
	if err := os.MkdirAll(filepath.Dir(s.filePath), 0700); err != nil {
		return fmt.Errorf("failed to create system prompt presets directory: %w", err)
	}
	data, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal system prompt presets: %w", err)
	}
	if err := os.WriteFile(s.filePath, data, 0600); err != nil {
		return fmt.Errorf("failed to write system prompt presets file: %w", err)
	}
	return nil
}

// uniquePresetID derives a stable, collision-free id from a preset name. User
// preset ids are prefixed `user-` so they can never collide with a built-in
// preset id (default/minimal/...). On collision within the user set a numeric
// suffix is appended.
func uniquePresetID(name string, existing []SystemPromptPreset) string {
	taken := make(map[string]bool, len(existing))
	for _, p := range existing {
		taken[p.ID] = true
	}
	base := "user-" + slugify(name)
	id := base
	for i := 2; taken[id]; i++ {
		id = fmt.Sprintf("%s-%d", base, i)
	}
	return id
}

// slugify lowercases a string and reduces it to [a-z0-9-] runs, trimming dashes.
// Returns "preset" when nothing usable remains.
func slugify(s string) string {
	var b strings.Builder
	prevDash := false
	for _, r := range strings.ToLower(s) {
		switch {
		case (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9'):
			b.WriteRune(r)
			prevDash = false
		default:
			if !prevDash {
				b.WriteByte('-')
				prevDash = true
			}
		}
	}
	out := strings.Trim(b.String(), "-")
	if out == "" {
		return "preset"
	}
	return out
}
