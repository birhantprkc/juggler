//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gemini

import (
	"testing"

	provider "juggler/cmd/juggler/providers/registry"
)

func TestGeminiThinkingSpec(t *testing.T) {
	// 2.5 Pro: no "off", max 32768.
	pro := geminiThinkingSpecFor("models/gemini-2.5-pro")
	if _, ok := pro.budgetFor(provider.ThinkingOff); ok {
		t.Error("2.5 pro must not support off")
	}
	if b, ok := pro.budgetFor(provider.ThinkingMax); !ok || b != 32768 {
		t.Errorf("2.5 pro max = (%d,%v), want (32768,true)", b, ok)
	}

	// 2.5 Flash: off → budget 0.
	flash := geminiThinkingSpecFor("models/gemini-2.5-flash")
	if b, ok := flash.budgetFor(provider.ThinkingOff); !ok || b != 0 {
		t.Errorf("2.5 flash off = (%d,%v), want (0,true)", b, ok)
	}
	if b, ok := flash.budgetFor(provider.ThinkingMedium); !ok || b != 8192 {
		t.Errorf("2.5 flash medium = (%d,%v), want (8192,true)", b, ok)
	}

	// Non-2.5: no control.
	for _, m := range []string{"models/gemini-2.0-flash", "models/gemini-1.5-pro"} {
		spec := geminiThinkingSpecFor(m)
		if spec.budgets != nil || len(spec.levels) != 0 {
			t.Errorf("%s: expected no thinking control", m)
		}
		if _, ok := spec.budgetFor(provider.ThinkingHigh); ok {
			t.Errorf("%s: budgetFor must be false", m)
		}
	}

	// Absent / unknown level omits.
	if _, ok := flash.budgetFor(""); ok {
		t.Error("absent level must omit")
	}
	if _, ok := flash.budgetFor("garbage"); ok {
		t.Error("unknown level must omit")
	}
}
