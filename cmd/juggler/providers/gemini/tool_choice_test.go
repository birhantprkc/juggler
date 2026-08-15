//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gemini

import (
	"testing"

	"google.golang.org/genai"
	provider "juggler/cmd/juggler/providers/registry"
)

func TestGeminiFunctionCallingConfig(t *testing.T) {
	// nil / auto → AUTO, no name restriction (the normal case).
	if c := geminiFunctionCallingConfig(nil); c.Mode != genai.FunctionCallingConfigModeAuto || len(c.AllowedFunctionNames) != 0 {
		t.Errorf("nil → %+v, want AUTO with no allowed names", c)
	}

	// tool → ANY restricted to the forced function name.
	c := geminiFunctionCallingConfig(&provider.ToolChoice{Mode: provider.ToolChoiceTool, Name: "submit_answer"})
	if c.Mode != genai.FunctionCallingConfigModeAny {
		t.Errorf("tool mode = %v, want ANY", c.Mode)
	}
	if len(c.AllowedFunctionNames) != 1 || c.AllowedFunctionNames[0] != "submit_answer" {
		t.Errorf("tool mode allowed names = %v, want [submit_answer]", c.AllowedFunctionNames)
	}

	// tool without a name falls back to AUTO (never send a broken restriction).
	if c := geminiFunctionCallingConfig(&provider.ToolChoice{Mode: provider.ToolChoiceTool}); c.Mode != genai.FunctionCallingConfigModeAuto {
		t.Errorf("nameless tool mode = %v, want AUTO fallback", c.Mode)
	}

	// any → ANY (no name restriction); none → NONE.
	if c := geminiFunctionCallingConfig(&provider.ToolChoice{Mode: provider.ToolChoiceAny}); c.Mode != genai.FunctionCallingConfigModeAny || len(c.AllowedFunctionNames) != 0 {
		t.Errorf("any → %+v, want ANY with no names", c)
	}
	if c := geminiFunctionCallingConfig(&provider.ToolChoice{Mode: provider.ToolChoiceNone}); c.Mode != genai.FunctionCallingConfigModeNone {
		t.Errorf("none → %v, want NONE", c.Mode)
	}
}
