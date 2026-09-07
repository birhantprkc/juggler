//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package customprovider

import (
	"fmt"

	"juggler/cmd/juggler/core"
	"juggler/internal/jlog"
)

// Apply replaces the whole instance set: it writes the new definitions,
// reconciles the registry with them, and forgets whatever the replacement
// removed. Every edit goes through here, so an endpoint dropped by a whole-set
// rewrite is cleaned up exactly as one deleted by name — which matters because
// the settings UI expresses a deletion as a rewrite without that entry.
func Apply(instances map[string]Instance) error {
	previous, err := Load()
	if err != nil {
		return err
	}
	if err := Save(instances); err != nil {
		return err
	}
	// Reconciling is what unregisters a removed endpoint: a turn already under
	// way keeps the client it built and runs to the end.
	if err := Sync(); err != nil {
		return err
	}
	for id := range previous {
		if _, kept := instances[id]; !kept {
			forgetProvider(RegisteredName(id))
		}
	}
	return nil
}

// Delete removes one endpoint and everything else keyed to the provider id it
// registered under. The API key is the exception: it stays in the credentials
// store, because deleting an endpoint should not throw away a secret the user
// may still want, and nothing reads a key for a provider that is not registered.
func Delete(id string) error {
	instances, err := Load()
	if err != nil {
		return err
	}
	if _, ok := instances[id]; !ok {
		return fmt.Errorf("no custom provider %q", id)
	}
	delete(instances, id)
	return Apply(instances)
}

// forgetProvider drops the preferences and selections that name a provider id.
//
// This is the only place a provider's curated preferences are destroyed, and it
// is deliberate. Everywhere else, settings and the model stores KEEP entries
// naming a provider they cannot see — a build without it, or one waiting on a
// credential, must not cost the user what they curated. A deletion is not that
// case: the endpoint is gone for good, and its id is free to be given to a
// different endpoint, which would otherwise inherit hidden models and token
// limits describing models it has never served.
//
// Failures are logged rather than returned. The endpoint itself is already
// gone, so there is nothing for the user to retry, and every reader of these
// stores already tolerates an entry naming a provider that is not registered.
func forgetProvider(name string) {
	if _, err := core.UpdateGlobalSettings(func(gs *core.GlobalSettings) bool {
		_, hidden := gs.Models.Hidden[name]
		_, limited := gs.Models.Limits[name]
		if !hidden && !limited {
			return false
		}
		delete(gs.Models.Hidden, name)
		delete(gs.Models.Limits, name)
		return true
	}); err != nil {
		jlog.Error("[CustomProvider] Could not drop %s's model preferences: %v", name, err)
	}

	if store, err := core.NewDefaultModelStore(); err != nil {
		jlog.Error("[CustomProvider] Could not open the default-model store: %v", err)
	} else {
		clearModelRefNaming(name, "default model", store.Load, store.Save)
	}
	if store, err := core.NewCheapModelStore(); err != nil {
		jlog.Error("[CustomProvider] Could not open the cheap-model store: %v", err)
	} else {
		clearModelRefNaming(name, "cheap model", store.Load, store.Save)
	}
}

// clearModelRefNaming clears a stored model selection when it names the given
// provider. Both stores read an empty ref as "forget the selection", which puts
// the choice back where it started rather than leaving a pick nothing can serve.
func clearModelRefNaming(providerName, label string, load func() (core.ModelRef, error), save func(core.ModelRef) error) {
	ref, err := load()
	if err != nil {
		jlog.Error("[CustomProvider] Could not read the %s selection: %v", label, err)
		return
	}
	if ref.Provider != providerName {
		return
	}
	if err := save(core.ModelRef{}); err != nil {
		jlog.Error("[CustomProvider] Could not clear the %s selection: %v", label, err)
	}
}
