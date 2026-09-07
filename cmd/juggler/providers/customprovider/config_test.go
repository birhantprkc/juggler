//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package customprovider

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"juggler/cmd/juggler/providers/provider"
	"juggler/internal/userpaths"
	"juggler/internal/userpaths/userpathstest"
)

func writeRawConfig(t *testing.T, body string) {
	t.Helper()
	path := filepath.Join(userpaths.ConfigDir(), configFileName)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
}

func TestLoadMissingFileIsEmptyNotAnError(t *testing.T) {
	userpathstest.Isolate(t)
	got, err := Load()
	if err != nil {
		t.Fatalf("Load with no file: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("Load with no file = %v, want empty", got)
	}
}

func TestLoadMalformedFileIsLoud(t *testing.T) {
	userpathstest.Isolate(t)
	writeRawConfig(t, `{"customProviders": not json}`)
	if _, err := Load(); err == nil {
		t.Fatal("Load accepted a malformed file; a typo must not silently drop every endpoint")
	}
}

func TestSaveLoadRoundTrip(t *testing.T) {
	userpathstest.Isolate(t)
	disabled := false
	want := map[string]Instance{
		"acme": {
			DisplayName: "Acme Gateway",
			Protocol:    ProtocolOpenAI,
			BaseURL:     "https://gateway.acme.test/v1",
			Headers:     map[string]string{"X-Tenant": "acme"},
		},
		"lab": {
			DisplayName: "Lab box",
			BaseURL:     "http://127.0.0.1:8080/v1",
			Enabled:     &disabled,
		},
	}
	if err := Save(want); err != nil {
		t.Fatalf("Save: %v", err)
	}
	got, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("loaded %d entries, want 2", len(got))
	}
	acme := got["acme"]
	if acme.DisplayName != "Acme Gateway" || acme.BaseURL != "https://gateway.acme.test/v1" {
		t.Fatalf("acme round-tripped as %+v", acme)
	}
	if acme.Headers["X-Tenant"] != "acme" {
		t.Fatalf("acme headers round-tripped as %v", acme.Headers)
	}
	// Absent enabled means enabled; an explicit false survives the round trip.
	if !acme.IsEnabled() {
		t.Fatal("entry with no enabled field read back as disabled")
	}
	if got["lab"].IsEnabled() {
		t.Fatal("entry explicitly disabled read back as enabled")
	}
	// A blank protocol resolves rather than being stored as a second spelling.
	if got["lab"].EffectiveProtocol() != ProtocolOpenAI {
		t.Fatalf("blank protocol resolved to %q", got["lab"].EffectiveProtocol())
	}
}

// TestSaveWritesOwnerOnly pins the 0600: an entry's headers are where a gateway
// auth header goes, so this file is credential-adjacent.
func TestSaveWritesOwnerOnly(t *testing.T) {
	userpathstest.Isolate(t)
	if err := Save(map[string]Instance{"acme": {BaseURL: "https://gateway.test/v1"}}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	info, err := os.Stat(filepath.Join(userpaths.ConfigDir(), configFileName))
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("file mode = %o, want 600", perm)
	}
}

func TestValidateIDRejections(t *testing.T) {
	userpathstest.Isolate(t)
	for _, tc := range []struct{ name, id string }{
		{"empty", ""},
		{"leading digit breaks a CSS id selector", "1acme"},
		{"uppercase", "Acme"},
		{"space", "acme gateway"},
		{"colon breaks querySelector", "acme:eu"},
		{"slash", "acme/eu"},
		{"underscore", "acme_eu"},
		{"leading hyphen", "-acme"},
		{"trailing hyphen", "acme-"},
		{"doubled hyphen", "acme--eu"},
		{"too long", strings.Repeat("a", maxIDLength+1)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := ValidateID(tc.id); err == nil {
				t.Fatalf("ValidateID(%q) accepted it", tc.id)
			}
		})
	}
	for _, id := range []string{"acme", "acme-eu", "a", "acme2", "my-gateway-eu-west-1"} {
		if err := ValidateID(id); err != nil {
			t.Fatalf("ValidateID(%q) = %v, want accepted", id, err)
		}
	}
}

func TestValidateIDRejectsACollisionWithARegisteredProvider(t *testing.T) {
	userpathstest.Isolate(t)
	const id = "already-registered"
	provider.RegisterProvider(provider.ProviderInfo{Name: RegisteredName(id)}, func(provider.Config) (provider.Provider, error) {
		return nil, nil
	})
	t.Cleanup(func() { provider.UnregisterProvider(RegisteredName(id)) })

	if err := ValidateID(id); err == nil {
		t.Fatal("ValidateID accepted an id whose registered name is already taken")
	}
	// A built-in's own name is not itself a collision, because the prefix keeps
	// the two apart — that is what the prefix is for.
	if err := ValidateID("anthropic"); err != nil {
		t.Fatalf("ValidateID(\"anthropic\") = %v; the prefix should keep it clear of the built-in", err)
	}
}

// TestRegisteredNameIsSelectorSafe guards the reason the prefix is a hyphen: the
// settings UI builds DOM ids from a provider id and finds them again with
// querySelector("#<id>-key"), where a colon would parse as a pseudo-class.
func TestRegisteredNameIsSelectorSafe(t *testing.T) {
	got := RegisteredName("acme-eu")
	if strings.ContainsAny(got, ":/ .#[]") {
		t.Fatalf("RegisteredName = %q, which is not safe in a CSS id selector", got)
	}
	if got != "custom-acme-eu" {
		t.Fatalf("RegisteredName = %q, want custom-acme-eu", got)
	}
}

func TestValidateInstanceRejections(t *testing.T) {
	for _, tc := range []struct {
		name string
		inst Instance
	}{
		{"no base URL", Instance{}},
		{"blank base URL", Instance{BaseURL: "   "}},
		{"no scheme", Instance{BaseURL: "gateway.test/v1"}},
		{"wrong scheme", Instance{BaseURL: "ftp://gateway.test/v1"}},
		{"no host", Instance{BaseURL: "https:///v1"}},
		{"unknown protocol", Instance{Protocol: "anthropic", BaseURL: "https://gateway.test"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := ValidateInstance(tc.inst); err == nil {
				t.Fatalf("ValidateInstance(%+v) accepted it", tc.inst)
			}
		})
	}
}

func TestSaveRejectsABadEntryAndLeavesTheFileAlone(t *testing.T) {
	userpathstest.Isolate(t)
	good := map[string]Instance{"acme": {BaseURL: "https://gateway.test/v1"}}
	if err := Save(good); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if err := Save(map[string]Instance{"acme": {BaseURL: "not a url at all"}}); err == nil {
		t.Fatal("Save accepted an entry with an unusable base URL")
	}
	if err := Save(map[string]Instance{"Bad Id": {BaseURL: "https://gateway.test/v1"}}); err == nil {
		t.Fatal("Save accepted a malformed id")
	}
	got, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(got) != 1 || got["acme"].BaseURL != "https://gateway.test/v1" {
		t.Fatalf("a rejected Save disturbed the stored definitions: %+v", got)
	}
}
