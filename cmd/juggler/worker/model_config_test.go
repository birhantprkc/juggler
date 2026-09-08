//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"reflect"
	"testing"

	"juggler/cmd/juggler/core"
)

// TestModelConfigIsModelRef pins the single shape a model selection has: the
// worker's ModelConfig, the LLM request the server decodes and the
// default/cheap/recent stores all name core.ModelRef, so a dial added to the
// quadruple reaches every layer from one declaration.
//
// What this refuses is a second struct carrying the same fields. Such a copy
// compiles, marshals byte-identically and passes every existing test — and then
// silently drops whichever dial was added to only one of the two.
func TestModelConfigIsModelRef(t *testing.T) {
	got, want := reflect.TypeOf(ModelConfig{}), reflect.TypeOf(core.ModelRef{})
	if got != want {
		t.Fatalf("worker.ModelConfig must BE core.ModelRef, got %v want %v", got, want)
	}
}
