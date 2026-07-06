//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package anthropic

import (
	"encoding/json"
	"strings"
	"testing"

	provider "juggler/cmd/juggler/providers/registry"
)

func TestConvertToolChoice(t *testing.T) {
	// nil → auto (unset): the model decides, the default for every normal turn.
	if _, ok := convertToolChoice(nil); ok {
		t.Error("nil ToolChoice must map to auto (ok=false)")
	}
	if _, ok := convertToolChoice(&provider.ToolChoice{Mode: provider.ToolChoiceAuto}); ok {
		t.Error("auto mode must map to unset (ok=false)")
	}

	// tool → {"type":"tool","name":...}
	tc, ok := convertToolChoice(&provider.ToolChoice{Mode: provider.ToolChoiceTool, Name: "return_result"})
	if !ok {
		t.Fatal("tool mode must be ok")
	}
	b, err := json.Marshal(tc)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	js := string(b)
	if !strings.Contains(js, `"type":"tool"`) || !strings.Contains(js, `"name":"return_result"`) {
		t.Errorf("forced-tool JSON = %s, want type:tool name:return_result", js)
	}

	// tool with empty name is invalid → unset (don't send a broken request).
	if _, ok := convertToolChoice(&provider.ToolChoice{Mode: provider.ToolChoiceTool}); ok {
		t.Error("tool mode without a name must map to unset")
	}

	// any → {"type":"any"}
	tc, ok = convertToolChoice(&provider.ToolChoice{Mode: provider.ToolChoiceAny})
	if !ok {
		t.Fatal("any mode must be ok")
	}
	if b, _ := json.Marshal(tc); !strings.Contains(string(b), `"type":"any"`) {
		t.Errorf("any JSON = %s", b)
	}

	// none → {"type":"none"}
	tc, ok = convertToolChoice(&provider.ToolChoice{Mode: provider.ToolChoiceNone})
	if !ok {
		t.Fatal("none mode must be ok")
	}
	if b, _ := json.Marshal(tc); !strings.Contains(string(b), `"type":"none"`) {
		t.Errorf("none JSON = %s", b)
	}
}
