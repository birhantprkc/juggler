//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package mistral

import (
	"testing"

	provider "juggler/cmd/juggler/providers/registry"
)

// TestMistralContextWindow pins a couple of known windows and the unknown-model
// default.
func TestMistralContextWindow(t *testing.T) {
	if got := contextWindowCaps.Lookup("mistral-large-latest"); got != 262144 {
		t.Errorf("context window(mistral-large-latest) = %d, want 262144", got)
	}
	if got := contextWindowCaps.Lookup("mistral-vNext"); got != DefaultContextWindow {
		t.Errorf("context window(unknown) = %d, want default %d", got, DefaultContextWindow)
	}
}

// TestMistralMaxOutput checks a known and an unknown model both resolve to the
// flat default output cap.
func TestMistralMaxOutput(t *testing.T) {
	if got := maxOutputCaps.Lookup("mistral-large-latest"); got != DefaultMaxOutputTokens {
		t.Errorf("max output(mistral-large-latest) = %d, want %d", got, DefaultMaxOutputTokens)
	}
}

// TestMistralThinkingSpec guards that only Magistral models advertise a
// reasoning selector (low/medium/high), and every other model gets the zero
// spec so no reasoning param is sent.
func TestMistralThinkingSpec(t *testing.T) {
	reasoning := []string{"magistral-small-latest", "magistral-medium-latest"}
	for _, id := range reasoning {
		spec := thinkingSpec(id)
		if len(spec.Options()) != 3 {
			t.Errorf("thinkingSpec(%q) options = %d, want 3", id, len(spec.Options()))
		}
		if spec.Default != provider.ThinkingMedium {
			t.Errorf("thinkingSpec(%q) default = %q, want %q", id, spec.Default, provider.ThinkingMedium)
		}
	}
	nonReasoning := []string{"mistral-large-latest", "codestral-latest", "ministral-8b-latest"}
	for _, id := range nonReasoning {
		if opts := thinkingSpec(id).Options(); opts != nil {
			t.Errorf("thinkingSpec(%q) options = %v, want nil (no reasoning control)", id, opts)
		}
	}
}

// TestMistralInputModalities pins the vision classification: text-only models
// return nil, image-capable models return the canonical ["text","image"].
func TestMistralInputModalities(t *testing.T) {
	if got := inputModalities("codestral-latest"); got != nil {
		t.Errorf("inputModalities(codestral-latest) = %v, want nil", got)
	}
	got := inputModalities("mistral-medium-latest")
	if len(got) != 2 || got[0] != "text" || got[1] != "image" {
		t.Errorf("inputModalities(mistral-medium-latest) = %v, want [text image]", got)
	}
}
