//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package extconfig persists and resolves manifest-declared extension settings.
package extconfig

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/extmanifest"
	"juggler/cmd/juggler/ops"
	"juggler/internal/atomicio"
	"juggler/internal/userpaths"
	"juggler/web"
)

const secretPrefix = "ext:"

type manifestResolver func(string) (extmanifest.Manifest, error)

type operations struct {
	configRoot  string
	credentials *core.CredentialsStore
	manifest    manifestResolver
	writeGate   chan struct{}
}

// RegisterOps registers the extension configuration operations with the host.
func RegisterOps() error {
	credentials, err := core.NewCredentialsStore()
	if err != nil {
		return err
	}
	builtin, err := fs.Sub(web.Files, ".")
	if err != nil {
		return err
	}
	o := &operations{
		configRoot:  filepath.Join(userpaths.ConfigDir(), "extension-config"),
		credentials: credentials,
		manifest:    filesystemManifestResolver(builtin, filepath.Join(userpaths.ConfigDir(), "extensions")),
		writeGate:   make(chan struct{}, 1),
	}
	ops.Register("extconfig", func(ops.PathScope) ops.Operations { return o })
	return nil
}

func (o *operations) Execute(_ context.Context, operation string, params map[string]any) (any, error) {
	extID, ok := params["extId"].(string)
	if !ok || strings.TrimSpace(extID) == "" {
		return nil, fmt.Errorf("extId is required")
	}
	manifest, err := o.manifest(extID)
	if err != nil {
		return nil, err
	}
	if manifest.ID != extID {
		return nil, fmt.Errorf("extension %q was not found", extID)
	}
	switch operation {
	case "get":
		return o.get(manifest, false)
	case "resolve":
		return o.get(manifest, true)
	case "set":
		return o.set(manifest, params)
	default:
		return nil, fmt.Errorf("unknown extconfig operation: %s", operation)
	}
}

func (o *operations) get(manifest extmanifest.Manifest, revealSecrets bool) (map[string]any, error) {
	stored, err := o.load(manifest.ID)
	if err != nil {
		return nil, err
	}
	values := make(map[string]any, len(manifest.Settings))
	for _, setting := range manifest.Settings {
		if setting.Type == "secret" {
			secret := o.credentials.GetRawKey(secretKey(manifest.ID, setting.Key))
			if revealSecrets {
				if secret != "" {
					values[setting.Key] = secret
				}
			} else {
				values[setting.Key] = map[string]any{"__present": secret != ""}
			}
			continue
		}
		if value, ok := stored[setting.Key]; ok {
			values[setting.Key] = value
			continue
		}
		if len(setting.Default) != 0 {
			var value any
			if err := json.Unmarshal(setting.Default, &value); err != nil {
				return nil, fmt.Errorf("decode default for %q: %w", setting.Key, err)
			}
			values[setting.Key] = value
		}
	}
	return values, nil
}

func (o *operations) set(manifest extmanifest.Manifest, params map[string]any) (map[string]any, error) {
	if scope, ok := params["scope"].(string); ok && scope != "" && scope != "global" {
		return nil, fmt.Errorf("unsupported extension config scope %q; only global is supported", scope)
	}
	values, ok := params["values"].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("values must be an object")
	}
	fields := make(map[string]extmanifest.Setting, len(manifest.Settings))
	for _, setting := range manifest.Settings {
		fields[setting.Key] = setting
	}
	for key := range values {
		if _, ok := fields[key]; !ok {
			return nil, fmt.Errorf("extension %q has no setting %q", manifest.ID, key)
		}
	}

	normalized := make(map[string]any, len(values))
	for key, value := range values {
		setting := fields[key]
		if setting.Type == "secret" {
			if marker, ok := value.(map[string]any); ok {
				if present, markerOK := marker["__present"].(bool); markerOK && present && len(marker) == 1 {
					normalized[key] = marker
					continue
				}
				return nil, fmt.Errorf("setting %q has an invalid secret marker", key)
			}
			if value == nil || value == "" {
				if setting.Required {
					return nil, fmt.Errorf("setting %q is required and cannot be cleared", key)
				}
				normalized[key] = ""
				continue
			}
			checked, err := extmanifest.ValidateSettingValue(setting, value)
			if err != nil {
				return nil, fmt.Errorf("setting %q %w", key, err)
			}
			normalized[key] = checked
			continue
		}
		if value == nil {
			if setting.Required {
				return nil, fmt.Errorf("setting %q is required and cannot be cleared", key)
			}
			normalized[key] = nil
			continue
		}
		checked, err := extmanifest.ValidateSettingValue(setting, value)
		if err != nil {
			return nil, fmt.Errorf("setting %q %w", key, err)
		}
		if setting.Required && checked == "" {
			return nil, fmt.Errorf("setting %q is required and cannot be empty", key)
		}
		normalized[key] = checked
	}

	o.writeGate <- struct{}{}
	defer func() { <-o.writeGate }()
	stored, err := o.load(manifest.ID)
	if err != nil {
		return nil, err
	}
	for key, value := range normalized {
		setting := fields[key]
		if setting.Type == "secret" {
			if _, preserve := value.(map[string]any); preserve {
				continue
			}
			if err := o.credentials.SetRawKey(secretKey(manifest.ID, key), value.(string)); err != nil {
				return nil, err
			}
			continue
		}
		if value == nil {
			delete(stored, key)
		} else {
			stored[key] = value
		}
	}
	if err := o.save(manifest.ID, stored); err != nil {
		return nil, err
	}
	return o.get(manifest, false)
}

func (o *operations) configPath(extID string) string {
	sum := sha256.Sum256([]byte(extID))
	return filepath.Join(o.configRoot, hex.EncodeToString(sum[:]), "config.json")
}

func (o *operations) load(extID string) (map[string]any, error) {
	data, err := atomicio.RobustReadFile(o.configPath(extID))
	if os.IsNotExist(err) {
		return map[string]any{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read extension config: %w", err)
	}
	var values map[string]any
	if err := json.Unmarshal(data, &values); err != nil {
		return nil, fmt.Errorf("parse extension config: %w", err)
	}
	if values == nil {
		values = map[string]any{}
	}
	return values, nil
}

func (o *operations) save(extID string, values map[string]any) error {
	filename := o.configPath(extID)
	if err := os.MkdirAll(filepath.Dir(filename), 0o700); err != nil {
		return fmt.Errorf("create extension config directory: %w", err)
	}
	data, err := json.MarshalIndent(values, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(filename), "config-*.json.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := atomicio.RobustRename(tmpName, filename); err != nil {
		return fmt.Errorf("write extension config: %w", err)
	}
	return nil
}

func secretKey(extID, key string) string { return secretPrefix + extID + ":" + key }

func filesystemManifestResolver(builtin fs.FS, userDir string) manifestResolver {
	engineVersion := extmanifest.ReadEngineAPIVersion(builtin)
	return func(extID string) (extmanifest.Manifest, error) {
		var found *extmanifest.Manifest
		entries, _ := fs.ReadDir(builtin, "extensions")
		for _, entry := range entries {
			if entry.IsDir() {
				if manifest, ok := readManifest(builtin, path.Join("extensions", entry.Name(), extmanifest.ManifestFileName)); ok && manifest.ID == extID {
					copy := manifest
					found = &copy
				}
			}
		}
		userEntries, _ := os.ReadDir(userDir)
		for _, entry := range userEntries {
			info, err := os.Stat(filepath.Join(userDir, entry.Name()))
			if err != nil || !info.IsDir() {
				continue
			}
			data, err := os.ReadFile(filepath.Join(userDir, entry.Name(), extmanifest.ManifestFileName))
			if err != nil {
				continue
			}
			manifest, err := extmanifest.Parse(data)
			if err == nil && manifest.ID == extID {
				copy := manifest
				found = &copy
			}
		}
		if found == nil {
			return extmanifest.Manifest{}, fmt.Errorf("extension %q was not found", extID)
		}
		if err := extmanifest.Validate(*found, engineVersion); err != nil {
			return extmanifest.Manifest{}, err
		}
		return *found, nil
	}
}

func readManifest(fsys fs.FS, filename string) (extmanifest.Manifest, bool) {
	data, err := fs.ReadFile(fsys, filename)
	if err != nil {
		return extmanifest.Manifest{}, false
	}
	manifest, err := extmanifest.Parse(data)
	return manifest, err == nil
}
