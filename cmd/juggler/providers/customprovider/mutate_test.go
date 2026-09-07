//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package customprovider

import (
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/providers/provider"
	"juggler/internal/userpaths/userpathstest"
)

// twoInstances is the shared fixture: the endpoint under test and a second one
// that must come through every deletion untouched.
func twoInstances(t *testing.T) {
	t.Helper()
	syncInstances(t, map[string]Instance{
		"acme": {DisplayName: "Acme Gateway", BaseURL: "https://gateway.acme.test/v1"},
		"keep": {DisplayName: "Keeper", BaseURL: "https://keeper.test/v1"},
	})
}

// curateModelSettings hides a model and pins a limit for both custom endpoints
// and for a built-in provider, so a prune that reaches too far is visible.
func curateModelSettings(t *testing.T) {
	t.Helper()
	if _, err := core.UpdateGlobalSettings(func(gs *core.GlobalSettings) bool {
		gs.Models.Hidden = map[string][]string{
			"custom-acme": {"m1"},
			"custom-keep": {"m2"},
			"openai":      {"m3"},
		}
		gs.Models.Limits = map[string]map[string]core.ModelLimits{
			"custom-acme": {"m1": {ContextWindow: 1000}},
			"custom-keep": {"m2": {ContextWindow: 2000}},
			"openai":      {"m3": {ContextWindow: 3000}},
		}
		return true
	}); err != nil {
		t.Fatalf("UpdateGlobalSettings: %v", err)
	}
}

func TestDeleteForgetsEverythingKeyedToTheDeletedProvider(t *testing.T) {
	userpathstest.Isolate(t)
	twoInstances(t)
	curateModelSettings(t)

	defaults, err := core.NewDefaultModelStore()
	if err != nil {
		t.Fatalf("NewDefaultModelStore: %v", err)
	}
	cheap, err := core.NewCheapModelStore()
	if err != nil {
		t.Fatalf("NewCheapModelStore: %v", err)
	}
	if err := defaults.Save(core.ModelRef{Provider: "custom-acme", Model: "m1"}); err != nil {
		t.Fatalf("save default model: %v", err)
	}
	if err := cheap.Save(core.ModelRef{Provider: "custom-keep", Model: "m2"}); err != nil {
		t.Fatalf("save cheap model: %v", err)
	}

	if err := Delete("acme"); err != nil {
		t.Fatalf("Delete: %v", err)
	}

	if _, found := provider.GetProviderInfo("custom-acme"); found {
		t.Fatal("the deleted endpoint is still registered")
	}
	if _, found := provider.GetProviderInfo("custom-keep"); !found {
		t.Fatal("deleting one endpoint unregistered another")
	}

	instances, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if _, still := instances["acme"]; still {
		t.Fatal("the deleted endpoint is still in the file")
	}
	if _, kept := instances["keep"]; !kept {
		t.Fatal("deleting one endpoint removed another from the file")
	}

	settings, err := core.LoadGlobalSettings()
	if err != nil {
		t.Fatalf("LoadGlobalSettings: %v", err)
	}
	if _, stale := settings.Models.Hidden["custom-acme"]; stale {
		t.Fatal("hidden models for the deleted provider survived; a re-used id would inherit them")
	}
	if _, stale := settings.Models.Limits["custom-acme"]; stale {
		t.Fatal("model limits for the deleted provider survived; a re-used id would inherit them")
	}
	// Reaching past the one provider named is the failure that matters more:
	// preferences for everything else are curated and must be left alone.
	for _, name := range []string{"custom-keep", "openai"} {
		if len(settings.Models.Hidden[name]) != 1 {
			t.Fatalf("hidden models for %s = %v, want the one that was curated", name, settings.Models.Hidden[name])
		}
		if len(settings.Models.Limits[name]) != 1 {
			t.Fatalf("model limits for %s = %v, want the one that was curated", name, settings.Models.Limits[name])
		}
	}

	if ref, err := defaults.Load(); err != nil || ref.Provider != "" {
		t.Fatalf("default model = (%+v, %v), want cleared — it named the deleted provider", ref, err)
	}
	if ref, err := cheap.Load(); err != nil || ref.Provider != "custom-keep" {
		t.Fatalf("cheap model = (%+v, %v), want the untouched custom-keep", ref, err)
	}
}

func TestDeleteClearsACheapModelThatNamedIt(t *testing.T) {
	userpathstest.Isolate(t)
	twoInstances(t)

	defaults, err := core.NewDefaultModelStore()
	if err != nil {
		t.Fatalf("NewDefaultModelStore: %v", err)
	}
	cheap, err := core.NewCheapModelStore()
	if err != nil {
		t.Fatalf("NewCheapModelStore: %v", err)
	}
	// The mirror image of the case above: this time the deleted endpoint is the
	// cheap one, and the default names the survivor.
	if err := defaults.Save(core.ModelRef{Provider: "custom-keep", Model: "m2"}); err != nil {
		t.Fatalf("save default model: %v", err)
	}
	if err := cheap.Save(core.ModelRef{Provider: "custom-acme", Model: "m1"}); err != nil {
		t.Fatalf("save cheap model: %v", err)
	}

	if err := Delete("acme"); err != nil {
		t.Fatalf("Delete: %v", err)
	}

	if ref, err := cheap.Load(); err != nil || ref.Provider != "" {
		t.Fatalf("cheap model = (%+v, %v), want cleared — it named the deleted provider", ref, err)
	}
	if ref, err := defaults.Load(); err != nil || ref.Provider != "custom-keep" {
		t.Fatalf("default model = (%+v, %v), want the untouched custom-keep", ref, err)
	}
}

func TestDeleteRejectsAnUnknownID(t *testing.T) {
	userpathstest.Isolate(t)
	twoInstances(t)

	if err := Delete("never-existed"); err == nil {
		t.Fatal("Delete accepted an id that names no endpoint")
	}
	instances, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(instances) != 2 {
		t.Fatalf("instances = %v, want both left alone by a rejected delete", instances)
	}
	if _, found := provider.GetProviderInfo("custom-acme"); !found {
		t.Fatal("a rejected delete unregistered a provider anyway")
	}
}
